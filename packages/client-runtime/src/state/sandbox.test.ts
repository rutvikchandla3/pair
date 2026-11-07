import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  MemberId,
  SandboxId,
  ThreadId,
  type AuthSessionState,
  type OrchestrationV2ThreadShellSandbox,
  type TeamMember,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  cloudPushCredential,
  createSandboxEnvironmentAtoms,
  sandboxStatePresentation,
  sharesOtherOwnersMachine,
  type SandboxAction,
  type SandboxStatePresentation,
} from "./sandbox.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import type { TeamMembers, createTeamEnvironmentAtoms } from "./team.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);

const ownerThreadId = ThreadId.make("thread-owner");
const since = "2036-04-07T00:00:00.000Z" as NonNullable<
  OrchestrationV2ThreadShellSandbox["admission"]
>["since"];
const summary = (
  fields: Partial<OrchestrationV2ThreadShellSandbox>,
): OrchestrationV2ThreadShellSandbox => ({ state: "ready", ownerThreadId, ...fields });

describe("sandboxStatePresentation", () => {
  it.each<
    [
      string,
      OrchestrationV2ThreadShellSandbox,
      boolean,
      Omit<SandboxStatePresentation, "ownerOnly">,
    ]
  >([
    [
      "waiting at the team cap",
      summary({ state: "provisioning", admission: { reason: "team-cap", since } }),
      false,
      {
        label: "Waiting for a machine: team limit reached",
        rowWord: "Waiting",
        tone: "warning",
        composer: "queues",
        actions: [],
      },
    ],
    [
      "waiting for an unknown reason",
      summary({ state: "provisioning", admission: { reason: null, since } }),
      false,
      {
        label: "Waiting for a machine",
        rowWord: "Waiting",
        tone: "warning",
        composer: "queues",
        actions: [],
      },
    ],
    [
      "starting",
      summary({ state: "provisioning" }),
      false,
      {
        label: "Starting machine",
        rowWord: "Starting",
        tone: "neutral",
        composer: "queues",
        actions: [],
      },
    ],
    [
      "ready and idle",
      summary({ state: "ready", runnerConnected: true }),
      false,
      {
        label: null,
        rowWord: null,
        tone: "neutral",
        composer: "normal",
        actions: ["sleep", "discard"],
      },
    ],
    [
      "ready with an active run",
      summary({ state: "ready" }),
      true,
      { label: null, rowWord: null, tone: "neutral", composer: "normal", actions: [] },
    ],
    [
      "ready with the runner disconnected",
      summary({ state: "ready", runnerConnected: false }),
      false,
      {
        label: "Reconnecting to machine",
        rowWord: null,
        tone: "warning",
        composer: "queues",
        actions: [],
      },
    ],
    [
      "asleep",
      summary({ state: "sleeping" }),
      false,
      {
        label: "Asleep",
        rowWord: "Asleep",
        tone: "neutral",
        composer: "queues",
        actions: ["wake", "discard"],
      },
    ],
    [
      "waking",
      summary({ state: "waking" }),
      false,
      { label: "Waking machine", rowWord: null, tone: "neutral", composer: "queues", actions: [] },
    ],
    [
      "failed with a known code",
      summary({ state: "failed", failureCode: "driver-removed" }),
      false,
      {
        label: "The machine's driver was removed",
        rowWord: "Failed",
        tone: "danger",
        composer: "disabled",
        actions: ["retry", "discard"],
      },
    ],
    [
      "failed with an unknown code",
      summary({ state: "failed", failureCode: "boot-timeout" }),
      false,
      {
        label: "Machine failed",
        rowWord: "Failed",
        tone: "danger",
        composer: "disabled",
        actions: ["retry", "discard"],
      },
    ],
    [
      "discarded",
      summary({ state: "destroyed" }),
      false,
      {
        label: "Machine discarded",
        rowWord: null,
        tone: "neutral",
        composer: "normal",
        actions: [],
      },
    ],
    [
      "a state from a newer server",
      summary({ state: null }),
      false,
      {
        label: "Machine status unknown",
        rowWord: null,
        tone: "neutral",
        composer: "normal",
        actions: [],
      },
    ],
  ])("%s", (_name, sandbox, hasActiveRun, expected) => {
    expect(sandboxStatePresentation(sandbox, { hasActiveRun })).toEqual({
      ...expected,
      ownerOnly: ["sleep", "discard"],
    });
  });
});

describe("cloudPushCredential", () => {
  const owner = (github?: TeamMember["github"]): TeamMember => ({
    id: MemberId.make("member-owner"),
    name: "Owner",
    role: "member",
    color: "hsl(0, 60%, 50%)",
    isOwner: false,
    createdAt: since,
    removedAt: null,
    ...(github === undefined ? {} : { github }),
  });

  it.each([
    ["the App answers first", true, owner(), "app"],
    [
      "a connected owner pushes",
      false,
      owner({ login: "o", connected: true, source: "token" }),
      "owner",
    ],
    [
      "a disconnected owner pushes nothing",
      false,
      owner({ login: "o", connected: false }),
      "missing",
    ],
    ["an unknown owner pushes nothing", false, undefined, "missing"],
  ] as const)("%s", (_name, appConfigured, member, expected) => {
    expect(cloudPushCredential({ appConfigured, owner: member })).toBe(expected);
  });
});

describe("sharesOtherOwnersMachine", () => {
  const alice = MemberId.make("member-alice");
  const bob = MemberId.make("member-bob");
  const sandboxId = SandboxId.make("sbx_0123456789abcdef0123");
  it.each([
    ["a fork on a teammate's machine", { sandboxId, ownerId: bob }, { ownerMemberId: alice }, true],
    ["the owner's own thread", { sandboxId, ownerId: alice }, { ownerMemberId: alice }, false],
    ["a local thread", { ownerId: bob }, undefined, false],
    ["a thread whose machine has not loaded", { sandboxId, ownerId: bob }, undefined, false],
    ["a solo server", { sandboxId, ownerId: null }, { ownerMemberId: null }, false],
  ] as const)("%s", (_name, thread, sandbox, expected) => {
    expect(sharesOtherOwnersMachine(thread, sandbox)).toBe(expected);
  });
});

describe("actionAllowedAtom", () => {
  const env = EnvironmentId.make("sandbox-env");
  const ownerId = MemberId.make("member-owner");
  const adminId = MemberId.make("member-admin");
  const otherId = MemberId.make("member-other");
  const member = (id: MemberId, role: TeamMember["role"]): TeamMember => ({
    id,
    name: id,
    role,
    color: "hsl(10 60% 50%)",
    isOwner: false,
    createdAt: since,
    removedAt: null,
  });
  const members: TeamMembers = new Map([
    [ownerId, member(ownerId, "member")],
    [adminId, member(adminId, "admin")],
    [otherId, member(otherId, "member")],
  ]);
  const currentMemberId = Atom.make<MemberId | null>(null);
  const team = {
    membersValueAtom: () => Atom.make(members),
    currentMemberIdAtom: () => currentMemberId,
  } as unknown as ReturnType<typeof createTeamEnvironmentAtoms>;
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {
      run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
    } as unknown as EnvironmentRegistry["Service"]).pipe(
      Layer.provideMerge(SecureRandom.layerWebCrypto),
    ),
  );
  const sandboxId = SandboxId.make("sbx_0123456789abcdef0123");
  const forkThreadId = ThreadId.make("thread-fork");
  // A teammate's fork of the owner's cloud thread: it shares the owner thread's machine.
  const shells = new Map([
    [ownerThreadId, { id: ownerThreadId, source: { sandboxId, ownerId }, runtime: null }],
    [
      forkThreadId,
      {
        id: forkThreadId,
        source: { sandboxId, ownerId: otherId, sandbox: summary({}) },
        runtime: null,
      },
    ],
  ]);
  const shellFamily = Atom.family((threadId: ThreadId) =>
    Atom.make((shells.get(threadId) ?? null) as unknown as EnvironmentThreadShell | null),
  );
  const sandbox = createSandboxEnvironmentAtoms(runtime, {
    team,
    threadShells: { quietThreadShellAtom: (ref) => shellFamily(ref.threadId) },
  });
  const actions: ReadonlyArray<SandboxAction> = ["wake", "sleep", "retry", "discard"];
  const operator: AuthSessionState = {
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    scopes: [AuthOrchestrationOperateScope],
    permissions: [AuthOrchestrationOperateScope],
  };

  it("grants wake and retry to any operator, sleep and discard to the owner or an admin", () => {
    const registry = AtomRegistry.make();
    registry.mount(sessions(env));
    const allowed = () =>
      actions.filter((action) =>
        registry.get(
          sandbox.actionAllowedAtom({ environmentId: env, action, ownerMemberId: ownerId }),
        ),
      );
    try {
      registry.set(
        sessions(env),
        AsyncResult.success({ ...operator, scopes: [], permissions: [] }),
      );
      registry.set(currentMemberId, adminId);
      expect(allowed()).toEqual([]);

      registry.set(sessions(env), AsyncResult.success(operator));
      registry.set(currentMemberId, otherId);
      expect(allowed()).toEqual(["wake", "retry"]);
      registry.set(currentMemberId, adminId);
      expect(allowed()).toEqual(actions);
      registry.set(currentMemberId, ownerId);
      expect(allowed()).toEqual(actions);
    } finally {
      registry.dispose();
    }
  });

  it("judges a fork's owner-only actions by the machine's owner thread", () => {
    const registry = AtomRegistry.make();
    registry.mount(sessions(env));
    const machine = () =>
      registry.get(sandbox.threadMachineAtom({ environmentId: env, threadId: forkThreadId }));
    try {
      registry.set(
        sessions(env),
        AsyncResult.success({ ...operator, scopes: [], permissions: [] }),
      );
      registry.set(currentMemberId, otherId);
      expect(machine()).toMatchObject({ sandboxId, actions: [], ownerOnlyDenied: [] });

      registry.set(sessions(env), AsyncResult.success(operator));
      // The fork is the viewer's own thread, but the machine is the owner thread's owner's.
      expect(machine()).toMatchObject({
        actions: ["sleep", "discard"],
        ownerOnlyDenied: ["sleep", "discard"],
      });
      registry.set(currentMemberId, ownerId);
      expect(machine()?.ownerOnlyDenied).toEqual([]);
    } finally {
      registry.dispose();
    }
  });
});
