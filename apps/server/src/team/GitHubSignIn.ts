import {
  AuthGitHubSignInError,
  type AuthGitHubSignInFailure,
  type AuthGitHubSignInPollResult,
  type AuthGitHubSignInStarted,
  type SourceControlSignInError,
  teamRoleScopes,
} from "@t3tools/contracts";
import * as GitHubDeviceFlow from "@t3tools/source-control-github/server/deviceFlow";
import { APP_SIGN_IN } from "@t3tools/source-control-github/shared/definition";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { HttpClient } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import type * as Members from "../persistence/Members.ts";
import * as MemberGitHub from "./MemberGitHub.ts";
import * as TeamState from "./TeamState.ts";

/**
 * Signs a member in on a new device through the GitHub App device flow. A member is found only by
 * an account they proved, or a username an admin pre-set; the result is a one-time sign-in code,
 * the same thing an admin's sign-in link carries.
 */
export class GitHubSignIn extends Context.Service<
  GitHubSignIn,
  {
    readonly start: () => Effect.Effect<AuthGitHubSignInStarted, AuthGitHubSignInError>;
    /** Pending until the code is approved, then the sign-in code, which only the next poll gets. */
    readonly poll: (
      attemptId: string,
    ) => Effect.Effect<AuthGitHubSignInPollResult, AuthGitHubSignInError>;
  }
>()("t3/team/GitHubSignIn") {}

const HOST = APP_SIGN_IN.hosts[0] ?? "github.com";
// Bounds memory, not GitHub's device-code quota; anyone who can reach /pair can start one.
const MAX_PENDING = 16;
// The browser redeems it right away; it only has to outlive one round trip.
const CREDENTIAL_TTL = Duration.minutes(2);

interface Attempt {
  readonly expiresAt: number;
  readonly outcome: Deferred.Deferred<string, AuthGitHubSignInError>;
  readonly fiber: Fiber.Fiber<boolean>;
}

const refuse = (reason: AuthGitHubSignInFailure, message: string) =>
  new AuthGitHubSignInError({ reason, message });

const fromDeviceFlow = (error: SourceControlSignInError) =>
  refuse(
    error.reason === "expired" || error.reason === "denied" ? error.reason : "failed",
    error.detail,
  );

/** By the proven account id first, so a renamed login still signs in. */
const findMember = (
  members: Iterable<Members.MemberRecord>,
  viewer: GitHubDeviceFlow.GitHubViewer,
) => {
  const active = Array.from(members).filter((member) => member.removedAt === null);
  const login = viewer.login.toLowerCase();
  return (
    active.find((member) => member.githubUserId === viewer.id) ??
    active.find(
      (member) => member.githubUserId == null && member.githubLogin?.toLowerCase() === login,
    )
  );
};

const make = Effect.gen(function* () {
  const teamState = yield* TeamState.TeamState;
  const memberGitHub = yield* MemberGitHub.MemberGitHub;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const random = yield* SecureRandom.SecureRandom;
  const httpClient = yield* HttpClient.HttpClient;
  const clientId =
    (yield* HostProcess.Environment)[GitHubDeviceFlow.CLIENT_ID_VARIABLE]?.trim() ?? "";
  const flow = GitHubDeviceFlow.make({ httpClient, clientId });
  const scope = yield* Effect.scope;
  const attempts = yield* Ref.make<ReadonlyMap<string, Attempt>>(new Map());

  const signIn = Effect.fn("GitHubSignIn.signIn")(function* (code: GitHubDeviceFlow.DeviceCode) {
    const session = yield* flow.pollForToken(HOST, code).pipe(Effect.mapError(fromDeviceFlow));
    const viewer = yield* flow
      .viewer(HOST, session.accessToken)
      .pipe(
        Effect.mapError(() =>
          refuse("failed", "The server could not read your GitHub account. Start again."),
        ),
      );
    if (viewer === null) {
      return yield* refuse("failed", "GitHub refused the sign-in. Start again.");
    }
    yield* teamState.reload.pipe(Effect.ignore);
    const record = findMember((yield* Ref.get(teamState.members)).values(), viewer);
    if (record === undefined) {
      yield* Effect.logInfo("Refused a GitHub sign-in from an account that is not a member.", {
        login: viewer.login,
      });
      return yield* refuse(
        "not-a-member",
        "This GitHub account isn't on this server's team. Ask an admin to add it.",
      );
    }
    const member = yield* memberGitHub
      .connect(record.id, viewer, session)
      .pipe(
        Effect.mapError((error) =>
          refuse("failed", error._tag === "TeamError" ? error.message : error.detail),
        ),
      );
    const link = yield* environmentAuth
      .createPairingLink({
        memberId: member.id,
        scopes: teamRoleScopes(member.role),
        subject: "one-time-token",
        label: "GitHub sign-in",
        ttl: CREDENTIAL_TTL,
      })
      .pipe(
        Effect.catchTags({
          ManagedPolicyRefusedError: (error) => Effect.fail(refuse("failed", error.message)),
        }),
        Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (cause) =>
          Effect.logError("Could not create a GitHub sign-in code.", { cause }).pipe(
            Effect.andThen(Effect.fail(refuse("failed", "The server could not sign you in."))),
          ),
        ),
      );
    return link.credential;
  });

  const start: GitHubSignIn["Service"]["start"] = Effect.fn("GitHubSignIn.start")(function* () {
    if (clientId === "") {
      return yield* refuse("unavailable", "This server is not set up for GitHub sign-in.");
    }
    yield* teamState.reload.pipe(Effect.ignore);
    if (!TeamState.hasGitHubSignInMember(yield* Ref.get(teamState.members))) {
      return yield* refuse("unavailable", "No one on this server's team has added GitHub yet.");
    }
    const code = yield* flow.requestCode(HOST).pipe(Effect.mapError(fromDeviceFlow));
    const attemptId = Buffer.from(
      yield* random
        .randomBytes(32)
        .pipe(Effect.mapError(() => refuse("failed", "The server could not start the sign-in."))),
    ).toString("base64url");
    const outcome = yield* Deferred.make<string, AuthGitHubSignInError>();
    const fiber = yield* signIn(code).pipe(Deferred.into(outcome), Effect.forkIn(scope));
    const now = yield* Clock.currentTimeMillis;
    const dropped = yield* Ref.modify(attempts, (current) => {
      const next = new Map(current);
      const evicted: Array<Attempt> = [];
      for (const [id, attempt] of next) {
        if (attempt.expiresAt <= now) {
          evicted.push(attempt);
          next.delete(id);
        }
      }
      for (const [id, attempt] of next) {
        if (next.size < MAX_PENDING) break;
        evicted.push(attempt);
        next.delete(id);
      }
      next.set(attemptId, { expiresAt: code.expiresAt, outcome, fiber });
      return [evicted, next];
    });
    yield* Effect.forEach(dropped, (attempt) => Fiber.interrupt(attempt.fiber), { discard: true });
    return {
      attemptId,
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      expiresAt: code.expiresAt,
      interval: code.interval,
    } satisfies AuthGitHubSignInStarted;
  });

  const poll: GitHubSignIn["Service"]["poll"] = Effect.fn("GitHubSignIn.poll")(
    function* (attemptId) {
      const settled = yield* Ref.modify(
        attempts,
        (current): readonly [Attempt | "missing" | "pending", ReadonlyMap<string, Attempt>] => {
          const attempt = current.get(attemptId);
          if (attempt === undefined) return ["missing", current];
          if (!Deferred.isDoneUnsafe(attempt.outcome)) return ["pending", current];
          // Taking it out here is what hands the sign-in code to exactly one poll.
          const next = new Map(current);
          next.delete(attemptId);
          return [attempt, next];
        },
      );
      if (settled === "missing") {
        return yield* refuse(
          "failed",
          "This GitHub sign-in is no longer in progress. Start again.",
        );
      }
      if (settled === "pending") return { status: "pending" } as const;
      const credential = yield* Deferred.await(settled.outcome);
      return { status: "complete", credential } as const;
    },
  );

  return GitHubSignIn.of({ start, poll });
});

export const layer = Layer.effect(GitHubSignIn, make);
