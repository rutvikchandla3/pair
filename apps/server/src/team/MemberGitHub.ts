import {
  type MemberId,
  SourceControlProviderKind,
  SourceControlSignInError,
  type SourceControlSignInPrompt,
  TeamError,
  type TeamMember,
} from "@t3tools/contracts";
import * as GitHubDeviceFlow from "@t3tools/source-control-github/server/deviceFlow";
import { APP_SIGN_IN } from "@t3tools/source-control-github/shared/definition";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as TeamMembers from "./TeamMembers.ts";
import * as TeamState from "./TeamState.ts";

export interface MemberGitHubCredential {
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
}

/**
 * Each member's own GitHub connection, linked through the GitHub App device flow. The token stays
 * in the secret store; the member row holds only the proven account, which the team stream shows.
 */
export class MemberGitHub extends Context.Service<
  MemberGitHub,
  {
    /** Whether the server is configured with the GitHub App's client ID. */
    readonly enabled: boolean;
    /** Starts linking; a newer start for the same member replaces the older one. */
    readonly start: (
      memberId: MemberId,
    ) => Effect.Effect<SourceControlSignInPrompt, SourceControlSignInError>;
    /** Resolves once the member approved the code and the account is bound to them. */
    readonly wait: (
      memberId: MemberId,
    ) => Effect.Effect<TeamMember, SourceControlSignInError | TeamError>;
    readonly cancel: (memberId: MemberId) => Effect.Effect<void>;
    /** Binds an account the member proved through the device flow and stores its session. */
    readonly connect: (
      memberId: MemberId,
      viewer: GitHubDeviceFlow.GitHubViewer,
      session: GitHubDeviceFlow.GitHubAppSession,
    ) => Effect.Effect<TeamMember, SourceControlSignInError | TeamError>;
    /** Drops the token and the binding. GitHub keeps the grant until the member revokes it. */
    readonly disconnect: (memberId: MemberId) => Effect.Effect<TeamMember, TeamError>;
    /** The member's token, refreshed when due; none when not connected or no longer usable. */
    readonly credentialFor: (
      memberId: MemberId,
    ) => Effect.Effect<Option.Option<MemberGitHubCredential>>;
    /** Marks the member disconnected when GitHub refuses their token; a network error changes nothing. */
    readonly check: (memberId: MemberId) => Effect.Effect<void>;
  }
>()("t3/team/MemberGitHub") {}

const HOST = APP_SIGN_IN.hosts[0] ?? "github.com";
// Refresh ahead of expiry so a token never lapses between the check and a long request.
const REFRESH_MARGIN_MS = Duration.toMillis(Duration.minutes(5));

interface PendingLink {
  readonly deferred: Deferred.Deferred<TeamMember, SourceControlSignInError | TeamError>;
  readonly fiber: Fiber.Fiber<boolean>;
}

const linkError = (detail: string, cause?: unknown) =>
  new SourceControlSignInError({
    provider: SourceControlProviderKind.make("github"),
    host: HOST,
    reason: "failed",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const make = Effect.gen(function* () {
  const team = yield* TeamMembers.TeamMembers;
  const teamState = yield* TeamState.TeamState;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const clientId =
    (yield* HostProcess.Environment)[GitHubDeviceFlow.CLIENT_ID_VARIABLE]?.trim() ?? "";
  const enabled = clientId !== "";
  const flow = GitHubDeviceFlow.make({ httpClient, clientId });
  const scope = yield* Effect.scope;
  const pending = yield* Ref.make<ReadonlyMap<MemberId, PendingLink>>(new Map());
  const refreshLocks = new Map<MemberId, Semaphore.Semaphore>();

  const secretName = TeamMembers.memberGitHubSecretName;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const activeRecord = (memberId: MemberId) =>
    Ref.get(teamState.members).pipe(
      Effect.map((members) =>
        Option.fromNullishOr(members.get(memberId)).pipe(
          Option.filter((record) => record.removedAt === null),
        ),
      ),
    );

  const readSession = (memberId: MemberId) =>
    secrets.get(secretName(memberId)).pipe(
      Effect.map(
        Option.flatMap((bytes) => GitHubDeviceFlow.decodeSession(new TextDecoder().decode(bytes))),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Could not read a member's GitHub connection.", { memberId, cause }).pipe(
          Effect.as(Option.none<GitHubDeviceFlow.GitHubAppSession>()),
        ),
      ),
    );

  const writeSession = (memberId: MemberId, session: GitHubDeviceFlow.GitHubAppSession) =>
    secrets.set(
      secretName(memberId),
      new TextEncoder().encode(GitHubDeviceFlow.encodeSession(session)),
    );

  /** The token stopped working: keep the account so the row offers Reconnect. */
  const markDisconnected = Effect.fn("MemberGitHub.markDisconnected")(function* (
    memberId: MemberId,
  ) {
    yield* secrets.remove(secretName(memberId)).pipe(Effect.ignore);
    const record = yield* activeRecord(memberId);
    if (Option.isNone(record) || record.value.githubConnectedAt == null) return;
    yield* team
      .setGitHub(memberId, {
        githubUserId: record.value.githubUserId ?? null,
        githubLogin: record.value.githubLogin ?? null,
        githubConnectedAt: null,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not mark a member's GitHub disconnected.", { memberId, cause }),
        ),
      );
  });

  const connect: MemberGitHub["Service"]["connect"] = Effect.fn("MemberGitHub.connect")(function* (
    memberId,
    viewer,
    session,
  ) {
    // The CLI writes members directly, so check against fresh rows.
    yield* teamState.reload.pipe(Effect.ignore);
    for (const record of (yield* Ref.get(teamState.members)).values()) {
      if (
        record.id !== memberId &&
        record.removedAt === null &&
        record.githubUserId === viewer.id
      ) {
        return yield* linkError(`That GitHub account is connected to ${record.name}.`);
      }
    }
    yield* writeSession(memberId, session).pipe(
      Effect.mapError((cause) => linkError("The server could not save the connection.", cause)),
    );
    return yield* team
      .setGitHub(memberId, {
        githubUserId: viewer.id,
        githubLogin: viewer.login,
        githubConnectedAt: yield* nowIso,
      })
      .pipe(Effect.tapError(() => secrets.remove(secretName(memberId)).pipe(Effect.ignore)));
  });

  const link = Effect.fn("MemberGitHub.link")(function* (
    memberId: MemberId,
    session: GitHubDeviceFlow.GitHubAppSession,
  ) {
    const viewer = yield* flow
      .viewer(HOST, session.accessToken)
      .pipe(
        Effect.mapError((error) =>
          linkError("The server could not read your GitHub account. Start again.", error.cause),
        ),
      );
    if (viewer === null) return yield* linkError("GitHub refused the new connection. Start again.");
    return yield* connect(memberId, viewer, session);
  });

  const start: MemberGitHub["Service"]["start"] = Effect.fn("MemberGitHub.start")(
    function* (memberId) {
      if (!enabled) {
        return yield* GitHubDeviceFlow.signInError(
          HOST,
          "unsupported",
          "This server is not set up to connect GitHub.",
        );
      }
      const code = yield* flow.requestCode(HOST);
      const deferred = yield* Deferred.make<TeamMember, SourceControlSignInError | TeamError>();
      const fiber = yield* flow.pollForToken(HOST, code).pipe(
        Effect.flatMap((session) => link(memberId, session)),
        Deferred.into(deferred),
        Effect.forkIn(scope),
      );
      const previous = yield* Ref.modify(pending, (current) => [
        current.get(memberId),
        new Map(current).set(memberId, { deferred, fiber }),
      ]);
      if (previous !== undefined) {
        yield* Deferred.fail(previous.deferred, linkError("A newer connection replaced this one."));
        yield* Fiber.interrupt(previous.fiber);
      }
      return {
        userCode: code.userCode,
        verificationUri: code.verificationUri,
        expiresAt: code.expiresAt,
      } satisfies SourceControlSignInPrompt;
    },
  );

  const wait: MemberGitHub["Service"]["wait"] = Effect.fn("MemberGitHub.wait")(
    function* (memberId) {
      const current = (yield* Ref.get(pending)).get(memberId);
      if (current === undefined) {
        return yield* GitHubDeviceFlow.signInError(
          HOST,
          "not-started",
          "No GitHub connection is in progress. Start again.",
        );
      }
      return yield* Deferred.await(current.deferred);
    },
  );

  const cancel: MemberGitHub["Service"]["cancel"] = Effect.fn("MemberGitHub.cancel")(
    function* (memberId) {
      const current = (yield* Ref.get(pending)).get(memberId);
      if (current === undefined) return;
      yield* Deferred.fail(
        current.deferred,
        GitHubDeviceFlow.signInError(HOST, "cancelled", "The GitHub connection was cancelled."),
      );
      yield* Fiber.interrupt(current.fiber);
    },
  );

  const disconnect: MemberGitHub["Service"]["disconnect"] = Effect.fn("MemberGitHub.disconnect")(
    function* (memberId) {
      yield* cancel(memberId);
      yield* secrets.remove(secretName(memberId)).pipe(
        Effect.catch((cause) =>
          Effect.logError("Could not delete a member's GitHub connection.", { cause }).pipe(
            Effect.andThen(
              Effect.fail(
                new TeamError({
                  reason: "internal",
                  message: "Could not delete the GitHub connection.",
                }),
              ),
            ),
          ),
        ),
      );
      return yield* team.setGitHub(memberId, {
        githubUserId: null,
        githubLogin: null,
        githubConnectedAt: null,
      });
    },
  );

  const isFresh = (session: GitHubDeviceFlow.GitHubAppSession, now: number) =>
    session.accessTokenExpiresAt === null || now < session.accessTokenExpiresAt - REFRESH_MARGIN_MS;

  const refreshLock = (memberId: MemberId) => {
    const existing = refreshLocks.get(memberId);
    if (existing !== undefined) return existing;
    const lock = Semaphore.makeUnsafe(1);
    refreshLocks.set(memberId, lock);
    return lock;
  };

  const credentialFor: MemberGitHub["Service"]["credentialFor"] = Effect.fn(
    "MemberGitHub.credentialFor",
  )(function* (memberId) {
    if (!enabled) return Option.none();
    const record = yield* activeRecord(memberId);
    if (Option.isNone(record) || record.value.githubConnectedAt == null) return Option.none();
    const token = yield* refreshLock(memberId).withPermits(1)(
      Effect.gen(function* () {
        const session = yield* readSession(memberId);
        if (Option.isNone(session)) {
          // The row says connected but the token is gone, as when the file was deleted by hand.
          yield* markDisconnected(memberId);
          return Option.none<string>();
        }
        const now = yield* Clock.currentTimeMillis;
        if (isFresh(session.value, now)) return Option.some(session.value.accessToken);
        const stillValid =
          session.value.accessTokenExpiresAt !== null && now < session.value.accessTokenExpiresAt;
        const outcome = yield* flow.refresh(HOST, session.value).pipe(Effect.option);
        if (Option.isNone(outcome)) {
          // A refresh ahead of expiry that fails leaves the still-valid token in use.
          return stillValid ? Option.some(session.value.accessToken) : Option.none<string>();
        }
        if (outcome.value._tag === "revoked") {
          yield* markDisconnected(memberId);
          return Option.none<string>();
        }
        const next = outcome.value.session;
        // GitHub has retired the old pair, so an unsaved new one is still the only usable token.
        yield* writeSession(memberId, next).pipe(
          Effect.catch((cause) =>
            Effect.logError("Could not save a member's refreshed GitHub token.", {
              memberId,
              cause,
            }),
          ),
        );
        return Option.some(next.accessToken);
      }),
    );
    return Option.map(token, (value) => ({ host: HOST, token: Redacted.make(value) }));
  });

  const check: MemberGitHub["Service"]["check"] = Effect.fn("MemberGitHub.check")(
    function* (memberId) {
      const credential = yield* credentialFor(memberId);
      if (Option.isNone(credential)) return;
      const viewer = yield* flow
        .viewer(HOST, Redacted.value(credential.value.token))
        .pipe(Effect.option);
      if (Option.isSome(viewer) && viewer.value === null) yield* markDisconnected(memberId);
    },
  );

  return MemberGitHub.of({
    enabled,
    start,
    wait,
    cancel,
    connect,
    disconnect,
    credentialFor,
    check,
  });
});

export const layer = Layer.effect(MemberGitHub, make);
