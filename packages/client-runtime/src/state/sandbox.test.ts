import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  MemberId,
  ProviderDriverKind,
  ProviderInstanceId,
  SandboxId,
  ThreadId,
  type AuthSessionState,
  type ProviderInstanceConfig,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShellSandbox,
  type TeamMember,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  cloudAccountNotice,
  cloudPushCredential,
  createSandboxEnvironmentAtoms,
  sandboxAccessSummary,
  sandboxStatePresentation,
  sharesOtherOwnersMachine,
  stoppedFilesFromProjection,
  stoppedReadLabel,
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

describe("cloudAccountNotice", () => {
  const ada = MemberId.make("member-ada");
  const claude = ProviderDriverKind.make("claudeAgent");
  const codex = ProviderDriverKind.make("codex");
  const token = {
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    value: "",
    sensitive: true,
    valueRedacted: true,
  };
  const app = { github: { appId: "1", appPrivateKey: "key" } };
  const member = (github?: TeamMember["github"]): TeamMember => ({
    id: ada,
    name: "Ada",
    role: "member",
    color: "hsl(0, 60%, 50%)",
    isOwner: false,
    createdAt: since,
    removedAt: null,
    ...(github === undefined ? {} : { github }),
  });
  const instance = (id: string, config: ProviderInstanceConfig) => ({
    settings: { [id]: config },
    providers: [
      {
        instanceId: ProviderInstanceId.make(id),
        driver: config.driver,
        enabled: true,
        installed: true,
      },
    ],
  });

  it.each([
    { name: "no instances", accounts: { settings: {}, providers: [] }, expected: "provider" },
    {
      name: "only another member's instance",
      accounts: instance("claude_grace", {
        driver: claude,
        ownerMemberId: MemberId.make("member-grace"),
        environment: [token],
      }),
      expected: "provider",
    },
    {
      name: "a Local-only Claude instance",
      accounts: instance("claudeAgent", { driver: claude }),
      expected: "provider",
    },
    {
      name: "a company Codex instance",
      accounts: instance("codex", { driver: codex, config: { setupMode: "managed" } }),
      hosts: app,
      expected: null,
    },
    {
      name: "the App is configured and the member has no GitHub",
      accounts: instance("claude_ada", {
        driver: claude,
        ownerMemberId: ada,
        environment: [token],
      }),
      hosts: app,
      expected: null,
    },
    {
      name: "there is no App and the member has no GitHub",
      accounts: instance("claude_ada", {
        driver: claude,
        ownerMemberId: ada,
        environment: [token],
      }),
      expected: "github",
    },
  ] as const)("says what to connect when $name", ({ accounts, hosts, expected }) => {
    const notice = cloudAccountNotice({
      settings: { providerInstances: accounts.settings, sourceControlHosts: hosts ?? {} },
      providers: accounts.providers,
      memberId: ada,
      member: member(),
    });
    expect(notice?.kind ?? null).toBe(expected);
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

describe("sandboxAccessSummary", () => {
  const me = MemberId.make("ada");
  const fay = MemberId.make("fay");
  const others = ["bob", "cy", "di", "ed"].map((id) => MemberId.make(id)).concat(fay);
  const ids = [me, ...others];
  const removed = MemberId.make("gone");
  const members: TeamMembers = new Map(
    [...ids, removed].map((id) => [
      id,
      {
        id,
        name: id.toUpperCase(),
        role: "member",
        color: "hsl(0, 60%, 50%)",
        isOwner: false,
        createdAt: since,
        removedAt: id === removed ? since : null,
      },
    ]),
  );
  const shell = (access: OrchestrationV2ThreadShellSandbox["access"], ownerId = me) => ({
    source: { ownerId, sandbox: summary(access === undefined ? {} : { access }) },
  });
  const people = (count: number) => ({
    audience: "members" as const,
    memberIds: others.slice(0, count),
  });

  // The chip as a row: "people" lists the avatars shown, then the count behind "+N".
  const view = (input: ReturnType<typeof shell>, viewer: MemberId | null) => {
    const result = sandboxAccessSummary(input, members, viewer);
    const chip = result?.chip ?? null;
    return {
      chip:
        chip?.kind === "people"
          ? [chip.shown.map((member) => member.name).join(" "), chip.more, chip.label]
          : (chip?.kind ?? null),
      canShare: result?.canShare,
    };
  };

  it.each([
    ["private", shell(people(0)), me, null, true],
    ["one person", shell(people(1)), me, ["BOB", 0, "Shared with BOB"], true],
    ["three people", shell(people(3)), me, ["BOB CY DI", 0, "Shared with BOB, CY, DI"], true],
    [
      "five people",
      shell(people(5)),
      me,
      ["BOB CY DI", 2, "Shared with BOB, CY, DI, ED, FAY"],
      true,
    ],
    ["only a removed member", shell({ audience: "members", memberIds: [removed] }), me, null, true],
    ["everyone", shell({ audience: "team", memberIds: [] }), me, "team", true],
    ["a machine from before sharing", shell(undefined), me, "team", true],
    ["an audience from a newer server", shell({ audience: null, memberIds: [] }), me, null, false],
    ["not the owner", shell(people(2), fay), me, ["BOB CY", 0, "Shared with BOB, CY"], false],
    ["no member session", shell(people(0)), null, null, false],
  ] as const)("%s", (_name, input, viewer, chip, canShare) => {
    expect(view(input, viewer)).toEqual({ chip, canShare });
  });

  it("says nothing for a local thread or on a solo server", () => {
    expect(sandboxAccessSummary({ source: { ownerId: me } }, members, me)).toBeNull();
    const solo: TeamMembers = new Map([...members].filter(([id]) => id === me));
    expect(sandboxAccessSummary(shell(people(0)), solo, me)).toBeNull();
  });
});

describe("stopped reads", () => {
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  const clock = (time: DateTime.Utc) => DateTime.formatIso(time).slice(11, 16);
  const projection = (
    sandbox: { state: string; runnerLostAt?: string; sleepSnapshotAt?: string },
    checkpoints: ReadonlyArray<{ turn: number | null; capturedAt: string; ready?: boolean }>,
  ) =>
    ({
      sandbox: {
        id: SandboxId.make("sbx_0123456789abcdef0123"),
        ownerMemberId: null,
        state: sandbox.state,
        runnerLostAt: sandbox.runnerLostAt === undefined ? null : at(sandbox.runnerLostAt),
        ...(sandbox.sleepSnapshotAt === undefined
          ? {}
          : { sleepSnapshotAt: at(sandbox.sleepSnapshotAt) }),
      },
      checkpoints: checkpoints.map((checkpoint) => ({
        status: checkpoint.ready === false ? "missing" : "ready",
        appRunOrdinal: checkpoint.turn,
        capturedAt: at(checkpoint.capturedAt),
      })),
    }) as unknown as Pick<OrchestrationV2ThreadProjection, "sandbox" | "checkpoints">;
  const label = (input: Parameters<typeof projection>) => {
    const stopped = stoppedFilesFromProjection(projection(...input));
    return stopped === null ? null : stoppedReadLabel(stopped, clock);
  };

  it.each([
    ["a running machine reads itself", [{ state: "ready" }, []], null],
    [
      "a lost runner reads the newest ready turn",
      [
        { state: "ready", runnerLostAt: "2036-04-07T10:00:00Z" },
        [
          { turn: 7, capturedAt: "2036-04-07T09:00:00Z" },
          { turn: 8, capturedAt: "2036-04-07T09:30:00Z", ready: false },
          { turn: 6, capturedAt: "2036-04-07T08:00:00Z" },
        ],
      ],
      "As of turn 7",
    ],
    ["no turn yet", [{ state: "sleeping" }, []], "No saved turn to show yet"],
    [
      "the sleep snapshot",
      [
        { state: "sleeping", sleepSnapshotAt: "2036-04-07T14:02:00Z" },
        [{ turn: 7, capturedAt: "2036-04-07T09:00:00Z" }],
      ],
      "As of 14:02, when the machine slept",
    ],
    [
      "a turn after a later wake beats an old snapshot",
      [
        {
          state: "ready",
          runnerLostAt: "2036-04-08T10:00:00Z",
          sleepSnapshotAt: "2036-04-07T14:02:00Z",
        },
        [{ turn: 9, capturedAt: "2036-04-08T09:00:00Z" }],
      ],
      "As of turn 9",
    ],
  ] as const)("%s", (_name, input, expected) => {
    expect(label(input as unknown as Parameters<typeof projection>)).toBe(expected);
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

  it("judges a fork's owner-only actions and sharing by the machine's owner thread", () => {
    const registry = AtomRegistry.make();
    registry.mount(sessions(env));
    const fork = { environmentId: env, threadId: forkThreadId };
    const machine = () => registry.get(sandbox.threadMachineAtom(fork));
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
      expect(registry.get(sandbox.shareThreadCommand.permissionAtom(fork))).toBe(false);
      registry.set(currentMemberId, ownerId);
      expect(machine()?.ownerOnlyDenied).toEqual([]);
      expect(registry.get(sandbox.shareThreadCommand.permissionAtom(fork))).toBe(true);
    } finally {
      registry.dispose();
    }
  });
});
