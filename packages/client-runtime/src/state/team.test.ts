import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MemberId,
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
  canMemberDeleteThread,
  createTeamEnvironmentAtoms,
  isTeamModeMembers,
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
