import { describe, expect, it } from "@effect/vitest";
import type {
  ApplicationStoredEvent,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { MemberId, ProjectId, ProviderInstanceId, SandboxId, ThreadId } from "@t3tools/contracts";
import type { SandboxAccessChange } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadAccess from "../team/ThreadAccess.ts";
import { viewerAccessOf } from "./MemberThreadView.ts";
import type { ActiveShellIndexEntry } from "./ProjectionStore.ts";

import {
  accessChangedThreadIds,
  activeShellRowsForSubscriber,
  bufferShellLiveStream,
  coalesceShellApplicationEvents,
  composeShellStreamWithEnrichment,
  dedupeShellEnrichment,
  expandSandboxShellEvents,
  isOtherMembersShellEvent,
  loadSubscriberShellSnapshot,
  mayShowShellEvent,
  omitIdleSubagentShells,
  omitOlderSettledShells,
  shellStreamItemFromEnrichmentRefresh,
  shellStreamItemForViewer,
  shellStreamItemFromThreadShell,
  shellStreamItemsFromInitialSnapshot,
  shouldPublishShellApplicationEvent,
  skipUnchangedThreadShells,
  toShellApplicationEvent,
} from "./ShellStream.ts";

const emptyShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 0,
  projects: [],
  threads: [],
  archivedThreads: [],
} as OrchestrationV2ShellSnapshot;

describe("subagent shell events", () => {
  const stored = (threadId: string, type: string) =>
    ({ event: { threadId, type } }) as ApplicationStoredEvent;

  it("keeps regular threads and subagent state changes while omitting subagent transcript updates", () => {
    const subagents = new Set(["child"]);
    expect(
      shouldPublishShellApplicationEvent(stored("parent", "turn-item.updated"), subagents),
    ).toBe(true);
    expect(
      shouldPublishShellApplicationEvent(stored("child", "turn-item.updated"), subagents),
    ).toBe(false);
    expect(shouldPublishShellApplicationEvent(stored("child", "node.updated"), subagents)).toBe(
      false,
    );
    expect(
      shouldPublishShellApplicationEvent(stored("child", "runtime-request.updated"), subagents),
    ).toBe(true);
    expect(shouldPublishShellApplicationEvent(stored("child", "run.updated"), subagents)).toBe(
      true,
    );
  });

  it("tracks subagents created after the subscription starts", () => {
    const subagents = new Set<string>();
    const created = {
      event: {
        threadId: "new-child",
        type: "thread.created",
        payload: { lineage: { relationshipToParent: "subagent" } },
      },
    } as ApplicationStoredEvent;
    expect(shouldPublishShellApplicationEvent(created, subagents)).toBe(true);
    expect(
      shouldPublishShellApplicationEvent(stored("new-child", "message.updated"), subagents),
    ).toBe(false);
    expect(
      shouldPublishShellApplicationEvent(stored("new-child", "thread.deleted"), subagents),
    ).toBe(true);
    expect(subagents.has("new-child")).toBe(true);
  });
});

describe("sandbox shell events", () => {
  it("re-sends the shell of every unarchived thread sharing the machine, once each", () => {
    const sandboxId = SandboxId.make("sbx_0123456789abcdef0123");
    const attached = (threadId: string, archived = false) => ({
      threadId: ThreadId.make(threadId),
      attachedAt: DateTime.makeUnsafe("2026-11-06T00:00:00.000Z"),
      archived,
    });
    const events = [
      { sequence: 1, event: { threadId: "fork", type: "run.updated" } },
      {
        sequence: 2,
        event: { threadId: "owner", type: "sandbox.updated", payload: { id: sandboxId } },
      },
    ].map((stored) => toShellApplicationEvent(stored as ApplicationStoredEvent));
    expect(events[1]).toEqual({ sequence: 2, event: { threadId: "owner", sandboxId } });

    const expanded = expandSandboxShellEvents(
      events,
      new Map([[sandboxId, [attached("owner"), attached("fork"), attached("side", true)]]]),
    );
    expect(coalesceShellApplicationEvents(expanded)).toEqual([
      { sequence: 2, event: { threadId: "fork" } },
      { sequence: 2, event: { threadId: "owner", sandboxId } },
    ]);
  });
});

describe("shell events for a member on a cloud-only server", () => {
  const alice = MemberId.make("member-alice");
  const bob = MemberId.make("member-bob");
  const carol = MemberId.make("member-carol");
  const sandboxId = SandboxId.make("sbx_0123456789abcdef0123");
  const ownerId = ThreadId.make("owner");
  const forkId = ThreadId.make("fork");
  const localId = ThreadId.make("local");
  // A provider-native subagent: on the machine, but with no machine row.
  const childId = ThreadId.make("child");
  const onMachine = { sandboxId, ownerId: alice };
  const shells = new Map([
    [ownerId, shellFixture({ id: ownerId, ...onMachine })],
    [forkId, shellFixture({ id: forkId, ...onMachine })],
    [childId, shellFixture({ id: childId, ...onMachine })],
    [localId, shellFixture({ id: localId, ownerId: carol })],
  ]);

  /** The machine's audience after the commit, as the index holds it when the shell reads. */
  const accessOf = (
    memberId: MemberId,
    audience: "members" | "team",
    memberIds: ReadonlyArray<MemberId>,
    localOwner = carol,
  ) => {
    const roster = { cloudOnly: true, serverOwnerId: alice, isActive: () => true };
    const entry = { ownerMemberId: alice, audience, memberIds: new Set(memberIds) };
    const entries = new Map([[sandboxId, entry]]);
    const threads = new Map<ThreadId, ThreadAccess.ThreadAccessTarget>([
      [ownerId, onMachine],
      [forkId, onMachine],
      [childId, onMachine],
      [localId, { ownerId: localOwner }],
    ]);
    const allowsThread = (member: MemberId, thread: ThreadAccess.ThreadAccessTarget) =>
      ThreadAccess.threadAllows(
        roster,
        thread,
        thread.sandboxId === undefined ? undefined : entries.get(thread.sandboxId),
        member,
      );
    const access = viewerAccessOf(
      {
        enforced: true,
        allowsSandbox: (member, id) => ThreadAccess.sandboxAllows(roster, entries.get(id), member),
        allowsThread,
        agentReaches: () => true,
        assertThread: () => Effect.void,
        assertPath: () => Effect.void,
        threadTarget: (threadId) => threads.get(threadId),
        caughtUp: Effect.void,
        changes: Stream.empty,
        subscribeChanges: Effect.die("unused"),
      },
      memberId,
    );
    if (access === undefined) throw new Error("expected access rules");
    return access;
  };
  const stored = (sequence: number, event: object) =>
    ({ sequence, commandId: null, event }) as ApplicationStoredEvent;
  const changed = (change: Partial<SandboxAccessChange>) =>
    stored(5, {
      threadId: ownerId,
      type: "sandbox.access-changed",
      payload: {
        sandboxId,
        added: [],
        removed: [],
        audienceChanged: false,
        actorId: alice,
        ...change,
      },
    });
  /** What the live shell stream sends this member for a batch of committed events. */
  const sent = (
    access: ReturnType<typeof accessOf>,
    events: ReadonlyArray<ApplicationStoredEvent>,
    read = shells,
  ) => {
    const expanded = expandSandboxShellEvents(
      events.filter((event) => mayShowShellEvent(event, access)).map(toShellApplicationEvent),
      new Map([
        [
          sandboxId,
          [ownerId, forkId].map((threadId) => ({
            threadId,
            attachedAt: DateTime.makeUnsafe("2026-11-06T00:00:00.000Z"),
            archived: false,
          })),
        ],
      ]),
      (id) => [childId, localId].filter((threadId) => access.sandboxOf(threadId) === id),
    );
    const revocable = accessChangedThreadIds(expanded);
    return coalesceShellApplicationEvents(expanded).flatMap((event) => {
      if ("aggregateKind" in event) return [];
      const item = shellStreamItemForViewer({
        stored: event,
        shell: read.get(event.event.threadId) ?? null,
        access,
        accessChangedThreadIds: revocable,
      });
      return item === null
        ? []
        : [[item.kind, item.kind === "thread.updated" ? item.thread.id : item.threadId]];
    });
  };
  const updated = [
    ["thread.updated", ownerId],
    ["thread.updated", forkId],
  ];
  const removed = [
    ["thread.removed", ownerId],
    ["thread.removed", forkId],
  ];
  const gained = [...updated, ["thread.updated", childId]];
  const lost = [...removed, ["thread.removed", childId]];

  it.each([
    ["added", bob, ["members", [bob]], { added: [bob] }, gained],
    ["removed", bob, ["members", []], { removed: [bob] }, lost],
    ["opened to the team", carol, ["team", []], { audienceChanged: true }, gained],
    ["closed to members", carol, ["members", [bob]], { audienceChanged: true }, lost],
    ["closed to members, still listed", bob, ["members", [bob]], { audienceChanged: true }, gained],
    ["someone else added", carol, ["members", [bob]], { added: [bob] }, []],
    ["someone else removed", carol, ["members", []], { removed: [bob] }, []],
  ] as const)(
    "%s: re-sends or removes the machine's threads",
    (_name, memberId, [audience, members], change, expected) => {
      expect(sent(accessOf(memberId, audience, members), [changed(change)])).toEqual(expected);
    },
  );

  it("sends a member nothing of a thread they cannot open", () => {
    const carols = accessOf(carol, "members", [bob]);
    const ownerPayload = { id: ownerId, ...onMachine };
    const events = [
      stored(1, { threadId: ownerId, type: "thread.meta-updated", payload: ownerPayload }),
      stored(2, { threadId: ownerId, type: "run.updated" }),
      stored(3, { threadId: ownerId, type: "sandbox.updated", payload: { id: sandboxId } }),
      stored(4, { threadId: localId, type: "run.updated" }),
    ];
    expect(events.map((event) => mayShowShellEvent(event, carols))).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(sent(carols, events)).toEqual([["thread.updated", localId]]);
    // A thread the index has not seen passes the pre-filter; the shell read decides.
    const unknown = stored(6, { threadId: ThreadId.make("unknown"), type: "run.updated" });
    expect(mayShowShellEvent(unknown, carols)).toBe(true);
    expect(sent(carols, [unknown])).toEqual([]);
    expect(sent(accessOf(bob, "members", [bob]), events.slice(0, 3))).toEqual(updated);
  });

  it("removes a thread with no machine from the owner it moved away from", () => {
    const moved = { id: localId, ownerId: bob };
    const events = [
      stored(7, { threadId: localId, type: "thread.metadata-updated", payload: moved }),
      // The old holder's own row, as `transferHolder` emits it.
      stored(7, {
        threadId: localId,
        type: "thread.metadata-updated",
        payload: moved,
        member: { memberId: carol },
      }),
    ];
    const read = new Map([...shells, [localId, shellFixture(moved)]]);
    const sentTo = (memberId: MemberId) =>
      sent(
        accessOf(memberId, "members", [], bob),
        events.filter((event) => !isOtherMembersShellEvent(event, memberId)),
        read,
      );
    expect(sentTo(carol)).toEqual([["thread.removed", localId]]);
    expect(sentTo(bob)).toEqual([["thread.updated", localId]]);
  });

  it.effect("counts and trims only the threads the member can open", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const settled = (id: string, day: number, machine: boolean) =>
        shellFixture({
          id: ThreadId.make(id),
          projectId: ProjectId.make("project-a"),
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: ThreadId.make(id),
          },
          settledOverride: "settled",
          settledAt: DateTime.makeUnsafe(day * 24 * 60 * 60 * 1000),
          pinnedAt: null,
          snoozedUntil: null,
          ...(machine ? onMachine : { ownerId: carol }),
        });
      // A hidden thread among the newest would push a visible one out, and one older would count.
      const rows = [
        ...Array.from({ length: 25 }, (_, index) => settled(`new-${index}`, 100 - index, false)),
        settled("hidden-new", 101, true),
        settled("old", 50, false),
        settled("hidden-old", 40, true),
      ];
      const requested: Array<ReadonlyArray<ThreadId> | undefined> = [];
      const load = (access: ReturnType<typeof accessOf> | undefined, omitOlderSettled: boolean) =>
        loadSubscriberShellSnapshot({
          sql,
          listShellIndex: Effect.succeed(
            rows.map((row): ActiveShellIndexEntry => ({ ...row, mayBeLive: false })),
          ),
          readThreads: (threadIds) => {
            requested.push(threadIds);
            return Effect.succeed(
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: rows.filter(
                  (row) => threadIds === undefined || threadIds.includes(row.id),
                ),
                archivedThreads: [],
              }),
            );
          },
          listProjects: Effect.succeed([]),
          latestSequence: Effect.succeed(9),
          options: { omitIdleSubagents: false, omitOlderSettled },
          access,
        }).pipe(Effect.map(({ snapshot }) => snapshot));
      const carols = accessOf(carol, "members", [bob]);
      const trimmed = yield* load(carols, true);
      expect(trimmed.threads.map((thread) => thread.id)).toHaveLength(25);
      expect(trimmed.threads.map((thread) => thread.id)).not.toContain("hidden-new");
      expect(trimmed.olderSettled?.counts).toEqual([{ projectId: "project-a", count: 1 }]);
      expect(requested.at(-1)).not.toContain("hidden-new");
      const untrimmed = yield* load(carols, false);
      expect(untrimmed.threads.map((thread) => thread.id)).not.toContain("hidden-old");
      expect(untrimmed.threads).toHaveLength(26);
      // Without access rules the hidden ones show, pushing `new-24` into the older count.
      expect((yield* load(undefined, true)).olderSettled?.counts).toEqual([
        { projectId: "project-a", count: 3 },
      ]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});

it.effect("coalesces a slow shell subscriber by identity and location in sequence order", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const input = yield* Queue.unbounded<
        Extract<OrchestrationV2ShellStreamItem, { readonly sequence: number }>,
        Cause.Done
      >();
      const drained = yield* Deferred.make<void>();
      const shell = shellFixture({ id: ThreadId.make("same"), title: "Before" });
      const project = {
        id: ProjectId.make("same"),
        title: "Before",
        workspaceRoot: "/workspace/same",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-01T00:00:00Z",
      };
      const initial = {
        kind: "thread.updated" as const,
        sequence: 1,
        location: "active" as const,
        thread: shell,
      };
      const updates = [
        { kind: "project.updated", sequence: 2, project },
        { ...initial, sequence: 3 },
        { ...initial, sequence: 4, location: "archive" },
        { ...initial, sequence: 5, thread: { ...shell, id: ThreadId.make("other") } },
        {
          kind: "project.updated",
          sequence: 6,
          project: { ...project, id: ProjectId.make("other") },
        },
        { kind: "project.removed", sequence: 7, projectId: project.id },
        { kind: "thread.removed", sequence: 8, location: "active", threadId: shell.id },
        { kind: "project.updated", sequence: 9, project: { ...project, title: "Recreated" } },
        { ...initial, sequence: 10, thread: { ...shell, title: "Recreated" } },
        { kind: "thread.removed", sequence: 11, location: "archive", threadId: shell.id },
      ] satisfies Array<Extract<OrchestrationV2ShellStreamItem, { readonly sequence: number }>>;
      const pull = yield* Stream.toPull(
        bufferShellLiveStream(
          Stream.fromQueue(input).pipe(Stream.ensuring(Deferred.succeed(drained, undefined))),
          { maxItems: 6, maxSerializedBytes: 1_500 },
        ),
      );
      yield* Queue.offer(input, initial);
      expect(yield* pull).toEqual([initial]);
      yield* Queue.offerAll(input, updates);
      yield* Queue.end(input);
      // Finish producing the burst while the first batch is still awaiting its ACK.
      yield* Deferred.await(drained);
      expect(yield* pull).toEqual([updates[3], updates[4], updates[7], updates[8], updates[9]]);
    }),
  ),
);

function shellFixture(overrides: Partial<OrchestrationV2ThreadShell>): OrchestrationV2ThreadShell {
  return { id: "thread-a", archivedAt: null, ...overrides } as OrchestrationV2ThreadShell;
}

it("removes an archived thread from the active list, naming another member who archived it", () => {
  const archived = (archivedBy?: MemberId) =>
    shellStreamItemFromThreadShell({
      stored: { sequence: 4 } as Parameters<typeof shellStreamItemFromThreadShell>[0]["stored"],
      shell: shellFixture({
        archivedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
        ...(archivedBy === undefined ? {} : { archivedBy }),
      }),
    });
  const removed = { kind: "thread.removed", sequence: 4, location: "active", threadId: "thread-a" };
  expect(archived(MemberId.make("bob"))).toEqual({ ...removed, archivedBy: "bob" });
  expect(archived()).toEqual(removed);
});

describe("omitIdleSubagentShells", () => {
  const row = (
    id: string,
    parent: string | null,
    overrides: Partial<OrchestrationV2ThreadShell> = {},
  ) =>
    shellFixture({
      id: ThreadId.make(id),
      lineage: {
        parentThreadId: parent === null ? null : ThreadId.make(parent),
        relationshipToParent: parent === null ? null : "subagent",
        rootThreadId: ThreadId.make("root"),
      },
      status: "completed",
      activityRunStatus: null,
      pendingRuntimeRequest: null,
      pendingBackgroundTasks: [],
      ...overrides,
    });

  it("drops idle leaf children but keeps live ones and the middle of nested chains", () => {
    const threads = [
      row("root", null),
      row("idle", "root"),
      row("running", "root", { activityRunStatus: "running" }),
      row("queued", "root", { status: "queued" }),
      row("asking", "root", {
        pendingRuntimeRequest: {
          id: "request" as never,
          kind: "user_input",
          createdAt: DateTime.makeUnsafe(0),
        },
      }),
      row("background", "root", {
        pendingBackgroundTasks: [{ kind: "subagent" } as never],
      }),
      // Idle, but a woken grandchild walks through it to reach the root's badge.
      row("middle", "root"),
      row("grandchild", "middle"),
    ];
    expect(omitIdleSubagentShells(threads).map((thread) => thread.id)).toEqual([
      "root",
      "running",
      "queued",
      "asking",
      "background",
      "middle",
    ]);
  });

  it("still filters the transcript events of omitted children for a subscriber that opts in", () => {
    const threads = [row("root", null), row("idle", "root")];
    const omitted = activeShellRowsForSubscriber(threads, true);
    expect(omitted.threads.map((thread) => thread.id)).toEqual(["root"]);
    expect(
      shouldPublishShellApplicationEvent(
        { event: { threadId: "idle", type: "turn-item.updated" } } as ApplicationStoredEvent,
        omitted.subagentThreadIds,
      ),
    ).toBe(false);
  });
});

describe("omitOlderSettledShells", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = DateTime.makeUnsafe(100 * DAY);
  const row = (
    id: string,
    settledDaysAgo: number | null,
    overrides: Partial<OrchestrationV2ThreadShell> = {},
  ) =>
    shellFixture({
      id: ThreadId.make(id),
      projectId: ProjectId.make(id.startsWith("b-") ? "project-b" : "project-a"),
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: ThreadId.make(id),
      },
      status: "completed",
      activityRunStatus: null,
      pendingRuntimeRequest: null,
      pendingBackgroundTasks: [],
      settledOverride: settledDaysAgo === null ? null : "settled",
      settledAt:
        settledDaysAgo === null ? null : DateTime.makeUnsafe(100 * DAY - settledDaysAgo * DAY),
      ...overrides,
    });
  const newest = Array.from({ length: 25 }, (_, index) => row(`new-${index}`, index / 10));
  const omit = (threads: ReadonlyArray<OrchestrationV2ThreadShell>) =>
    omitOlderSettledShells({ threads, snapshotSequence: 7, now });

  it("keeps the 25 newest settled threads and counts the rest per project", () => {
    const sideChat = row("side-chat", 0, {
      lineage: {
        parentThreadId: ThreadId.make("new-0"),
        relationshipToParent: "fork",
        rootThreadId: ThreadId.make("new-0"),
        sideChat: true,
      },
    });
    const result = omit([
      ...newest,
      sideChat,
      row("old", 30),
      row("b-old", 40),
      row("unsettled", null),
    ]);
    expect(result.threads.map((thread) => thread.id)).toEqual([
      ...newest.map((thread) => thread.id),
      "side-chat",
      "unsettled",
    ]);
    expect(result.olderSettled).toEqual({
      before: DateTime.formatIso(DateTime.makeUnsafe(100 * DAY - 2.4 * DAY)),
      asOfSequence: 7,
      counts: [
        { projectId: "project-a", count: 1 },
        { projectId: "project-b", count: 1 },
      ],
    });
  });

  it("counts the reader's own older threads in team mode, a missing owner being the server owner's", () => {
    const owner = MemberId.make("member-owner");
    const alice = MemberId.make("member-alice");
    const threads = [
      ...newest,
      row("old", 30),
      row("alices", 30, { ownerId: alice }),
      row("b-alices", 40, { ownerId: alice }),
      row("b-owners", 40, { ownerId: owner }),
    ];
    const ownCounts = (memberId: MemberId, followed: ReadonlyArray<string> = []) =>
      omitOlderSettledShells({
        threads,
        snapshotSequence: 7,
        now,
        reader: {
          memberId,
          serverOwnerId: owner,
          followedThreadIds: new Set(followed.map((id) => ThreadId.make(id))),
        },
      }).olderSettled.ownCounts;
    expect(ownCounts(alice)).toEqual([
      { projectId: "project-a", count: 1 },
      { projectId: "project-b", count: 1 },
    ]);
    expect(ownCounts(alice, ["b-owners"])).toEqual([
      { projectId: "project-a", count: 1 },
      { projectId: "project-b", count: 2 },
    ]);
    expect(ownCounts(owner)).toEqual([
      { projectId: "project-a", count: 1 },
      { projectId: "project-b", count: 1 },
    ]);
    expect(omit(threads).olderSettled).not.toHaveProperty("ownCounts");
  });

  it("keeps threads tied with the 25th newest", () => {
    const result = omit([...newest, row("tie", 2.4), row("older", 2.5)]);
    expect(result.threads.map((thread) => thread.id).slice(25)).toEqual(["tie"]);
  });

  it("omits nothing with fewer than 25 settled threads, however old", () => {
    const old = Array.from({ length: 5 }, (_, index) => row(`old-${index}`, 300 + index));
    const result = omit(old);
    expect(result.threads).toEqual(old);
    expect(result.olderSettled.counts).toEqual([]);
  });

  it("keeps older rows that are snoozed, live, or above a kept subagent or side chat, and still counts them", () => {
    const threads = [
      ...newest,
      row("snoozed", 30, { snoozedUntil: DateTime.makeUnsafe(101 * DAY) }),
      row("woke", 30, { snoozedUntil: DateTime.makeUnsafe(99 * DAY) }),
      row("running", 30, { activityRunStatus: "running" }),
      row("parent", 30),
      shellFixture({
        id: ThreadId.make("child"),
        projectId: ProjectId.make("project-a"),
        lineage: {
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("parent"),
        },
        settledOverride: null,
        settledAt: null,
      }),
      row("side-chat-parent", 30),
      row("side-chat", null, {
        lineage: {
          parentThreadId: ThreadId.make("side-chat-parent"),
          relationshipToParent: "fork",
          rootThreadId: ThreadId.make("side-chat-parent"),
          sideChat: true,
        },
      }),
    ];
    const result = omit(threads);
    expect(result.threads.map((thread) => thread.id).slice(25)).toEqual([
      "snoozed",
      "running",
      "parent",
      "child",
      "side-chat-parent",
      "side-chat",
    ]);
    expect(result.olderSettled.counts).toEqual([{ projectId: "project-a", count: 5 }]);
  });
});

describe("shellStreamItemsFromInitialSnapshot", () => {
  it("keeps thread rows out of the metadata-only enrichment frame", () => {
    const snapshot = {
      ...emptyShellSnapshot,
      projects: [
        { id: "project-a", workspaceRoot: "/workspace/a" },
        { id: "project-b", workspaceRoot: "/workspace/b" },
      ],
      threads: [shellFixture({})],
      archivedThreads: [shellFixture({ id: ThreadId.make("thread-archived"), archivedAt: null })],
    } as unknown as OrchestrationV2ShellSnapshot;

    const items = shellStreamItemsFromInitialSnapshot({
      snapshot,
      resolvedRepositoryIdentityRoots: ["/workspace/a"],
    });

    expect(items[0]).toEqual({ kind: "snapshot", snapshot });
    expect(items[1]).toMatchObject({
      kind: "snapshot",
      snapshot: {
        projects: [{ id: "project-a", workspaceRoot: "/workspace/a" }],
        threads: [],
        archivedThreads: [],
      },
      resolvedRepositoryIdentityRoots: ["/workspace/a"],
    });
    expect(JSON.stringify(items[1]).length).toBeLessThan(JSON.stringify(items[0]).length);
  });
});

describe("composeShellStreamWithEnrichment", () => {
  it.effect("preserves pending repository resolutions while an enrichment ACK is withheld", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Match ProjectEnrichmentService's sliding notifications and the WS batching path.
        const changes = yield* Effect.acquireRelease(
          PubSub.sliding<{ readonly workspaceRoot: string }>(256),
          PubSub.shutdown,
        );
        const subscription = yield* PubSub.subscribe(changes);
        const pull = yield* Stream.toPull(
          composeShellStreamWithEnrichment({
            initial: Stream.empty,
            tail: Stream.empty,
            enrichment: Stream.fromSubscription(subscription).pipe(
              Stream.groupedWithin(64, Duration.millis(25)),
              Stream.map((changes) =>
                shellStreamItemFromEnrichmentRefresh({
                  snapshot: emptyShellSnapshot,
                  changes,
                }),
              ),
            ),
          }),
        );

        const firstRoots = Array.from({ length: 64 }, (_, index) => `/workspace/first-${index}`);
        yield* PubSub.publishAll(
          changes,
          firstRoots.map((workspaceRoot) => ({ workspaceRoot })),
        );
        expect(yield* pull).toMatchObject([{ resolvedRepositoryIdentityRoots: firstRoots }]);

        // The next completion can be batched before the client acknowledges the first.
        yield* PubSub.publish(changes, { workspaceRoot: "/workspace/pending" });
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(25));
        const laterRoots = Array.from({ length: 256 }, (_, index) => `/workspace/later-${index}`);
        yield* PubSub.publishAll(
          changes,
          laterRoots.map((workspaceRoot) => ({ workspaceRoot })),
        );

        const resumed = yield* Stream.fromPull(Effect.succeed(pull)).pipe(
          Stream.takeUntil(
            (item) =>
              item.resolvedRepositoryIdentityRoots?.includes("/workspace/later-255") ?? false,
          ),
          Stream.runCollect,
        );
        expect(resumed.flatMap((item) => item.resolvedRepositoryIdentityRoots ?? [])).toEqual([
          "/workspace/pending",
          ...laterRoots,
        ]);
      }),
    ),
  );

  it.effect("keeps a merged shell batch charged while the client withholds its ACK", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const update = yield* Deferred.make<void>();
        const closed = yield* Deferred.make<void>();
        const initial = {
          kind: "thread.removed" as const,
          sequence: 1,
          location: "active" as const,
          threadId: ThreadId.make("thread-a"),
        };
        const pull = yield* Stream.toPull(
          composeShellStreamWithEnrichment({
            initial: Stream.empty,
            tail: bufferShellLiveStream(
              Stream.concat(
                Stream.succeed(initial),
                Stream.fromEffect(Deferred.await(update)).pipe(
                  Stream.map(() => ({ ...initial, sequence: 2 })),
                ),
              ).pipe(Stream.ensuring(Deferred.succeed(closed, undefined))),
              { maxItems: 1 },
            ),
            enrichment: Stream.empty,
          }),
        );
        expect(yield* pull).toEqual([initial]);
        // Let the merge producer run while the client still withholds its ACK.
        yield* Effect.yieldNow;
        yield* Deferred.succeed(update, undefined);
        yield* Deferred.await(closed);
        const result = yield* Stream.fromPull(Effect.succeed(pull)).pipe(
          Stream.runDrain,
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure._tag).toBe("LiveStreamBufferError");
      }),
    ),
  );

  it.effect(
    "emits every initial item before enrichment even when enrichment is already ready",
    () =>
      Effect.gen(function* () {
        const initialSnapshot = {
          ...emptyShellSnapshot,
          snapshotSequence: 5,
        } as OrchestrationV2ShellSnapshot;
        const enrichmentSnapshot = {
          ...emptyShellSnapshot,
          snapshotSequence: 10,
        } as OrchestrationV2ShellSnapshot;

        const initialItems = shellStreamItemsFromInitialSnapshot({
          snapshot: initialSnapshot,
          resolvedRepositoryIdentityRoots: ["/workspace/a"],
        });
        const enrichment = Stream.make(
          shellStreamItemFromEnrichmentRefresh({
            snapshot: enrichmentSnapshot,
            changes: [{ workspaceRoot: "/workspace/b" }],
          }),
        );
        const tail = Stream.make(
          { kind: "synchronized" as const },
          {
            kind: "project.removed" as const,
            sequence: 6,
            projectId: "project-a",
          },
        );

        const items = Array.from(
          yield* composeShellStreamWithEnrichment({
            initial: Stream.fromIterable(initialItems),
            tail,
            enrichment,
          }).pipe(Stream.runCollect),
        );

        expect(items.slice(0, initialItems.length)).toEqual(initialItems);

        const enrichmentIndex = items.findIndex(
          (item) =>
            item.kind === "snapshot" &&
            "resolvedRepositoryIdentityRoots" in item &&
            item.resolvedRepositoryIdentityRoots?.includes("/workspace/b"),
        );
        expect(enrichmentIndex).toBeGreaterThanOrEqual(initialItems.length);

        for (let index = 0; index < initialItems.length; index++) {
          expect(items[index]).toEqual(initialItems[index]);
        }
      }),
  );
});

describe("dedupeShellEnrichment", () => {
  const project = {
    id: ProjectId.make("project-a"),
    title: "A project",
    workspaceRoot: "/workspace/a",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
  const initial = {
    kind: "snapshot" as const,
    snapshot: { ...emptyShellSnapshot, projects: [project] },
  };
  const marked = { ...initial, resolvedRepositoryIdentityRoots: [project.workspaceRoot] };

  it.effect(
    "keeps initial/resume resolution and real changes but drops sequence-only repeats",
    () =>
      Effect.gen(function* () {
        const repeated = {
          ...marked,
          snapshot: { ...marked.snapshot, snapshotSequence: 10, projects: [{ ...project }] },
        };
        const progressed = {
          ...repeated,
          resolvedRepositoryIdentityRoots: [project.workspaceRoot, "/workspace/b"],
        };
        const changed = {
          ...progressed,
          snapshot: { ...progressed.snapshot, projects: [{ ...project, title: "Renamed" }] },
        };
        const items = yield* Stream.make(
          initial,
          marked,
          repeated,
          progressed,
          changed,
          changed,
        ).pipe(dedupeShellEnrichment, Stream.runCollect);
        expect(items).toEqual([initial, marked, progressed, changed]);
        const resumed = Stream.make(marked, repeated).pipe(dedupeShellEnrichment);
        expect(yield* Stream.runCollect(resumed)).toEqual([marked]);
        expect(yield* Stream.runCollect(resumed)).toEqual([marked]);
      }),
  );

  it.effect("keeps authoritative snapshots and invalidates metadata after project deltas", () =>
    Effect.gen(function* () {
      const removed = { kind: "project.removed" as const, projectId: project.id, sequence: 2 };
      const updated = { kind: "project.updated" as const, project, sequence: 3 };
      const withThreads = {
        ...marked,
        snapshot: { ...marked.snapshot, threads: [shellFixture({})] },
      };
      const values = [
        initial,
        initial,
        marked,
        removed,
        marked,
        updated,
        marked,
        withThreads,
        withThreads,
      ];
      expect(
        yield* Stream.fromIterable(values).pipe(dedupeShellEnrichment, Stream.runCollect),
      ).toEqual(values);
    }),
  );

  it.effect(
    "deduplicates across thread deltas without dropping those deltas or identity clears",
    () =>
      Effect.gen(function* () {
        const delta = {
          kind: "thread.removed" as const,
          threadId: ThreadId.make("thread-a"),
          location: "active" as const,
          sequence: 2,
        };
        const resolved = {
          ...marked,
          snapshot: {
            ...marked.snapshot,
            projects: [
              {
                ...project,
                repositoryIdentity: {
                  canonicalKey: "github.com/test/repo",
                  locator: {
                    source: "git-remote" as const,
                    remoteName: "origin",
                    remoteUrl: "https://github.com/test/repo.git",
                  },
                },
              },
            ],
          },
        };
        expect(
          yield* Stream.make(marked, delta, marked, resolved, marked).pipe(
            dedupeShellEnrichment,
            Stream.runCollect,
          ),
        ).toEqual([marked, delta, resolved, marked]);
      }),
  );
});

describe("skipUnchangedThreadShells", () => {
  const at = (ms: number) => DateTime.makeUnsafe(Date.parse("2026-10-01T00:00:00.000Z") + ms);
  const shell = (
    id: string,
    overrides: Partial<OrchestrationV2ThreadShell> = {},
  ): OrchestrationV2ThreadShell => ({
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-a"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 1,
    visibleItemCount: 1,
    branch: null,
    status: "running",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestUserMessageAt: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...overrides,
  });
  type Step =
    | { readonly advanceMs: number }
    | Exclude<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" | "synchronized" }>;
  const updated = (sequence: number, thread: OrchestrationV2ThreadShell): Step => ({
    kind: "thread.updated",
    sequence,
    location: "active",
    thread,
  });
  const run = (steps: ReadonlyArray<Step>) =>
    Stream.fromIterable(steps).pipe(
      Stream.mapEffect((step) =>
        "advanceMs" in step
          ? TestClock.adjust(Duration.millis(step.advanceMs)).pipe(Effect.as(null))
          : Effect.succeed(step),
      ),
      Stream.filter((item) => item !== null),
      skipUnchangedThreadShells,
      Stream.runCollect,
      Effect.map((items) => Array.from(items, (item) => ("sequence" in item ? item.sequence : -1))),
    );

  it.effect("sends the next update after a removal", () =>
    Effect.gen(function* () {
      const sent = yield* run([
        updated(1, shell("a")),
        { kind: "thread.removed", sequence: 2, location: "active", threadId: ThreadId.make("a") },
        updated(3, shell("a")),
      ]);
      expect(sent).toEqual([1, 2, 3]);
    }),
  );
});
