import type { MemberId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import * as Members from "../persistence/Members.ts";
import * as MemberGitHub from "./MemberGitHub.ts";
import { harness, invite } from "./MemberGitHub.testkit.ts";
import * as TeamMembers from "./TeamMembers.ts";

const HOUR = 3_600_000;

/** Starts a link, lets the first poll find the approval, and returns what `wait` settles with. */
const link = (memberId: MemberId) =>
  Effect.gen(function* () {
    const service = yield* MemberGitHub.MemberGitHub;
    yield* service.start(memberId);
    const waiting = yield* Effect.forkChild(Effect.exit(service.wait(memberId)));
    yield* TestClock.adjust("5 seconds");
    return yield* Fiber.join(waiting);
  });

const linked = (memberId: MemberId) => link(memberId).pipe(Effect.flatten);

const memberGitHub = (memberId: MemberId) =>
  TeamMembers.TeamMembers.pipe(
    Effect.flatMap((team) => team.list),
    Effect.map((members) => members.find((member) => member.id === memberId)?.github),
  );

const storedUserId = (memberId: MemberId) =>
  Members.MemberRepository.pipe(
    Effect.flatMap((members) => members.getById(memberId)),
    Effect.map((record) => Option.getOrThrow(record).githubUserId),
  );

const setToken = (memberId: MemberId, token: string) =>
  MemberGitHub.MemberGitHub.pipe(
    Effect.flatMap((service) => service.setToken(memberId, Redacted.make(token))),
  );

const tokenOf = (memberId: MemberId) =>
  MemberGitHub.MemberGitHub.pipe(
    Effect.flatMap((service) => service.credentialFor(memberId)),
    Effect.map(Option.map((credential) => Redacted.value(credential.token))),
    Effect.map(Option.getOrUndefined),
  );

it.effect(
  "links the approved account: the token to the secret store, the account to the row",
  () => {
    const { layer, storedToken } = harness();
    return Effect.gen(function* () {
      const memberId = yield* invite("Bob");
      const member = yield* linked(memberId);

      expect(member.github).toEqual({ login: "octocat", connected: true, source: "app" });
      expect(JSON.stringify(member)).not.toContain("ghu_first");
      expect(yield* storedUserId(memberId)).toBe(42);
      expect(storedToken(memberId)).toMatchObject({
        accessToken: "ghu_first",
        refreshToken: "ghr_first",
      });
      expect(yield* tokenOf(memberId)).toBe("ghu_first");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("refuses a GitHub account another member already connected", () => {
  const { layer, storedToken, pastedToken } = harness();
  return Effect.gen(function* () {
    yield* linked(yield* invite("Alice"));
    const bob = yield* invite("Bob");

    const exit = yield* link(bob);
    expect(exit._tag === "Failure" && JSON.stringify(exit.cause)).toContain(
      "That GitHub account is connected to Alice.",
    );
    const pasted = yield* Effect.flip(setToken(bob, "ghp_bob"));
    expect(pasted.message).toContain("That GitHub account is connected to Alice.");
    expect(yield* memberGitHub(bob)).toBeUndefined();
    expect(storedToken(bob)).toBeUndefined();
    expect(pastedToken(bob)).toBeUndefined();
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a pasted token binds its account and serves as the credential without the app's client ID",
  () => {
    const { layer, github, pastedToken } = harness({ clientId: "" });
    return Effect.gen(function* () {
      const service = yield* MemberGitHub.MemberGitHub;
      const memberId = yield* invite("Bob");

      const member = yield* setToken(memberId, "ghp_pasted");
      expect(member.github).toEqual({ login: "octocat", connected: true, source: "token" });
      expect(JSON.stringify(member)).not.toContain("ghp_pasted");
      expect(pastedToken(memberId)).toBe("ghp_pasted");
      expect(yield* tokenOf(memberId)).toBe("ghp_pasted");

      // Revoked on GitHub: still bound to the token source, so the row offers a new one.
      github.userStatus = 401;
      yield* service.check(memberId);
      expect(yield* memberGitHub(memberId)).toEqual({
        login: "octocat",
        connected: false,
        source: "token",
      });
      expect(pastedToken(memberId)).toBeUndefined();
      expect(yield* tokenOf(memberId)).toBeUndefined();
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a refused token binds nothing", () => {
  const { layer, github, pastedToken } = harness();
  return Effect.gen(function* () {
    const memberId = yield* invite("Bob");
    github.userStatus = 401;

    const refused = yield* Effect.flip(setToken(memberId, "ghp_revoked"));
    expect(refused.message).toContain("GitHub refused that token.");
    expect(yield* memberGitHub(memberId)).toBeUndefined();
    expect(pastedToken(memberId)).toBeUndefined();
  }).pipe(Effect.provide(layer));
});

it.effect(
  "clearing a pasted token unbinds, and clearing with a device-flow session keeps it",
  () => {
    const { layer, storedToken, pastedToken } = harness();
    return Effect.gen(function* () {
      const service = yield* MemberGitHub.MemberGitHub;
      const memberId = yield* invite("Bob");

      // Each source replaces the other, so one member never holds both.
      yield* setToken(memberId, "ghp_pasted");
      yield* linked(memberId);
      expect(pastedToken(memberId)).toBeUndefined();
      expect((yield* service.clearToken(memberId)).github).toEqual({
        login: "octocat",
        connected: true,
        source: "app",
      });
      expect(yield* tokenOf(memberId)).toBe("ghu_first");

      yield* setToken(memberId, "ghp_pasted");
      expect(storedToken(memberId)).toBeUndefined();
      expect(yield* service.clearToken(memberId)).not.toHaveProperty("github");
      expect(yield* storedUserId(memberId)).toBeNull();
      expect(pastedToken(memberId)).toBeUndefined();
      expect(yield* tokenOf(memberId)).toBeUndefined();
    }).pipe(Effect.provide(layer));
  },
);

it.effect("refreshes a token near expiry and keeps the rotated pair", () => {
  const { layer, github, storedToken } = harness();
  return Effect.gen(function* () {
    const memberId = yield* invite("Bob");
    yield* linked(memberId);
    github.refresh = {
      body: {
        access_token: "ghu_second",
        expires_in: 8 * 3_600,
        refresh_token: "ghr_second",
        refresh_token_expires_in: 4_000 * 3_600,
      },
    };

    yield* TestClock.adjust(8 * HOUR - 10 * 60_000);
    expect(yield* tokenOf(memberId)).toBe("ghu_first");
    expect(github.refreshTokens).toEqual([]);

    yield* TestClock.adjust(6 * 60_000);
    expect(yield* tokenOf(memberId)).toBe("ghu_second");
    expect(github.refreshTokens).toEqual(["ghr_first"]);
    expect(storedToken(memberId)).toMatchObject({
      accessToken: "ghu_second",
      refreshToken: "ghr_second",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("a refused refresh leaves the member disconnected but still bound", () => {
  const { layer, github, storedToken } = harness();
  return Effect.gen(function* () {
    const memberId = yield* invite("Bob");
    yield* linked(memberId);
    github.refresh = { body: { error: "bad_refresh_token" } };

    yield* TestClock.adjust(8 * HOUR);
    expect(yield* tokenOf(memberId)).toBeUndefined();
    expect(yield* memberGitHub(memberId)).toEqual({
      login: "octocat",
      connected: false,
      source: "app",
    });
    expect(yield* storedUserId(memberId)).toBe(42);
    expect(storedToken(memberId)).toBeUndefined();
  }).pipe(Effect.provide(layer));
});

it.effect("check disconnects when GitHub refuses the token, and not when GitHub is down", () => {
  const { layer, github, storedToken } = harness();
  return Effect.gen(function* () {
    const service = yield* MemberGitHub.MemberGitHub;
    const memberId = yield* invite("Bob");
    yield* linked(memberId);

    github.userStatus = 502;
    yield* service.check(memberId);
    expect(yield* memberGitHub(memberId)).toEqual({
      login: "octocat",
      connected: true,
      source: "app",
    });

    github.userStatus = 401;
    yield* service.check(memberId);
    expect(yield* memberGitHub(memberId)).toEqual({
      login: "octocat",
      connected: false,
      source: "app",
    });
    expect(storedToken(memberId)).toBeUndefined();
  }).pipe(Effect.provide(layer));
});

it.effect("disconnect clears the token and the binding", () => {
  const { layer, storedToken } = harness();
  return Effect.gen(function* () {
    const service = yield* MemberGitHub.MemberGitHub;
    const memberId = yield* invite("Bob");
    yield* linked(memberId);

    expect(yield* service.disconnect(memberId)).not.toHaveProperty("github");
    expect(yield* storedUserId(memberId)).toBeNull();
    expect(storedToken(memberId)).toBeUndefined();
    expect(yield* tokenOf(memberId)).toBeUndefined();
  }).pipe(Effect.provide(layer));
});

it.effect("offers nothing without the app's client ID", () => {
  const { layer } = harness({ clientId: "" });
  return Effect.gen(function* () {
    const service = yield* MemberGitHub.MemberGitHub;
    expect(service.enabled).toBe(false);
    expect((yield* Effect.flip(service.start(yield* invite("Bob")))).reason).toBe("unsupported");
  }).pipe(Effect.provide(layer));
});
