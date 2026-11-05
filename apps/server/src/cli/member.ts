import {
  ADMIN_SCOPES,
  MemberRole,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  type TeamError,
  type TeamInviteInput,
  type TeamLinkResult,
  type TeamMember,
  type TeamRemoveInput,
  type TeamSignInLinkInput,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { buildPairingUrl } from "../startupAccess.ts";
import * as TeamMembers from "../team/TeamMembers.ts";
import { baseUrlFlag, jsonFlag, ttlFlag } from "./auth.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { findMember } from "./memberGrant.ts";
import { resolveDirectPairingBaseUrl } from "./pair.ts";

export class MemberServerRequestError extends Schema.TaggedError<MemberServerRequestError>()(
  "MemberServerRequestError",
  { origin: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The running server at ${this.origin} could not complete the request.`;
  }
}

/** The team operations the CLI uses, served by a running server or by this process. */
interface TeamOperations {
  readonly list: Effect.Effect<ReadonlyArray<TeamMember>, TeamError | MemberServerRequestError>;
  readonly invite: (
    input: TeamInviteInput,
  ) => Effect.Effect<TeamLinkResult, TeamError | MemberServerRequestError>;
  readonly signInLink: (
    input: TeamSignInLinkInput,
  ) => Effect.Effect<TeamLinkResult, TeamError | MemberServerRequestError>;
  readonly remove: (
    input: TeamRemoveInput,
  ) => Effect.Effect<TeamMember, TeamError | MemberServerRequestError>;
}

const LIVE_SERVER_PROBE_TIMEOUT = Duration.seconds(2);

const layerLiveProtocol = (socketUrl: string) =>
  Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Socket.layerWebSocket(socketUrl).pipe(
          Layer.provide(Socket.layerWebSocketConstructorGlobal),
        ),
        RpcSerialization.layerJson,
      ),
    ),
  );

/**
 * A running server holds open sockets and its own member snapshot, which only its own
 * writes update, so membership changes go through it while it answers.
 */
const connectLiveTeam = Effect.fn("cli.member.connectLiveTeam")(function* (statePath: string) {
  const state = yield* readPersistedServerRuntimeState(statePath);
  if (Option.isNone(state) || !isProcessAlive(state.value.pid)) {
    return Option.none<{ readonly team: TeamOperations; readonly pairingBaseUrl: string }>();
  }
  const origin = state.value.origin;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const issued = yield* Effect.acquireRelease(
    environmentAuth.issueSession({ scopes: ADMIN_SCOPES, label: "t3 member cli" }),
    (session) =>
      environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
  );
  const ticket = yield* environmentAuth.issueWebSocketTicket(
    { sessionId: issued.sessionId },
    { use: "rpc" },
  );
  const socketUrl = new URL("/ws", origin);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.searchParams.set("wsTicket", Redacted.value(ticket.ticket));
  socketUrl.searchParams.set(
    ORCHESTRATION_PROTOCOL_QUERY_PARAM,
    String(ORCHESTRATION_PROTOCOL_VERSION),
  );
  const protocol = yield* Layer.build(layerLiveProtocol(socketUrl.href));
  const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocol));

  const request = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((error) =>
        isTeamError(error) ? error : new MemberServerRequestError({ origin, cause: error }),
      ),
    );
  const team: TeamOperations = {
    list: request(client[WS_METHODS.teamSubscribe]({}).pipe(Stream.runHead)).pipe(
      Effect.flatMap((event) =>
        Option.isSome(event) && event.value._tag === "snapshot"
          ? Effect.succeed(event.value.members)
          : Effect.fail(
              new MemberServerRequestError({ origin, cause: "The team stream sent no snapshot." }),
            ),
      ),
    ),
    invite: (input) => request(client[WS_METHODS.teamInvite](input)),
    signInLink: (input) => request(client[WS_METHODS.teamSignInLink](input)),
    remove: (input) => request(client[WS_METHODS.teamRemove](input)),
  };

  const probe = yield* Effect.result(team.list.pipe(Effect.timeout(LIVE_SERVER_PROBE_TIMEOUT)));
  if (probe._tag === "Failure") {
    yield* Effect.logDebug("The running server did not answer; writing members directly.", {
      origin,
      cause: probe.failure,
    });
    return Option.none();
  }
  return Option.some({ team, pairingBaseUrl: resolveDirectPairingBaseUrl(state.value) });
});

const isTeamError = (error: { readonly _tag: string }): error is TeamError =>
  error._tag === "TeamError";

const runWithTeam = Effect.fn("cli.member.runWithTeam")(function* <A, E, R>(
  flags: CliAuthLocationFlags & { readonly json?: boolean },
  run: (team: TeamOperations, pairingBaseUrl: Option.Option<string>) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: flags.json === true });
  const minimumLogLevel = flags.json === true ? "Error" : config.logLevel;
  return yield* Effect.gen(function* () {
    const live = yield* connectLiveTeam(config.serverRuntimeStatePath);
    if (Option.isSome(live)) {
      return yield* run(live.value.team, Option.some(live.value.pairingBaseUrl));
    }
    return yield* TeamMembers.TeamMembers.pipe(
      Effect.flatMap((team) => run(team, Option.none())),
      Effect.provide(TeamMembers.layer.pipe(Layer.provide(ProcessRunner.layer))),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const resolveMemberId = (team: TeamOperations, identifier: string) =>
  team.list.pipe(
    Effect.flatMap((members) => findMember(members, identifier)),
    Effect.map((member) => member.id),
  );

const formatMemberTable = (members: ReadonlyArray<TeamMember>): string => {
  const rows = [
    ["ID", "NAME", "ROLE", "STATUS"],
    ...members.map((member) => [
      member.id,
      member.name,
      member.role,
      member.removedAt !== null ? "removed" : member.isOwner ? "owner" : "active",
    ]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return `${rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")}\n`;
};

const formatMemberLink = (
  heading: string,
  result: TeamLinkResult,
  options: { readonly json: boolean; readonly pairingBaseUrl: Option.Option<string> },
): string => {
  const { credential } = result;
  const pairUrl = Option.getOrUndefined(
    Option.map(options.pairingBaseUrl, (baseUrl) =>
      buildPairingUrl(baseUrl, credential.credential),
    ),
  );
  const expiresAt = DateTime.formatIso(credential.expiresAt);
  if (options.json) {
    return `${JSON.stringify(
      {
        member: result.member,
        id: credential.id,
        credential: credential.credential,
        ...(credential.label ? { label: credential.label } : {}),
        expiresAt,
        ...(pairUrl ? { pairUrl } : {}),
      },
      null,
      2,
    )}\n`;
  }
  return `${[
    heading,
    ...(pairUrl ? [`Pairing URL: ${pairUrl}`] : []),
    `Token: ${credential.credential}`,
    `Expires at: ${expiresAt}`,
  ].join("\n")}\n`;
};

const memberArgument = Argument.String("member").pipe(
  Argument.withDescription("Member id or name."),
);

const pairingBaseUrl = (
  explicit: Option.Option<URL>,
  live: Option.Option<string>,
): Option.Option<string> => (Option.isSome(explicit) ? Option.some(explicit.value.href) : live);

const listCommand = Command.make("list", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List the team's members, removed ones included."),
  Command.withHandler((flags) =>
    runWithTeam(flags, (team) =>
      team.list.pipe(
        Effect.flatMap((members) =>
          Console.log(
            flags.json ? `${JSON.stringify(members, null, 2)}\n` : formatMemberTable(members),
          ),
        ),
      ),
    ),
  ),
);

const inviteCommand = Command.make("invite", {
  ...authLocationFlags,
  name: Argument.String("name").pipe(Argument.withDescription("The new member's name.")),
  role: Flag.Literals("role", MemberRole.literals).pipe(
    Flag.withDescription("The member's role. Members cannot manage settings, access or providers."),
    Flag.withDefault("member" as const),
  ),
  gitEmail: Flag.String("git-email").pipe(
    Flag.withDescription("The email that authors the member's commits."),
    Flag.optional,
  ),
  ttl: ttlFlag,
  baseUrl: baseUrlFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Add a team member and print the one-time link that signs them in."),
  Command.withHandler((flags) =>
    runWithTeam(flags, (team, livePairingBaseUrl) =>
      Effect.gen(function* () {
        const gitEmail = Option.getOrUndefined(flags.gitEmail)?.trim();
        const result = yield* team.invite({
          name: flags.name.trim(),
          role: flags.role,
          ...(gitEmail ? { gitEmail } : {}),
          ...(Option.isSome(flags.ttl)
            ? { ttlMs: Math.max(1, Math.round(Duration.toMillis(flags.ttl.value))) }
            : {}),
        });
        yield* Console.log(
          formatMemberLink(
            `Invited ${result.member.name} as ${flags.role} ${result.member.id}.`,
            result,
            {
              json: flags.json,
              pairingBaseUrl: pairingBaseUrl(flags.baseUrl, livePairingBaseUrl),
            },
          ),
        );
      }),
    ),
  ),
);

const signInLinkCommand = Command.make("signin-link", {
  ...authLocationFlags,
  member: memberArgument,
  baseUrl: baseUrlFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Print a one-time link that signs an existing member in on a device."),
  Command.withHandler((flags) =>
    runWithTeam(flags, (team, livePairingBaseUrl) =>
      Effect.gen(function* () {
        const memberId = yield* resolveMemberId(team, flags.member);
        const result = yield* team.signInLink({ memberId });
        yield* Console.log(
          formatMemberLink(`Sign-in link for ${result.member.name} ${result.member.id}.`, result, {
            json: flags.json,
            pairingBaseUrl: pairingBaseUrl(flags.baseUrl, livePairingBaseUrl),
          }),
        );
      }),
    ),
  ),
);

const removeCommand = Command.make("remove", {
  ...authLocationFlags,
  member: memberArgument,
}).pipe(
  Command.withDescription("Remove a member and sign out all of their devices."),
  Command.withHandler((flags) =>
    runWithTeam(flags, (team) =>
      Effect.gen(function* () {
        const memberId = yield* resolveMemberId(team, flags.member);
        const removed = yield* team.remove({ memberId });
        yield* Console.log(`Removed ${removed.name} ${removed.id}.\n`);
      }),
    ),
  ),
);

export const memberCommand = Command.make("member").pipe(
  Command.withDescription("Manage the team members who can use this server."),
  Command.withSubcommands([listCommand, inviteCommand, signInLinkCommand, removeCommand]),
);
