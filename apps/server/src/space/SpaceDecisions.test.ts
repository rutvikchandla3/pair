import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MemberId,
  MessageId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type Space,
  type SpaceAction,
  SpaceActionId,
  SpaceId,
  type SpaceRoomEntry,
  type SpaceTask,
  SpaceTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  decideSpaceCommand,
  type SpaceCommandInput,
  type SpaceCoreCommand,
  type SpaceDecision,
  decideThreadLink,
  type SpaceThreadLinkDecision,
  type SpaceThreadLinkInput,
} from "./SpaceDecisions.ts";

const owner = MemberId.make("member:owner");
const member = MemberId.make("member:member");
const outsider = MemberId.make("member:outsider");
const spaceId = SpaceId.make("spc_0123456789abcdef0123");
const roomThreadId = ThreadId.make("thread:room");
const now = "2026-11-12T10:00:00.000Z";

const space: Space = {
  id: spaceId,
  roomThreadId,
  name: "Question creation",
  brief: "",
  repositoryIds: [ProjectId.make("project:a")],
  projectId: ProjectId.make("project:a"),
  ownerId: owner,
  members: [
    { memberId: owner, joinedAt: now, addedBy: null, removedAt: null },
    { memberId: member, joinedAt: now, addedBy: owner, removedAt: null },
  ],
  joinRequests: [],
  createdBy: owner,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  archivedBy: null,
};

type Change = { readonly type: SpaceCoreCommand["type"] } & Record<string, unknown>;
const decide = (change: Change, actorId: MemberId, at: Space = space): SpaceDecision =>
  decideSpaceCommand({
    command: {
      commandId: CommandId.make("command"),
      threadId: roomThreadId,
      spaceId,
      actorId,
      ...change,
    } as SpaceCoreCommand,
    space: at,
    now,
  });
const outcome = (decision: SpaceDecision | SpaceThreadLinkDecision) =>
  decision._tag === "Refuse" ? decision.reason : decision._tag;

const post: Change = {
  type: "space.post",
  messageId: MessageId.make("message:1"),
  text: "hello",
  mentions: [],
  authorKind: "user",
};

// The "Who can do what" table in docs/product/spaces.md.
const table: ReadonlyArray<readonly [string, Change, string, string, string]> = [
  // action, change, owner, member, non-member
  ["post", post, "Accept", "Accept", "not-member"],
  ["edit the Brief", { type: "space.update", brief: "New" }, "Accept", "Accept", "not-member"],
  ["rename", { type: "space.update", name: "Renamed" }, "Accept", "not-owner", "not-member"],
  [
    "change the repositories",
    {
      type: "space.update",
      repositoryIds: [ProjectId.make("project:b")],
      projectId: ProjectId.make("project:b"),
    },
    "Accept",
    "not-owner",
    "not-member",
  ],
  [
    "change the repositories without the project",
    { type: "space.update", repositoryIds: [ProjectId.make("project:b")] },
    "not-allowed",
    "not-allowed",
    "not-member",
  ],
  [
    "add members",
    { type: "space.member.add", memberIds: [outsider] },
    "Accept",
    "not-owner",
    "not-owner",
  ],
  [
    "remove members",
    { type: "space.member.remove", memberId: member },
    "Accept",
    "not-owner",
    "not-owner",
  ],
  [
    "transfer ownership",
    { type: "space.owner.transfer", ownerId: member },
    "Accept",
    "not-owner",
    "not-owner",
  ],
  ["archive", { type: "space.archive" }, "Accept", "not-owner", "not-owner"],
  ["leave", { type: "space.leave" }, "owner-cannot-leave", "Accept", "NoOp"],
  ["request to join", { type: "space.join.request" }, "NoOp", "NoOp", "Accept"],
  ["cancel a request", { type: "space.join.cancel" }, "no-request", "no-request", "no-request"],
];

describe("decideSpaceCommand", () => {
  it.each(table)("%s", (_action, change, asOwner, asMember, asOutsider) => {
    expect([
      outcome(decide(change, owner)),
      outcome(decide(change, member)),
      outcome(decide(change, outsider)),
    ]).toEqual([asOwner, asMember, asOutsider]);
  });

  it("an archived space is read-only except for its owner's unarchive", () => {
    const archived = { ...space, archivedAt: now, archivedBy: owner };
    expect(outcome(decide(post, member, archived))).toBe("archived");
    expect(outcome(decide({ type: "space.update", brief: "x" }, owner, archived))).toBe("archived");
    expect(outcome(decide({ type: "space.unarchive" }, member, archived))).toBe("not-owner");
    expect(outcome(decide({ type: "space.unarchive" }, owner, archived))).toBe("Accept");
  });

  it("only a person's post tags @pair, and mentions keep active members only", () => {
    const tag = { ...post, mentions: [{ type: "pair" }, { type: "pair" }] };
    const human = decide(tag, member);
    const agent = decide({ ...tag, authorKind: "agent" }, member);
    expect(human._tag === "Accept" ? human.pairReply : null).toEqual({
      postId: "message:1",
      taggerId: member,
    });
    expect(agent._tag === "Accept" ? agent.pairReply : "refused").toBeNull();
    const mentions = decide(
      {
        ...post,
        mentions: [
          { type: "member", memberId: outsider },
          { type: "member", memberId: owner },
        ],
      },
      member,
    );
    expect(
      mentions._tag === "Accept" && mentions.entries[0]?.type === "post"
        ? mentions.entries[0].mentions
        : null,
    ).toEqual([{ type: "member", memberId: owner }]);
  });

  it("a removed member who comes back by Undo keeps their joinedAt; a re-add does not", () => {
    const removed: Space = {
      ...space,
      members: [
        space.members[0]!,
        { ...space.members[1]!, joinedAt: "2026-01-01T00:00:00.000Z", removedAt: now },
      ],
    };
    const joinedAt = (decision: SpaceDecision) =>
      decision._tag === "Accept"
        ? decision.space?.members.find((m) => m.memberId === member)?.joinedAt
        : null;
    expect(
      joinedAt(
        decide({ type: "space.member.add", memberIds: [member], restore: true }, owner, removed),
      ),
    ).toBe("2026-01-01T00:00:00.000Z");
    expect(
      joinedAt(decide({ type: "space.member.add", memberIds: [member] }, owner, removed)),
    ).toBe(now);
    expect(outcome(decide(post, member, removed))).toBe("not-member");
  });
});

const other = MemberId.make("member:other");
const teamSpace: Space = {
  ...space,
  members: [...space.members, { memberId: other, joinedAt: now, addedBy: owner, removedAt: null }],
};
const taskId = SpaceTaskId.make("stk_0123456789abcdef0123");
const createdAt = "2026-11-11T10:00:00.000Z";
const task: SpaceTask = {
  id: taskId,
  spaceId,
  title: "Fix the flaky test",
  description: "It fails on CI.",
  ownerId: member,
  createdBy: owner,
  createdAt,
  assignedBy: owner,
  status: "todo",
  statusVersion: 1,
  statusChangedAt: createdAt,
  statusChangedBy: { type: "member", memberId: owner },
  handedBack: null,
  remindedAt: null,
  via: null,
  updatedAt: createdAt,
  deletedAt: null,
};
const via = { runId: RunId.make("run:pair"), roomMessageId: MessageId.make("message:tag") };
const actionId = SpaceActionId.make("action:1");

const decideTask = (
  change: Record<string, unknown>,
  actorId: MemberId,
  extra: Partial<Omit<SpaceCommandInput, "command" | "now">> = {},
) =>
  decideSpaceCommand({
    command: {
      commandId: CommandId.make("command"),
      threadId: roomThreadId,
      spaceId,
      actorId,
      ...change,
    } as SpaceCoreCommand,
    space: teamSpace,
    task,
    now,
    ...extra,
  });
const update = (change: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
  type: "space.task.update",
  taskId,
  change,
  ...more,
});
const create = (more: Record<string, unknown> = {}) => ({
  type: "space.task.create",
  taskId,
  title: "Write the docs",
  description: "For Spaces.",
  ownerId: other,
  status: "todo",
  ...more,
});
const accepted = (decision: SpaceDecision) => {
  if (decision._tag !== "Accept") throw new Error(`expected Accept, got ${outcome(decision)}`);
  return decision;
};
const asMember = (memberId: MemberId) => ({ type: "member", memberId });

// spaces.md "Tasks": task creator (owner), task owner (member), another member, a non-member.
const taskTable: ReadonlyArray<
  readonly [string, Record<string, unknown>, string, string, string, string]
> = [
  [
    "edit",
    update({ type: "edit", title: "Renamed" }),
    "Accept",
    "Accept",
    "not-task-creator",
    "not-member",
  ],
  [
    "reassign",
    update({ type: "reassign", ownerId: other }),
    "Accept",
    "Accept",
    "not-task-creator",
    "not-member",
  ],
  [
    "reassign to a non-member",
    update({ type: "reassign", ownerId: outsider }),
    "not-a-target-member",
    "not-a-target-member",
    "not-task-creator",
    "not-member",
  ],
  [
    "hand back",
    update({ type: "hand-back", reason: "Blocked" }),
    "not-task-owner",
    "Accept",
    "not-task-owner",
    "not-member",
  ],
  [
    "remind",
    update({ type: "remind" }),
    "Accept",
    "not-task-creator",
    "not-task-creator",
    "not-member",
  ],
  [
    "move the status",
    update({ type: "status", status: "in-progress", by: asMember(owner), askedBy: null }),
    "Accept",
    "Accept",
    "Accept",
    "not-member",
  ],
  [
    "move to the same status",
    update({ type: "status", status: "todo", by: asMember(owner), askedBy: null }),
    "NoOp",
    "NoOp",
    "NoOp",
    "not-member",
  ],
  [
    "delete a person's task",
    update({ type: "delete" }),
    "not-undoable",
    "not-undoable",
    "not-undoable",
    "not-member",
  ],
  ["create", create(), "already-exists", "already-exists", "already-exists", "already-exists"],
];

describe("space tasks", () => {
  it.each(taskTable)("%s", (_action, change, ...expected) => {
    expect(
      [owner, member, other, outsider].map((actor) => outcome(decideTask(change, actor))),
    ).toEqual(expected);
  });

  it("refuses a task that is missing, deleted or another space's, and any task when archived", () => {
    const edit = update({ type: "edit", title: "Renamed" });
    expect(outcome(decideTask(edit, owner, { task: null }))).toBe("not-a-task");
    expect(outcome(decideTask(edit, owner, { task: { ...task, deletedAt: now } }))).toBe(
      "not-a-task",
    );
    expect(
      outcome(
        decideTask(edit, owner, {
          task: { ...task, spaceId: SpaceId.make("spc_00000000000000000000") },
        }),
      ),
    ).toBe("not-a-task");
    const archived = { ...teamSpace, archivedAt: now, archivedBy: owner };
    expect(outcome(decideTask(edit, owner, { space: archived }))).toBe("archived");
    expect(outcome(decideTask(create(), owner, { space: archived, task: null }))).toBe("archived");
  });

  it("creates a task with its line, a status line when it starts past To do, and Pair's record", () => {
    const plain = accepted(decideTask(create(), member, { task: null }));
    expect(plain.tasks).toEqual([
      expect.objectContaining({ ownerId: other, createdBy: member, assignedBy: member, via: null }),
    ]);
    expect(plain.entries.map((entry) => entry.type === "system" && entry.line.type)).toEqual([
      "task-created",
    ]);
    const started = accepted(decideTask(create({ status: "in-progress" }), member, { task: null }));
    expect(started.entries.map((entry) => entry.type === "system" && entry.line.type)).toEqual([
      "task-created",
      "task-status",
    ]);
    expect(new Set(started.entries.map((entry) => entry.id)).size).toBe(2);
    expect(outcome(decideTask(create({ ownerId: outsider }), member, { task: null }))).toBe(
      "not-a-target-member",
    );

    expect(outcome(decideTask(create({ via }), member, { task: null }))).toBe("not-allowed");
    const byPair = create({ via, spaceActionId: actionId });
    expect(outcome(decideTask(byPair, member, { task: null, othersThisReply: 1 }))).toBe(
      "over-limit",
    );
    const recorded = accepted(decideTask(byPair, member, { task: null }));
    expect(recorded.actions).toEqual([
      expect.objectContaining({
        id: actionId,
        state: "done",
        outcome: expect.objectContaining({
          type: "task.created",
          taskId,
          threadId: null,
          started: false,
        }),
      }),
    ]);
  });

  it("reassigning or handing back moves the owner and who gave it", () => {
    const reminded = { ...task, remindedAt: now };
    const reassigned = accepted(
      decideTask(update({ type: "reassign", ownerId: other }), member, { task: reminded }),
    );
    expect(reassigned.tasks[0]).toMatchObject({
      ownerId: other,
      assignedBy: member,
      handedBack: null,
      remindedAt: null,
    });
    const taken = accepted(
      decideTask(update({ type: "reassign", ownerId: other }), other, {
        task: { ...task, createdBy: other },
      }),
    );
    expect(taken.tasks[0]?.assignedBy).toBeNull();
    const handed = accepted(
      decideTask(update({ type: "hand-back", reason: "Blocked" }), member, { task: reminded }),
    );
    expect(handed.tasks[0]).toMatchObject({
      ownerId: owner,
      assignedBy: null,
      handedBack: { by: member, reason: "Blocked", at: now },
      remindedAt: null,
    });
    expect(
      outcome(
        decideTask(update({ type: "hand-back", reason: "Blocked" }), member, {
          task: { ...task, assignedBy: null },
        }),
      ),
    ).toBe("own-task");
  });

  it("an agent moves only a task its thread is on; Pair only within a recorded reply", () => {
    const agent = update({
      type: "status",
      status: "in-review",
      by: { type: "agent", threadId: ThreadId.make("thread:work") },
      askedBy: null,
    });
    expect(outcome(decideTask(agent, member))).toBe("not-a-task");
    expect(outcome(decideTask(agent, member, { agentThreadOnTask: true }))).toBe("Accept");
    const pairBy = { type: "pair", runId: via.runId, actionId };
    const pair = (more: Record<string, unknown>) =>
      update({ type: "status", status: "done", by: pairBy, askedBy: member }, more);
    expect(outcome(decideTask(pair({}), member))).toBe("not-allowed");
    expect(outcome(decideTask(pair({ via }), member))).toBe("not-allowed");
    const moved = accepted(decideTask(pair({ via, spaceActionId: actionId }), member));
    const line = moved.entries[0];
    expect(line?.type === "system" ? [line.actorId, line.line] : null).toEqual([
      member,
      expect.objectContaining({ type: "task-status", from: "todo", to: "done", version: 2 }),
    ]);
    expect(moved.tasks[0]).toMatchObject({
      status: "done",
      statusVersion: 2,
      statusChangedBy: pairBy,
    });
    expect(moved.actions[0]?.outcome).toMatchObject({
      type: "task.status.moved",
      entryId: line?.id,
    });
  });

  it("Undo restores a status only while it is still the latest move, and not a person's", () => {
    const pairBy = { type: "pair" as const, runId: via.runId, actionId };
    const statusLine = (
      by:
        | { readonly type: "pair"; readonly runId: RunId; readonly actionId: SpaceActionId }
        | { readonly type: "member"; readonly memberId: MemberId },
      undoOf: MessageId | null = null,
    ): SpaceRoomEntry =>
      ({
        type: "system",
        id: MessageId.make("space-line:move"),
        spaceId,
        actorId: member,
        line: {
          type: "task-status",
          taskId,
          from: "todo",
          to: "done",
          by,
          askedBy: member,
          version: 2,
          undoOf,
        },
        createdAt: now,
      }) as SpaceRoomEntry;
    const action = {
      id: actionId,
      state: "done",
      outcome: { type: "task.status.moved" },
    } as unknown as SpaceAction;
    const undo = update({ type: "status-undo", entryId: MessageId.make("space-line:move") });
    const done = { ...task, status: "done" as const, statusVersion: 2 };
    const restored = accepted(
      decideTask(undo, other, { task: done, undoLine: statusLine(pairBy), undoAction: action }),
    );
    expect(restored.tasks[0]).toMatchObject({
      status: "todo",
      statusVersion: 3,
      statusChangedBy: asMember(other),
    });
    expect(restored.entries[0]?.type === "system" && restored.entries[0].line).toMatchObject({
      from: "done",
      to: "todo",
      undoOf: "space-line:move",
      by: asMember(other),
    });
    expect(restored.actions).toEqual([expect.objectContaining({ state: "undone" })]);

    const later = { ...done, status: "in-review" as const, statusVersion: 3 };
    expect(outcome(decideTask(undo, other, { task: later, undoLine: statusLine(pairBy) }))).toBe(
      "not-undoable",
    );
    expect(
      outcome(
        decideTask(undo, other, { task: done, undoLine: statusLine(asMember(owner) as never) }),
      ),
    ).toBe("not-undoable");
    expect(
      outcome(
        decideTask(undo, other, {
          task: done,
          undoLine: statusLine(pairBy, MessageId.make("space-line:earlier")),
        }),
      ),
    ).toBe("not-undoable");
    expect(outcome(decideTask(undo, other, { task: done, undoLine: null }))).toBe("not-undoable");
  });

  it("Pair's created-task Undo deletes it only untouched, archiving the thread it started", () => {
    const started = ThreadId.make("thread:started");
    const byPair = { ...task, via };
    const createdAction = {
      id: actionId,
      outcome: { type: "task.created", taskId, threadId: started },
    } as unknown as SpaceAction;
    const del = update({ type: "delete" });
    const deleted = accepted(
      decideTask(del, member, { task: byPair, taskThreadIds: [started], createdAction }),
    );
    expect(deleted.tasks[0]?.deletedAt).toBe(now);
    expect(deleted.archiveThreadIds).toEqual([started]);
    expect(
      outcome(
        decideTask(del, member, {
          task: byPair,
          taskThreadIds: [started, ThreadId.make("thread:attached")],
          createdAction,
        }),
      ),
    ).toBe("not-undoable");
    expect(
      outcome(decideTask(del, member, { task: { ...byPair, updatedAt: now }, createdAction })),
    ).toBe("not-undoable");
    expect(
      outcome(decideTask(del, member, { task: { ...byPair, statusVersion: 2 }, createdAction })),
    ).toBe("not-undoable");
  });

  it("removing or leaving with reassignTo hands over the member's open tasks", () => {
    const mine = (id: string, status: SpaceTask["status"], ownerId: MemberId = member) => ({
      ...task,
      id: SpaceTaskId.make(id),
      status,
      ownerId,
      remindedAt: now,
    });
    const memberTasks = [
      mine("stk_00000000000000000001", "todo"),
      mine("stk_00000000000000000002", "in-review"),
      mine("stk_00000000000000000003", "done"),
      mine("stk_00000000000000000004", "todo", other),
    ];
    const removal = accepted(
      decideTask({ type: "space.member.remove", memberId: member, reassignTo: other }, owner, {
        memberTasks,
      }),
    );
    expect(
      removal.tasks.map((moved) => [moved.id, moved.ownerId, moved.assignedBy, moved.remindedAt]),
    ).toEqual([
      ["stk_00000000000000000001", other, owner, null],
      ["stk_00000000000000000002", other, owner, null],
    ]);
    expect(removal.entries[0]?.type === "system" && removal.entries[0].line).toEqual({
      type: "member-removed",
      memberId: member,
      reassignedTo: other,
      tasks: 2,
    });
    const leaving = accepted(
      decideTask({ type: "space.leave", reassignTo: other }, member, { memberTasks }),
    );
    expect(leaving.tasks).toHaveLength(2);
    expect(leaving.entries[0]?.type === "system" && leaving.entries[0].line).toEqual({
      type: "left",
      reassignedTo: other,
      tasks: 2,
    });
    expect(
      outcome(
        decideTask({ type: "space.member.remove", memberId: member, reassignTo: outsider }, owner, {
          memberTasks,
        }),
      ),
    ).toBe("not-a-target-member");
    const kept = accepted(decideTask({ type: "space.member.remove", memberId: member }, owner));
    expect(kept.tasks).toEqual([]);
  });
});

const workThreadId = ThreadId.make("thread:work");
const t0 = DateTime.makeUnsafe(now);
const workThread: OrchestrationV2AppThread = {
  createdBy: "user",
  creationSource: "web",
  id: workThreadId,
  projectId: ProjectId.make("project:a"),
  title: "Work",
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: workThreadId },
  forkedFrom: null,
  createdAt: t0,
  updatedAt: t0,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ownerId: member,
};
const otherSpace: Space = {
  ...teamSpace,
  id: SpaceId.make("spc_fedcba9876543210fedc"),
  roomThreadId: ThreadId.make("thread:other-room"),
};
const otherTask: SpaceTask = {
  ...task,
  id: SpaceTaskId.make("stk_fedcba9876543210fedc"),
  spaceId: otherSpace.id,
  ownerId: other,
};
const linked = (onSpace: Space = teamSpace, onTask: SpaceTask = task) => ({
  ...workThread,
  space: {
    kind: "task" as const,
    spaceId: onSpace.id,
    taskId: onTask.id,
    linkedBy: member,
    linkedAt: now,
    via: "attach" as const,
  },
});
const link = (
  actorId: MemberId,
  target: { readonly space: Space | null; readonly task: SpaceTask | null } | null,
  extra: Partial<Omit<SpaceThreadLinkInput, "command" | "now">> = {},
) =>
  decideThreadLink({
    command: {
      type: "space.thread.link",
      commandId: CommandId.make("command"),
      threadId: workThreadId,
      actorId,
      target:
        target === null
          ? null
          : { spaceId: target.space?.id ?? spaceId, taskId: target.task?.id ?? taskId },
      via: "attach",
    },
    thread: workThread,
    current: null,
    target,
    now,
    ...extra,
  });

describe("decideThreadLink", () => {
  it("attaches the owner's thread to a task in a space they're in", () => {
    const attached = link(member, { space: teamSpace, task });
    if (attached._tag !== "Accept") throw new Error(attached._tag);
    expect(attached.link).toEqual({
      kind: "task",
      spaceId,
      taskId,
      linkedBy: member,
      linkedAt: now,
      via: "attach",
    });
    expect(
      attached.entries.map(({ roomThreadId: room, entry }) => [
        room,
        entry.type === "system" && entry.line,
      ]),
    ).toEqual([
      [
        roomThreadId,
        {
          type: "task-thread-added",
          taskId,
          threadId: workThreadId,
          threadOwnerId: member,
          via: "attach",
        },
      ],
    ]);
    expect(outcome(link(owner, { space: teamSpace, task }))).toBe("not-thread-owner");
    const without = {
      ...teamSpace,
      members: teamSpace.members.filter((m) => m.memberId !== member),
    };
    expect(outcome(link(member, { space: without, task }))).toBe("not-member");
    expect(outcome(link(member, { space: teamSpace, task: { ...task, deletedAt: now } }))).toBe(
      "not-a-task",
    );
    expect(outcome(link(member, { space: teamSpace, task: null }))).toBe("not-a-task");
    expect(outcome(link(member, { space: null, task }))).toBe("not-found");
    expect(
      outcome(link(member, { space: { ...teamSpace, archivedAt: now, archivedBy: owner }, task })),
    ).toBe("archived");
    expect(
      outcome(
        link(member, { space: teamSpace, task }, { thread: { ...workThread, archivedAt: t0 } }),
      ),
    ).toBe("not-linkable");
    expect(
      outcome(
        link(
          member,
          { space: teamSpace, task },
          {
            thread: { ...workThread, space: { kind: "room", spaceId } },
          },
        ),
      ),
    ).toBe("not-linkable");
    expect(
      outcome(
        link(
          member,
          { space: teamSpace, task },
          {
            thread: linked(),
            current: { space: teamSpace, task },
          },
        ),
      ),
    ).toBe("NoOp");
  });

  it("a move across spaces leaves a line in each room, and needs the owner in the new space", () => {
    const moved = link(
      member,
      { space: otherSpace, task: otherTask },
      {
        thread: linked(),
        current: { space: teamSpace, task },
      },
    );
    if (moved._tag !== "Accept") throw new Error(moved._tag);
    expect(moved.link?.spaceId).toBe(otherSpace.id);
    expect(
      moved.entries.map(({ roomThreadId: room, entry }) => [
        room,
        entry.type === "system" ? entry.line.type : null,
        entry.type === "system" && entry.line.type === "task-thread-added" ? entry.line.via : null,
      ]),
    ).toEqual([
      [roomThreadId, "task-thread-removed", null],
      [otherSpace.roomThreadId, "task-thread-added", "move"],
    ]);
    expect(new Set(moved.entries.map(({ entry }) => entry.id)).size).toBe(2);
    const notIn = {
      ...otherSpace,
      members: otherSpace.members.filter((m) => m.memberId !== member),
    };
    expect(
      outcome(
        link(
          member,
          { space: notIn, task: otherTask },
          {
            thread: linked(),
            current: { space: teamSpace, task },
          },
        ),
      ),
    ).toBe("not-member");
  });

  it("the thread's, task's or space's owner removes it; only the thread's owner when archived", () => {
    const remove = (actorId: MemberId, onSpace: Space = teamSpace) =>
      outcome(link(actorId, null, { thread: linked(onSpace), current: { space: onSpace, task } }));
    // member owns the thread and the task; give the task to other to tell them apart.
    const byOther = (actorId: MemberId, onSpace: Space = teamSpace) =>
      outcome(
        link(actorId, null, {
          thread: linked(onSpace),
          current: { space: onSpace, task: { ...task, ownerId: other } },
        }),
      );
    expect([remove(member), byOther(other), byOther(owner), byOther(outsider)]).toEqual([
      "Accept",
      "Accept",
      "Accept",
      "not-thread-owner",
    ]);
    const archived = { ...teamSpace, archivedAt: now, archivedBy: owner };
    expect([remove(member, archived), byOther(other, archived)]).toEqual(["Accept", "archived"]);
    const removed = link(member, null, { thread: linked(), current: { space: teamSpace, task } });
    if (removed._tag !== "Accept") throw new Error(removed._tag);
    expect(removed.link).toBeNull();
    expect(removed.entries[0]?.entry.type === "system" && removed.entries[0].entry.line).toEqual({
      type: "task-thread-removed",
      taskId,
      threadId: workThreadId,
      threadOwnerId: member,
    });
    expect(outcome(link(member, null))).toBe("NoOp");
  });
});
