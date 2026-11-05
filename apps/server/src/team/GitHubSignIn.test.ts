import { MEMBER_SCOPES, type MemberId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Members from "../persistence/Members.ts";
import * as GitHubSignIn from "./GitHubSignIn.ts";
import { harness, invite } from "./MemberGitHub.testkit.ts";
import * as TeamMembers from "./TeamMembers.ts";

/** Starts a sign-in, lets the first device-flow poll find GitHub's answer, then polls once. */
const signIn = Effect.gen(function* () {
  const service = yield* GitHubSignIn.GitHubSignIn;
  const started = yield* service.start();
  expect(yield* service.poll(started.attemptId)).toEqual({ status: "pending" });
  yield* TestClock.adjust("5 seconds");
  return { attemptId: started.attemptId, result: yield* service.poll(started.attemptId) };
});

const credentialOf = Effect.gen(function* () {
  const { result } = yield* signIn;
  if (result.status !== "complete") return yield* Effect.die("the sign-in is still pending");
  return result.credential;
});

const refusal = (effect: Effect.Effect<unknown, { readonly reason: string }, never>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.reason));

const bind = (memberId: MemberId, githubUserId: number, githubLogin: string) =>
  TeamMembers.TeamMembers.pipe(
    Effect.flatMap((team) =>
      // Bound, but the token stopped working: signing in must reconnect it.
      team.setGitHub(memberId, { githubUserId, githubLogin, githubConnectedAt: null }),
    ),
  );

const recordOf = (memberId: MemberId) =>
  Members.MemberRepository.pipe(
    Effect.flatMap((members) => members.getById(memberId)),
    Effect.map(Option.getOrThrow),
  );

const signInLinks = EnvironmentAuth.EnvironmentAuth.pipe(
  Effect.flatMap((auth) => auth.listPairingLinks({ excludeSubjects: [] })),
  Effect.map((links) => links.filter((link) => link.label === "GitHub sign-in")),
);

it.effect("signs a bound member in as themselves, with member scopes, and reconnects them", () => {
  const { layer, storedToken } = harness();
  return Effect.gen(function* () {
    const bob = yield* invite("Bob");
    yield* bind(bob, 42, "octocat");

    const credential = yield* credentialOf;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.createBrowserSession(credential, { deviceType: "unknown" });
    expect(session.response.permissions).toEqual(MEMBER_SCOPES);
    const verified = yield* (yield* SessionStore.SessionStore).verify(session.sessionToken);
    expect(verified.memberId).toBe(bob);

    expect((yield* recordOf(bob)).githubConnectedAt).not.toBeNull();
    expect(storedToken(bob)).toMatchObject({ accessToken: "ghu_first" });
  }).pipe(Effect.provide(layer));
});

it.effect("binds a pre-set username on first sign-in, and the id survives a rename", () => {
  const { layer, github } = harness();
  return Effect.gen(function* () {
    const carol = yield* invite("Carol", "OctoCat");

    yield* credentialOf;
    expect(yield* recordOf(carol)).toMatchObject({ githubUserId: 42, githubLogin: "octocat" });

    github.viewer = { id: 42, login: "octo-renamed" };
    yield* credentialOf;
    expect((yield* recordOf(carol)).githubLogin).toBe("octo-renamed");
  }).pipe(Effect.provide(layer));
});

it.effect("refuses an account that is not on the team, and one whose member was removed", () => {
  const { layer, storedToken } = harness();
  return Effect.gen(function* () {
    const team = yield* TeamMembers.TeamMembers;
    yield* invite("Dave", "dave-gh");
    const bob = yield* invite("Bob");

    expect(yield* refusal(signIn)).toBe("not-a-member");
    expect(storedToken(bob)).toBeUndefined();

    yield* bind(bob, 42, "octocat");
    yield* team.remove({ memberId: bob });
    expect(yield* refusal(signIn)).toBe("not-a-member");
    expect(storedToken(bob)).toBeUndefined();
    expect(yield* signInLinks).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("maps GitHub's refusals to their reasons", () => {
  const { layer, github } = harness();
  return Effect.gen(function* () {
    yield* invite("Bob", "octocat");
    for (const [error, reason] of [
      ["access_denied", "denied"],
      ["expired_token", "expired"],
    ] as const) {
      github.token = { body: { error } };
      expect(yield* refusal(signIn)).toBe(reason);
    }
  }).pipe(Effect.provide(layer));
});

it.effect("hands the sign-in code to one poll only", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const service = yield* GitHubSignIn.GitHubSignIn;
    yield* invite("Bob", "octocat");

    const { attemptId, result } = yield* signIn;
    expect(result.status).toBe("complete");
    expect(yield* refusal(service.poll(attemptId))).toBe("failed");
    expect(yield* signInLinks).toHaveLength(1);
  }).pipe(Effect.provide(layer));
});

it.effect("drops the oldest pending sign-in past the cap", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const service = yield* GitHubSignIn.GitHubSignIn;
    yield* invite("Bob", "octocat");

    const attempts = yield* Effect.forEach(Array.from({ length: 17 }), () => service.start());
    expect(yield* refusal(service.poll(attempts[0]!.attemptId))).toBe("failed");
    expect(yield* service.poll(attempts[1]!.attemptId)).toEqual({ status: "pending" });
  }).pipe(Effect.provide(layer));
});

it.effect("is unavailable, and absent from the descriptor, until configured and someone has GitHub", () => {
  const unconfigured = harness({ clientId: "" });
  const configured = harness();
  const descriptorKey = EnvironmentAuth.EnvironmentAuth.pipe(
    Effect.flatMap((auth) => auth.getDescriptor()),
    Effect.map((descriptor) => descriptor.githubSignIn),
  );
  const startRefusal = GitHubSignIn.GitHubSignIn.pipe(
    Effect.flatMap((service) => refusal(service.start())),
  );
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      yield* invite("Bob", "octocat");
      expect(yield* descriptorKey).toBeUndefined();
      expect(yield* startRefusal).toBe("unavailable");
    }).pipe(Effect.provide(unconfigured.layer));

    yield* Effect.gen(function* () {
      expect(yield* descriptorKey).toBeUndefined();
      expect(yield* startRefusal).toBe("unavailable");
      yield* invite("Bob", "octocat");
      expect(yield* descriptorKey).toBe(true);
    }).pipe(Effect.provide(configured.layer));
  });
});
