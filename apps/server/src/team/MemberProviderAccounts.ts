import {
  type MemberId,
  type MemberProviderAccountDriver,
  type MemberProviderAccountMutation,
  type MemberProviderAccountResult,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironment,
  isProviderDriverKind,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettingsError,
  TeamError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TeamMembers from "./TeamMembers.ts";
import * as TeamState from "./TeamState.ts";

export class MemberProviderAccounts extends Context.Service<
  MemberProviderAccounts,
  {
    /** Creates, edits or removes the member's own account; the server picks its id and home. */
    readonly mutate: (
      memberId: MemberId,
      input: MemberProviderAccountMutation,
    ) => Effect.Effect<MemberProviderAccountResult, TeamError>;
    /** Signs out, wipes and disables every account whose owner has left the team. */
    readonly retireOrphans: Effect.Effect<void>;
  }
>()("t3/team/MemberProviderAccounts") {}

const TOKEN_VARIABLES = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
const DRIVER_LABELS: Record<MemberProviderAccountDriver, string> = {
  claudeAgent: "Claude",
  codex: "ChatGPT",
};
const ID_ATTEMPTS = 5;

const memberSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 24)
    .replace(/^-+|-+$/g, "") || "member";

// `claude setup-token` issues `sk-ant-oat…`; the CLI reads those only from the OAuth variable.
const tokenEnvironment = (token: string): ProviderInstanceEnvironment => [
  {
    name: token.startsWith("sk-ant-oat") ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY",
    value: token,
    sensitive: true,
  },
];

const withoutToken = (environment: ProviderInstanceEnvironment | undefined) =>
  (environment ?? []).filter(
    (variable) => !(TOKEN_VARIABLES as ReadonlyArray<string>).includes(variable.name),
  );

const forbidden = (message: string) => new TeamError({ reason: "forbidden", message });

const toTeamError = (message: string) => (error: ServerSettingsError) =>
  error.operation === "write-managed-setting" || error.operation === "use-disallowed-provider"
    ? Effect.fail(new TeamError({ reason: "policy-refused", message: error.message }))
    : Effect.logError(message, { cause: error }).pipe(
        Effect.andThen(Effect.fail(new TeamError({ reason: "internal", message }))),
      );

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const teamState = yield* TeamState.TeamState;
  const teamMembers = yield* TeamMembers.TeamMembers;
  const providerAuth = yield* ProviderAuthService.ProviderAuthService;
  const random = yield* SecureRandom.SecureRandom;
  const writes = yield* Semaphore.make(1);

  const providersRoot = path.resolve(config.stateDir, "providers");
  const accountDirectory = (driver: string, instanceId: ProviderInstanceId) =>
    path.join(providersRoot, driver, instanceId);

  // Only ever a directory this service allocates; never a path read from the instance's config.
  const wipeHome = Effect.fnUntraced(function* (instanceId: ProviderInstanceId, driver: string) {
    const directory = path.resolve(accountDirectory(driver, instanceId));
    if (!isProviderDriverKind(driver) || !directory.startsWith(providersRoot + path.sep)) {
      return yield* Effect.logWarning("Refused to wipe a provider home outside the state dir.", {
        directory,
      });
    }
    yield* fs.remove(directory, { recursive: true, force: true });
  });

  const readSettings = settings.getSettings.pipe(
    Effect.catch(toTeamError("Could not read the provider accounts.")),
  );

  const ownedInstance = Effect.fnUntraced(function* (
    memberId: MemberId,
    instanceId: ProviderInstanceId,
  ) {
    const instance = (yield* readSettings).providerInstances[instanceId];
    if (instance === undefined) {
      return yield* new TeamError({ reason: "not-found", message: "That account does not exist." });
    }
    if (instance.ownerMemberId !== memberId) {
      return yield* forbidden("That account belongs to someone else.");
    }
    return instance;
  });

  const revoke = (instanceId: ProviderInstanceId) => providerAuth.revoke({ instanceId });

  const create = Effect.fnUntraced(function* (
    memberId: MemberId,
    input: Extract<MemberProviderAccountMutation, { operation: "create" }>,
  ) {
    if (!(yield* teamState.isTeamMode)) {
      return yield* forbidden("Accounts of your own need a team. Add this one in Settings.");
    }
    if (input.token !== undefined && input.driver !== "claudeAgent") {
      return yield* forbidden("Only a Claude account takes a token.");
    }
    const member = (yield* Ref.get(teamState.members)).get(memberId);
    if (member === undefined || member.removedAt !== null) {
      return yield* new TeamError({ reason: "not-a-member", message: "You left this team." });
    }
    const existing = (yield* readSettings).providerInstances;
    let instanceId: ProviderInstanceId | undefined;
    for (let attempt = 0; attempt < ID_ATTEMPTS && instanceId === undefined; attempt += 1) {
      const suffix = (yield* random.uuidV4().pipe(Effect.orDie)).slice(0, 4);
      const candidate = ProviderInstanceId.make(
        `${input.driver}-${memberSlug(member.name)}-${suffix}`,
      );
      if (existing[candidate] === undefined) instanceId = candidate;
    }
    if (instanceId === undefined) {
      return yield* new TeamError({ reason: "internal", message: "Could not name the account." });
    }

    const home = path.join(accountDirectory(input.driver, instanceId), "home");
    if (input.driver === "claudeAgent") {
      yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 }).pipe(
        Effect.andThen(fs.chmod(home, 0o700)),
        Effect.catch((cause) =>
          Effect.logError("Could not create the account's home.", { cause }).pipe(
            Effect.andThen(
              Effect.fail(
                new TeamError({ reason: "internal", message: "Could not create the account." }),
              ),
            ),
          ),
        ),
      );
    }
    const instance: ProviderInstanceConfig = {
      driver: ProviderDriverKind.make(input.driver),
      displayName: input.displayName ?? `${member.name}'s ${DRIVER_LABELS[input.driver]}`,
      enabled: true,
      ...(input.token === undefined ? {} : { environment: tokenEnvironment(input.token) }),
      config: input.driver === "claudeAgent" ? { homePath: home } : { setupMode: "managed" },
      ownerMemberId: memberId,
    };
    yield* settings.updateProviderInstance({ operation: "create", instanceId, instance }).pipe(
      Effect.catch(toTeamError("Could not save the account.")),
      Effect.tapError(() => wipeHome(instanceId, input.driver).pipe(Effect.ignore)),
    );
    return { instanceId };
  });

  const update = Effect.fnUntraced(function* (
    memberId: MemberId,
    input: Extract<MemberProviderAccountMutation, { operation: "update" }>,
  ) {
    const instance = yield* ownedInstance(memberId, input.instanceId);
    if (input.token != null && instance.driver !== "claudeAgent") {
      return yield* forbidden("Only a Claude account takes a token.");
    }
    const environment =
      input.token === undefined
        ? instance.environment
        : [
            ...withoutToken(instance.environment),
            ...(input.token === null ? [] : tokenEnvironment(input.token)),
          ];
    const { environment: _environment, ...rest } = instance;
    yield* settings
      .updateProviderInstance({
        operation: "upsert",
        instanceId: input.instanceId,
        instance: {
          ...rest,
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          ...(environment === undefined || environment.length === 0 ? {} : { environment }),
        },
      })
      .pipe(Effect.catch(toTeamError("Could not save the account.")));
    return { instanceId: input.instanceId };
  });

  const remove = Effect.fnUntraced(function* (
    memberId: MemberId,
    input: Extract<MemberProviderAccountMutation, { operation: "remove" }>,
  ) {
    const instance = yield* ownedInstance(memberId, input.instanceId);
    yield* revoke(input.instanceId).pipe(
      Effect.catch((cause) =>
        Effect.logError("Could not sign the account out.", { cause }).pipe(
          Effect.andThen(
            Effect.fail(
              new TeamError({ reason: "internal", message: "Could not sign the account out." }),
            ),
          ),
        ),
      ),
    );
    yield* wipeHome(input.instanceId, instance.driver).pipe(
      Effect.catch((cause) =>
        Effect.logError("Could not wipe the account's home.", { cause }).pipe(
          Effect.andThen(
            Effect.fail(
              new TeamError({ reason: "internal", message: "Could not remove the account." }),
            ),
          ),
        ),
      ),
    );
    yield* settings
      .updateProviderInstance({ operation: "remove", instanceId: input.instanceId })
      .pipe(Effect.catch(toTeamError("Could not remove the account.")));
    return { instanceId: input.instanceId };
  });

  // The label and owner stay, so old threads still name the account and keep refusing new turns.
  const retireOrphans = Effect.gen(function* () {
    yield* teamState.reload;
    const active = TeamState.activeMemberIds(yield* Ref.get(teamState.members));
    const current = yield* settings.getSettings;
    for (const [key, instance] of Object.entries(current.providerInstances)) {
      const instanceId = ProviderInstanceId.make(key);
      const owner = instance.ownerMemberId;
      if (owner === undefined || active.has(owner)) continue;
      const holdsSecret = (instance.environment ?? []).some((variable) => variable.sensitive);
      if (instance.enabled === false && !holdsSecret) continue;
      yield* revoke(instanceId).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not sign a retired account out.", { instanceId, cause }),
        ),
      );
      yield* wipeHome(instanceId, instance.driver).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not wipe a retired account's home.", { instanceId, cause }),
        ),
      );
      const environment = (instance.environment ?? []).filter((variable) => !variable.sensitive);
      const { environment: _environment, ...rest } = instance;
      yield* settings.updateProviderInstance(
        {
          operation: "upsert",
          instanceId,
          instance: {
            ...rest,
            enabled: false,
            ...(environment.length === 0 ? {} : { environment }),
          },
        },
        undefined,
        { activeMemberIds: active },
      );
    }
  }).pipe(
    writes.withPermit,
    Effect.catch((cause) => Effect.logError("Could not retire provider accounts.", { cause })),
    Effect.withSpan("MemberProviderAccounts.retireOrphans"),
  );

  yield* settings.ready.pipe(
    Effect.andThen(
      teamMembers.streamChanges.pipe(
        Stream.filter((event) => event._tag === "snapshot" || event.member.removedAt !== null),
        Stream.runForEach(() => retireOrphans),
      ),
    ),
    Effect.catchCause((cause) => Effect.logError("Stopped retiring provider accounts.", { cause })),
    Effect.forkScoped,
  );

  return MemberProviderAccounts.of({
    mutate: Effect.fn("MemberProviderAccounts.mutate")(function* (memberId, input) {
      return yield* writes.withPermit(
        input.operation === "create"
          ? create(memberId, input)
          : input.operation === "update"
            ? update(memberId, input)
            : remove(memberId, input),
      );
    }),
    retireOrphans,
  });
});

export const layer = Layer.effect(MemberProviderAccounts, make);
