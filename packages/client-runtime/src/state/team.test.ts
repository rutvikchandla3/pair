import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MemberId,
  ThreadId,
  type AuthSessionState,
  type TeamMember,
  type TeamStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  EMPTY_TEAM_MEMBERS,
  applyTeamStreamEvent,
  canMemberAssignThread,
  canMemberDeleteThread,
  createTeamEnvironmentAtoms,
  isTeamModeMembers,
  memberRemovalInput,
  memberRemovalPrompt,
  memberRemovalTargets,
  otherMessageAuthorId,
  resolveTeamThreadSection,
  sortTeamThreadsByActivity,
  type TeamViewer,
} from "./team.ts";

const streamed = vi.hoisted(() => ({ events: [] as unknown[] }));

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateValueAtom: sessions }),
}));
vi.mock("../rpc/client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rpc/client.ts")>()),
  subscribe: () => Stream.fromIterable(streamed.events),
}));

const sessions = Atom.family((_id: EnvironmentId) => Atom.make<AuthSessionState | null>(null));
const env = EnvironmentId.make("team-env");
const ownerId = MemberId.make("member-owner");
const guestId = MemberId.make("member-guest");

const member = (id: MemberId, overrides: Partial<TeamMember> = {}): TeamMember => ({
  id,
  name: id,
  role: "member",
  color: "hsl(10 60% 50%)",
  isOwner: false,
  createdAt: "2036-04-07T00:00:00.000Z" as TeamMember["createdAt"],
  removedAt: null,
  ...overrides,
});
const owner = member(ownerId, { role: "admin", isOwner: true });
const session = (memberId?: MemberId): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: ["orchestration:read"],
  ...(memberId === undefined ? {} : { memberId }),
});

const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    followStream: (_id: EnvironmentId, stream: Stream.Stream<unknown>) => stream,
  } as unknown as EnvironmentRegistry["Service"]),
);

describe("team state", () => {
  it.effect("currentMemberId derives from session state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const { currentMemberIdAtom } = createTeamEnvironmentAtoms(runtime);
        registry.mount(currentMemberIdAtom(env));
        expect(registry.get(currentMemberIdAtom(env))).toBeNull();
        registry.set(sessions(env), session());
        expect(registry.get(currentMemberIdAtom(env))).toBeNull();
        registry.set(sessions(env), session(guestId));
        expect(registry.get(currentMemberIdAtom(env))).toBe(guestId);
      }),
    ),
  );

  it("members projection applies upserts", () => {
    const guest = member(guestId);
    const snapshot = applyTeamStreamEvent(EMPTY_TEAM_MEMBERS, {
      _tag: "snapshot",
      members: [owner, guest],
    });
    expect([...snapshot.keys()]).toEqual([ownerId, guestId]);
    expect(isTeamModeMembers(snapshot)).toBe(true);

    const renamed = applyTeamStreamEvent(snapshot, {
      _tag: "upserted",
      member: { ...guest, name: "Guest" as TeamMember["name"] },
    });
    expect(renamed.get(guestId)?.name).toBe("Guest");
    expect(snapshot.get(guestId)?.name).toBe(guestId);

    const removed = applyTeamStreamEvent(renamed, {
      _tag: "upserted",
      member: { ...guest, removedAt: "2036-04-08T00:00:00.000Z" as TeamMember["removedAt"] },
    });
    expect(removed.size).toBe(2);
    expect(isTeamModeMembers(removed)).toBe(false);

    const replaced = applyTeamStreamEvent(removed, { _tag: "snapshot", members: [owner] });
    expect([...replaced.keys()]).toEqual([ownerId]);
  });

  it("delete is for the owner or an admin once the server has a team", () => {
    const guest = member(guestId);
    const other = member(MemberId.make("member-other"));
    const team = new Map([owner, guest, other].map((entry) => [entry.id, entry]));
    const solo = new Map([[ownerId, owner]]);
    const can = (members: typeof team, memberId: MemberId | null, owned: MemberId | null) =>
      canMemberDeleteThread({ members, memberId, ownerId: owned });
    expect(can(team, ownerId, guestId)).toBe(true);
    expect(can(team, guestId, guestId)).toBe(true);
    expect(can(team, other.id, guestId)).toBe(false);
    expect(can(team, other.id, null)).toBe(false);
    expect(can(solo, ownerId, null)).toBe(true);
    expect(can(team, null, guestId)).toBe(true);
    // The server owner is an admin even when their stored role says member.
    const roleless = member(ownerId, { isOwner: true });
    expect(
      can(
        new Map([
          [ownerId, roleless],
          [guestId, guest],
        ]),
        ownerId,
        guestId,
      ),
    ).toBe(true);
  });

  it("a cloud thread is assigned by its owner, or by an admin once the owner has left", () => {
    const guest = member(guestId);
    const admin = member(MemberId.make("member-admin"), { role: "admin" });
    const left = member(MemberId.make("member-left"), {
      removedAt: "2036-04-08T00:00:00.000Z" as TeamMember["removedAt"],
    });
    const team = new Map([owner, guest, admin, left].map((entry) => [entry.id, entry]));
    const can = (memberId: MemberId | null, owned: MemberId | null, cloudThread = true) =>
      canMemberAssignThread({ members: team, memberId, ownerId: owned, cloudThread });
    expect(can(guestId, guestId)).toBe(true);
    // An admin cannot take a live member's thread: they could then read it.
    expect(can(admin.id, guestId)).toBe(false);
    expect(can(ownerId, guestId)).toBe(false);
    expect(can(guestId, ownerId)).toBe(false);
    expect(can(admin.id, left.id)).toBe(true);
    expect(can(guestId, left.id)).toBe(false);
    // No recorded owner: the server's owner holds it.
    expect(can(ownerId, null)).toBe(true);
    expect(can(admin.id, null)).toBe(false);
    // Local threads, and servers with no team, keep today's rule.
    expect(can(guestId, ownerId, false)).toBe(true);
    expect(
      canMemberAssignThread({
        members: new Map([[ownerId, owner]]),
        memberId: ownerId,
        ownerId: guestId,
        cloudThread: true,
      }),
    ).toBe(true);
  });

  it("asks where a removed member's cloud threads go, and sends the answer", () => {
    const guest = member(guestId);
    const gone = member(MemberId.make("member-gone"), {
      removedAt: "2036-04-08T00:00:00.000Z" as TeamMember["removedAt"],
    });
    const team = new Map([owner, guest, gone].map((entry) => [entry.id, entry]));
    expect(memberRemovalPrompt("Ada", 4)).toBe("Ada owns 4 cloud threads. Give them to:");
    expect(memberRemovalPrompt("Ada", 1)).toBe("Ada owns 1 cloud thread. Give them to:");
    // Not the member being removed, and not one who already left.
    expect(memberRemovalTargets(team, guestId).map((entry) => entry.id)).toEqual([ownerId]);
    // Without cloud threads there is nothing to choose; with them, "give" needs a person.
    expect(memberRemovalInput(guestId, 0, { type: "give", toMemberId: null })).toEqual({
      memberId: guestId,
    });
    expect(memberRemovalInput(guestId, 2, { type: "give", toMemberId: null })).toBeNull();
    expect(memberRemovalInput(guestId, 2, { type: "give", toMemberId: ownerId })).toEqual({
      memberId: guestId,
      cloudThreads: { type: "give", toMemberId: ownerId },
    });
    expect(memberRemovalInput(guestId, 2, { type: "delete" })).toEqual({
      memberId: guestId,
      cloudThreads: { type: "delete" },
    });
  });

  it.effect("currentMember and team mode follow the member stream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const guest = member(guestId);
        streamed.events = [
          { _tag: "snapshot", members: [owner] },
          { _tag: "upserted", member: guest },
        ] satisfies TeamStreamEvent[];
        const atoms = createTeamEnvironmentAtoms(runtime);
        registry.set(sessions(env), session(guestId));
        registry.mount(atoms.currentMemberAtom(env));
        registry.mount(atoms.isTeamModeAtom(env));
        yield* AtomRegistry.getResult(registry, atoms.teamMembersAtom(env), {
          suspendOnWaiting: true,
        });
        expect(registry.get(atoms.currentMemberAtom(env))).toEqual(guest);
        expect(registry.get(atoms.isTeamModeAtom(env))).toBe(true);
      }),
    ),
  );
});

describe("Team shelf", () => {
  const me = MemberId.make("member-me");
  const bob = MemberId.make("member-bob");
  const viewer: TeamViewer = { memberId: me, ownerId: bob, members: new Map() };

  it.each([
    ["a thread I own stays mine", { ownerId: me }, "mine"],
    ["a thread without an owner belongs to the server owner", {}, "team"],
    ["another member's active thread goes to Team", { ownerId: bob }, "team"],
    ["another member's thread I follow is mine", { ownerId: bob, followedAt: "t" }, "mine"],
    [
      "another member's thread I unfollowed goes back to Team",
      { ownerId: bob, followedAt: null },
      "team",
    ],
    ["another member's thread I pinned is mine", { ownerId: bob, pinnedAt: "t" }, "mine"],
    ["my settled thread is mine", { ownerId: me, settled: true }, "mine"],
    ["another member's settled thread is not listed", { ownerId: bob, settled: true }, "hidden"],
    ["a followed settled thread is mine", { ownerId: bob, followedAt: "t", settled: true }, "mine"],
  ] as const)("team mode: %s", (_name, thread, expected) => {
    const shell = {
      source: "ownerId" in thread ? { ownerId: thread.ownerId } : {},
      pinnedAt: "pinnedAt" in thread ? thread.pinnedAt : undefined,
      followedAt: "followedAt" in thread ? thread.followedAt : undefined,
    };
    expect(
      resolveTeamThreadSection(shell, viewer, {
        settled: "settled" in thread && thread.settled,
      }),
    ).toBe(expected);
  });

  it("sorts the Team bucket by the latest message, run or update", () => {
    const shell = (
      id: string,
      input: { message?: string; completed?: string; updated: string },
    ) => ({
      id: ThreadId.make(id),
      environmentId: env,
      latestUserMessageAt: input.message ?? null,
      latestRun:
        input.completed === undefined
          ? null
          : {
              runId: "turn-1" as never,
              status: "completed" as const,
              assistantMessageId: null,
              requestedAt: "2026-03-09T10:00:00.000Z",
              startedAt: null,
              completedAt: input.completed,
            },
      updatedAt: input.updated,
    });
    const sorted = sortTeamThreadsByActivity([
      shell("stale", { updated: "2026-03-01T00:00:00.000Z" }),
      shell("messaged", {
        message: "2026-03-09T09:00:00.000Z",
        updated: "2026-03-02T00:00:00.000Z",
      }),
      shell("finished", {
        completed: "2026-03-09T12:00:00.000Z",
        updated: "2026-03-03T00:00:00.000Z",
      }),
      shell("touched", { updated: "2026-03-09T10:00:00.000Z" }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["finished", "touched", "messaged", "stale"]);
  });
});

describe("otherMessageAuthorId", () => {
  const me = MemberId.make("member-me");
  const bob = MemberId.make("member-bob");
  it.each([
    ["names a teammate's message", { authorId: bob }, null, true, bob],
    ["skips my own message", { authorId: me }, null, true, undefined],
    ["skips a guest's message", { authorId: bob }, "guest", true, undefined],
    ["skips an agent's message", { authorId: bob }, "agent", true, undefined],
    ["skips a message without an author", {}, null, true, undefined],
    ["skips everything in solo mode", { authorId: bob }, null, false, undefined],
  ] as const)("%s", (_name, message, attribution, isTeamMode, expected) => {
    expect(otherMessageAuthorId({ isTeamMode, currentMemberId: me, message, attribution })).toBe(
      expected,
    );
  });
});
