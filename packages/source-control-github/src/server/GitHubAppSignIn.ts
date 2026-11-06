import {
  SourceControlProviderKind,
  SourceControlSignInError,
  type SourceControlSignInPrompt,
} from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as GitHubClient from "../shared/definition.ts";
import * as GitHubDeviceFlow from "./GitHubDeviceFlow.ts";

export { CLIENT_ID_VARIABLE } from "./GitHubDeviceFlow.ts";

const KIND = SourceControlProviderKind.make("github");
// Refresh ahead of expiry so a token never lapses between the check and a long request.
const REFRESH_MARGIN_MS = Duration.toMillis(Duration.minutes(5));

type GitHubAppSession = GitHubDeviceFlow.GitHubAppSession;
const { decodeSession, encodeSession, signInError } = GitHubDeviceFlow;

export class GitHubAppSessionError extends Schema.TaggedError<GitHubAppSessionError>()(
  "GitHubAppSessionError",
  { host: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not refresh the ${GitHubClient.APP_SIGN_IN.appName} sign-in for ${this.host}. Check the server's connection to GitHub, or sign in again in Settings → Source Control.`;
  }
}

export class GitHubAppSignIn extends Context.Service<
  GitHubAppSignIn,
  {
    /** Whether the server is configured with the app's client ID. */
    readonly enabled: boolean;
    /** The signed-in access token for `host`, refreshed when due; none when not signed in. */
    readonly token: (host: string) => Effect.Effect<Option.Option<string>, GitHubAppSessionError>;
    /** Refreshes on the next `token` when `rejected` is the token GitHub just refused. */
    readonly invalidate: (host: string, rejected: string) => Effect.Effect<void>;
    readonly start: (
      host: string,
    ) => Effect.Effect<SourceControlSignInPrompt, SourceControlSignInError>;
    /** Resolves once the sign-in `start` began has saved a session. */
    readonly wait: (host: string) => Effect.Effect<void, SourceControlSignInError>;
    readonly cancel: (host: string) => Effect.Effect<void>;
  }
>()("@t3tools/source-control-github/server/GitHubAppSignIn") {}

interface PendingSignIn {
  readonly deferred: Deferred.Deferred<void, SourceControlSignInError>;
  readonly fiber: Fiber.Fiber<boolean>;
}

/** @public */
export const make = Effect.gen(function* () {
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const httpClient = yield* HttpClient.HttpClient;
  const clientId =
    (yield* HostProcess.Environment)[GitHubDeviceFlow.CLIENT_ID_VARIABLE]?.trim() ?? "";
  const enabled = clientId !== "";
  const flow = GitHubDeviceFlow.make({ httpClient, clientId });
  const scope = yield* Effect.scope;
  const refreshLock = yield* Semaphore.make(1);
  const refused = yield* Ref.make<ReadonlySet<string>>(new Set());
  const pending = yield* Ref.make<ReadonlyMap<string, PendingSignIn>>(new Map());

  const isAppHost = (host: string) =>
    enabled && GitHubClient.APP_SIGN_IN.hosts.includes(host.trim().toLowerCase());

  const readSignIns = sourceControlHost.settings.get.pipe(
    Effect.map(
      (settings) =>
        readSourceControlHostSettings(
          GitHubClient.settings,
          settings.sourceControlHosts[GitHubClient.definition.kind],
        ).signIns,
    ),
    Effect.orElseSucceed((): Readonly<Record<string, string>> => ({})),
  );

  const readSession = (host: string) =>
    readSignIns.pipe(Effect.map((signIns) => decodeSession(signIns[host] ?? "")));

  const writeSession = Effect.fn("GitHubAppSignIn.writeSession")(function* (
    host: string,
    session: GitHubAppSession | null,
  ) {
    const signIns = { ...(yield* readSignIns) };
    if (session === null) delete signIns[host];
    else signIns[host] = encodeSession(session);
    yield* sourceControlHost.settings.update({
      sourceControlHosts: { [GitHubClient.definition.kind]: { signIns } },
    });
  });

  /**
   * Writes `next` only while the stored session is still the one a refresh started from, so a
   * sign-out or a newer sign-in during the request is not undone.
   */
  const replaceSession = Effect.fn("GitHubAppSignIn.replaceSession")(function* (
    host: string,
    from: GitHubAppSession,
    next: GitHubAppSession | null,
  ) {
    const current = yield* readSession(host);
    if (Option.isNone(current) || current.value.accessToken !== from.accessToken) return false;
    yield* writeSession(host, next);
    return true;
  });

  const refresh = Effect.fn("GitHubAppSignIn.refresh")(function* (
    host: string,
    session: GitHubAppSession,
  ) {
    const outcome = yield* flow
      .refresh(host, session)
      .pipe(Effect.mapError((error) => new GitHubAppSessionError({ host, cause: error.cause })));
    if (outcome._tag === "revoked") {
      yield* replaceSession(host, session, null).pipe(Effect.ignore);
      return Option.none<string>();
    }
    const next = outcome.session;
    // GitHub has retired the old pair, so an unsaved new one is still the only usable token.
    const saved = yield* replaceSession(host, session, next).pipe(
      Effect.retry({ times: 2, schedule: Schedule.spaced(Duration.millis(250)) }),
      Effect.catch((cause) =>
        Effect.logError("Could not save the refreshed app sign-in; using it unsaved.", {
          host,
          cause,
        }).pipe(Effect.as(true)),
      ),
    );
    if (saved) return Option.some(next.accessToken);
    // Signed out or signed in again meanwhile: serve whatever is stored now.
    return Option.map(yield* readSession(host), (current) => current.accessToken);
  });

  const isFresh = (session: GitHubAppSession, now: number) =>
    session.accessTokenExpiresAt === null || now < session.accessTokenExpiresAt - REFRESH_MARGIN_MS;

  const token: GitHubAppSignIn["Service"]["token"] = Effect.fn("GitHubAppSignIn.token")(
    function* (rawHost) {
      const host = rawHost.trim().toLowerCase();
      if (!isAppHost(host)) return Option.none();
      const session = yield* readSession(host);
      if (Option.isNone(session)) return Option.none();
      const now = yield* Clock.currentTimeMillis;
      if (
        isFresh(session.value, now) &&
        !(yield* Ref.get(refused)).has(session.value.accessToken)
      ) {
        return Option.some(session.value.accessToken);
      }
      return yield* refreshLock.withPermits(1)(
        Effect.gen(function* () {
          // Another request may have refreshed while this one queued.
          const current = yield* readSession(host);
          if (Option.isNone(current)) return Option.none<string>();
          const refusedTokens = yield* Ref.get(refused);
          const now = yield* Clock.currentTimeMillis;
          if (isFresh(current.value, now) && !refusedTokens.has(current.value.accessToken)) {
            return Option.some(current.value.accessToken);
          }
          const usable = Option.some(current.value.accessToken).pipe(
            Option.filter(
              (accessToken) =>
                !refusedTokens.has(accessToken) &&
                (current.value.accessTokenExpiresAt === null ||
                  now < current.value.accessTokenExpiresAt),
            ),
          );
          // A refresh ahead of expiry that fails leaves the still-valid token in use.
          return yield* refresh(host, current.value).pipe(
            Effect.catchTags({
              GitHubAppSessionError: (error) =>
                Option.isSome(usable) ? Effect.succeed(usable) : Effect.fail(error),
            }),
          );
        }),
      );
    },
  );

  const invalidate: GitHubAppSignIn["Service"]["invalidate"] = Effect.fn(
    "GitHubAppSignIn.invalidate",
  )(function* (rawHost, rejected) {
    const session = yield* readSession(rawHost.trim().toLowerCase());
    // A refused fallback token says nothing about the app session.
    if (Option.isNone(session) || session.value.accessToken !== rejected) return;
    yield* Ref.update(refused, (current) => new Set([...current, rejected]));
  });

  const poll = Effect.fn("GitHubAppSignIn.poll")(function* (
    host: string,
    code: GitHubDeviceFlow.DeviceCode,
  ) {
    const session = yield* flow.pollForToken(host, code);
    return yield* writeSession(host, session).pipe(
      Effect.mapError(
        (cause) =>
          new SourceControlSignInError({
            provider: KIND,
            host,
            reason: "failed",
            detail: "The server could not save the sign-in.",
            cause,
          }),
      ),
    );
  });

  const start: GitHubAppSignIn["Service"]["start"] = Effect.fn("GitHubAppSignIn.start")(
    function* (rawHost) {
      const host = rawHost.trim().toLowerCase();
      if (!enabled) {
        return yield* signInError(
          host,
          "unsupported",
          `This server is not set up to sign in with ${GitHubClient.APP_SIGN_IN.appName}.`,
        );
      }
      if (!isAppHost(host)) {
        return yield* signInError(
          host,
          "unsupported",
          `${GitHubClient.APP_SIGN_IN.appName} only signs in to ${GitHubClient.APP_SIGN_IN.hosts.join(", ")}. Use a token or the GitHub CLI for ${host}.`,
        );
      }
      const code = yield* flow.requestCode(host);
      const deferred = yield* Deferred.make<void, SourceControlSignInError>();
      const fiber = yield* poll(host, code).pipe(
        Effect.tap(() => Ref.set(refused, new Set())),
        Deferred.into(deferred),
        Effect.forkIn(scope),
      );
      const previous = yield* Ref.modify(pending, (current) => [
        current.get(host),
        new Map(current).set(host, { deferred, fiber }),
      ]);
      if (previous !== undefined) {
        yield* Deferred.fail(
          previous.deferred,
          signInError(host, "failed", "A newer sign-in replaced this one."),
        );
        yield* Fiber.interrupt(previous.fiber);
      }
      return {
        userCode: code.userCode,
        verificationUri: code.verificationUri,
        expiresAt: code.expiresAt,
      } satisfies SourceControlSignInPrompt;
    },
  );

  const wait: GitHubAppSignIn["Service"]["wait"] = Effect.fn("GitHubAppSignIn.wait")(
    function* (rawHost) {
      const host = rawHost.trim().toLowerCase();
      const current = (yield* Ref.get(pending)).get(host);
      if (current === undefined) {
        return yield* signInError(host, "not-started", "No sign-in is in progress. Start again.");
      }
      return yield* Deferred.await(current.deferred);
    },
  );

  const cancel: GitHubAppSignIn["Service"]["cancel"] = Effect.fn("GitHubAppSignIn.cancel")(
    function* (rawHost) {
      const host = rawHost.trim().toLowerCase();
      const current = (yield* Ref.get(pending)).get(host);
      if (current === undefined) return;
      yield* Deferred.fail(
        current.deferred,
        signInError(host, "cancelled", "The sign-in was cancelled."),
      );
      yield* Fiber.interrupt(current.fiber);
    },
  );

  return GitHubAppSignIn.of({ enabled, token, invalidate, start, wait, cancel });
});

export const layer = Layer.effect(GitHubAppSignIn, make);
