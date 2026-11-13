import {
  MemberId,
  MessageId,
  ProjectId,
  RunId,
  RuntimeRequestId,
  type Space,
  SpaceActionId,
  SpaceId,
  type SpaceRoomEntry,
  type SpaceSystemLine,
  type SpaceTask,
  SpaceTaskId,
  type TeamClaudeKeyStatus,
  type TeamMember,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  PAIR_MENTION,
  applySpaceRoomEvent,
  groupSpaceOverview,
  insertSpaceMention,
  joinedSpaceOlderEntries,
  mergeSpaceRoomView,
  orderSpaceMembers,
  resolveSpaceMentions,
  spaceAskAdmin,
  spaceAskTargetSpace,
  spaceComposerHint,
  spaceConfirmCopy,
  spaceConfirmMutation,
  spaceConfirmUndo,
  spaceControls,
  spaceFeedRows,
  spaceHeaderWorkspaceLabel,
  spaceListWithRoom,
  spaceLiveTask,
  spaceMentionCandidates,
  spaceMentionQuery,
  spaceMergedSuggestion,
  spaceNewDividerIndex,
  spaceRecordText,
  spaceSidebarTasks,
  spaceStatusUndo,
  spaceTaskActivity,
  spaceTaskAssignedAt,
  spaceTaskControls,
  spaceTaskEntries,
  spaceThreadsByTask,
  spaceUndoneEntryIds,
  spaceWorkspaceLine,
  splitSpacePostText,
  type SpaceMentionToken,
  type SpaceRecordContext,
  type SpaceRoomMemberState,
  type SpaceTaskLineEntry,
} from "./spaces.ts";
import { v2ThreadShell } from "./state/orchestrationV2TestFixtures.ts";

const rutvik = MemberId.make("mem-rutvik");
const kousik = MemberId.make("mem-kousik");
const hanad = MemberId.make("mem-hanad");
const NAMES: Record<string, string> = {
  [rutvik]: "Rutvik",
  [kousik]: "Kousik",
  [hanad]: "Hanad Ali",
};
const viewer = { memberId: rutvik, nameOf: (id: MemberId) => NAMES[id] ?? "Former member" };
const spaceId = SpaceId.make("spc_0123456789abcdef0123");

const space: Space = {
  id: spaceId,
  roomThreadId: ThreadId.make("room"),
  name: "Question creation",
  brief: "",
  repositoryIds: [v2ThreadShell.projectId],
  projectId: v2ThreadShell.projectId,
  ownerId: kousik,
  members: [
    { memberId: hanad, joinedAt: "2026-11-10T10:00:00.000Z", addedBy: kousik, removedAt: null },
    { memberId: rutvik, joinedAt: "2026-11-10T09:00:00.000Z", addedBy: kousik, removedAt: null },
    { memberId: kousik, joinedAt: "2026-11-10T11:00:00.000Z", addedBy: null, removedAt: null },
    {
      memberId: MemberId.make("mem-gone"),
      joinedAt: "2026-11-10T08:00:00.000Z",
      addedBy: kousik,
      removedAt: "2026-11-11T08:00:00.000Z",
    },
  ],
  joinRequests: [],
  createdBy: kousik,
  createdAt: "2026-11-10T09:00:00.000Z",
  updatedAt: "2026-11-10T09:00:00.000Z",
  archivedAt: null,
  archivedBy: null,
};

const kousikToken: SpaceMentionToken = {
  mention: { type: "member", memberId: kousik },
  label: "Kousik",
};

describe("space mentions", () => {
  it("finds the query only at a word start, up to the caret", () => {
    expect(spaceMentionQuery("hi @Kou", 7)).toEqual({ start: 3, end: 7, query: "Kou" });
    expect(spaceMentionQuery("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(spaceMentionQuery("mail me@host", 12)).toBeNull();
    expect(spaceMentionQuery("@Kousik said", 12)).toBeNull();
  });

  it("offers @pair first and leaves out the viewer and removed members", () => {
    expect(spaceMentionCandidates("", space, viewer).map((token) => token.label)).toEqual([
      "pair",
      "Kousik",
      "Hanad Ali",
    ]);
    expect(spaceMentionCandidates("al", space, viewer).map((token) => token.label)).toEqual([
      "Hanad Ali",
    ]);
    expect(spaceMentionCandidates("ru", space, viewer)).toEqual([]);
  });

  it("inserts a token and keeps only tokens whose text survives", () => {
    const query = spaceMentionQuery("ask @Ko now", 7);
    expect(query).not.toBeNull();
    const inserted = insertSpaceMention("ask @Ko now", query!, kousikToken);
    expect(inserted).toEqual({ text: "ask @Kousik now", caret: 12 });

    const tokens = [kousikToken, PAIR_MENTION, kousikToken];
    expect(resolveSpaceMentions("@Kousik and @pair", tokens)).toEqual([
      { type: "member", memberId: kousik },
      { type: "pair" },
    ]);
    // Edited away, or no longer a whole token.
    expect(resolveSpaceMentions("@Kousikk and pair", tokens)).toEqual([]);
  });

  it("splits a post into text and its mention tokens only", () => {
    expect(
      splitSpacePostText(
        "@Kousik @Hanad Ali ok, @pair? @Ankur",
        [
          { type: "member", memberId: kousik },
          { type: "member", memberId: hanad },
          { type: "pair" },
        ],
        viewer.nameOf,
      ),
    ).toEqual([
      { type: "mention", mention: { type: "member", memberId: kousik }, text: "@Kousik" },
      { type: "text", text: " " },
      { type: "mention", mention: { type: "member", memberId: hanad }, text: "@Hanad Ali" },
      { type: "text", text: " ok, " },
      { type: "mention", mention: { type: "pair" }, text: "@pair" },
      { type: "text", text: "? @Ankur" },
    ]);
  });

  it("says who hears about the post", () => {
    expect(spaceComposerHint([], viewer)).toBeNull();
    expect(
      spaceComposerHint(
        [
          { type: "member", memberId: kousik },
          { type: "member", memberId: hanad },
        ],
        viewer,
      ),
    ).toBe("Kousik and Hanad Ali will be notified");
    expect(spaceComposerHint([{ type: "pair" }], viewer)).toBe("Pair replies here");
  });
});

describe("space members", () => {
  it("puts the owner first, then active members by join time", () => {
    expect(orderSpaceMembers(space).map((member) => member.memberId)).toEqual([
      kousik,
      rutvik,
      hanad,
    ]);
  });
});

const taskId = (n: number) => SpaceTaskId.make(`stk_${String(n).padStart(20, "0")}`);
const spaceTask = (n: number, patch: Partial<SpaceTask> = {}): SpaceTask => ({
  id: taskId(n),
  spaceId,
  title: `Task ${n}`,
  description: "Do it",
  ownerId: hanad,
  createdBy: hanad,
  createdAt: "2026-11-10T09:00:00.000Z",
  assignedBy: null,
  status: "in-progress",
  statusVersion: 1,
  statusChangedAt: "2026-11-10T09:00:00.000Z",
  statusChangedBy: { type: "member", memberId: hanad },
  handedBack: null,
  remindedAt: null,
  via: null,
  updatedAt: "2026-11-10T09:00:00.000Z",
  deletedAt: null,
  ...patch,
});

describe("space overview", () => {
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  const run = RunId.make("run-1");
  const pendingRequest = (kind: "user_input" | "permission") => ({
    id: RuntimeRequestId.make(`request-${kind}`),
    kind,
    createdAt: at("2026-11-10T09:00:00Z"),
  });
  const thread = (id: string, task: number, patch: Partial<typeof v2ThreadShell> = {}) => ({
    ...v2ThreadShell,
    id: ThreadId.make(id),
    latestRunId: run,
    status: "completed" as const,
    ownerId: hanad,
    updatedAt: at("2026-11-10T09:30:00Z"),
    space: {
      kind: "task" as const,
      spaceId,
      taskId: taskId(task),
      linkedBy: hanad,
      linkedAt: "2026-11-10T09:00:00.000Z",
      via: "start" as const,
    },
    ...patch,
  });
  const working = (id: string, task: number) => thread(id, task, { status: "running" });
  const needs = (id: string, task: number, ownerId: MemberId, kind: "user_input" | "permission") =>
    thread(id, task, { status: "running", ownerId, pendingRuntimeRequest: pendingRequest(kind) });

  it.each([
    ["no threads", [], {}, "No threads yet", false],
    [
      "assigned by someone",
      [],
      { assignedBy: kousik },
      "No threads yet · assigned by Kousik",
      false,
    ],
    [
      "assigned to you",
      [],
      { ownerId: rutvik, assignedBy: kousik, status: "todo" as const },
      "Assigned to you · not started",
      true,
    ],
    [
      "assigned to you, already moved on",
      [],
      { ownerId: rutvik, assignedBy: kousik, status: "in-progress" as const },
      "No threads yet · assigned by Kousik",
      false,
    ],
    ["one idle", [thread("a", 1)], {}, "Idle", false],
    ["two idle", [thread("a", 1), thread("b", 1)], {}, "2 threads · both idle", false],
    ["one working", [working("a", 1)], {}, "Working", false],
    ["working beats idle", [thread("a", 1), working("b", 1)], {}, "2 threads · 1 working", false],
    [
      "failed beats working",
      [working("a", 1), thread("b", 1, { status: "failed", lastError: "Tests failed" })],
      {},
      "Thread failed: Tests failed",
      false,
    ],
    [
      "needs beats failed, for its owner",
      [thread("a", 1, { status: "failed" }), needs("b", 1, rutvik, "user_input")],
      {},
      "Needs you · has a question",
      true,
    ],
    [
      "someone else's approval",
      [needs("a", 1, hanad, "permission")],
      {},
      "Needs Hanad Ali · wants approval",
      false,
    ],
  ] as const)("reads line 2 by precedence: %s", (_name, threads, patch, text, needsViewer) => {
    expect(spaceTaskActivity(threads, viewer, spaceTask(1, patch))).toMatchObject({
      text,
      needsViewer,
    });
  });

  it("groups by status, puts what needs the viewer under Needs you only, newest first", () => {
    const tasks = [
      spaceTask(1, { status: "in-progress", updatedAt: "2026-11-10T09:00:00.000Z" }),
      spaceTask(2, { status: "in-progress", updatedAt: "2026-11-10T11:00:00.000Z" }),
      spaceTask(3, { status: "in-review" }),
      spaceTask(4, { status: "todo", ownerId: rutvik, assignedBy: kousik }),
      spaceTask(5, { status: "done" }),
      spaceTask(6, { status: "canceled" }),
      spaceTask(7, { status: "todo" }),
      spaceTask(8, { status: "done", deletedAt: "2026-11-11T00:00:00.000Z" }),
      // Done, with a thread still asking the viewer: stays under Done.
      spaceTask(9, { status: "done" }),
    ];
    const threads = spaceThreadsByTask([
      needs("t3", 3, rutvik, "permission"),
      thread("t1", 1, { updatedAt: at("2026-11-10T12:00:00Z") }),
      needs("t9", 9, rutvik, "user_input"),
    ]);
    const sections = groupSpaceOverview(tasks, threads, viewer);
    expect(sections.map((section) => [section.id, section.rows.map((row) => row.task.id)])).toEqual(
      [
        ["needs-you", [taskId(3), taskId(4)]],
        ["in-progress", [taskId(1), taskId(2)]],
        ["todo", [taskId(7)]],
        ["done", [taskId(9), taskId(5)]],
        ["canceled", [taskId(6)]],
      ],
    );
    expect(sections.find((section) => section.id === "canceled")).toMatchObject({
      band: true,
      collapsedByDefault: true,
    });
  });

  it("gives the sidebar two Needs-you rows per space, the rest as more, and Assigned to me", () => {
    const archivedId = SpaceId.make("spc_00000000000000000099");
    const archived = { ...space, id: archivedId, archivedAt: "2026-11-12T00:00:00.000Z" };
    const tasks = [
      spaceTask(1, { ownerId: rutvik, assignedBy: kousik, status: "todo" }),
      spaceTask(2, { ownerId: rutvik, status: "in-progress" }),
      spaceTask(3),
      spaceTask(4),
      spaceTask(5, { ownerId: rutvik, spaceId: archivedId }),
    ];
    const sidebar = spaceSidebarTasks(
      { spaces: [space, archived], tasks },
      [needs("t2", 2, rutvik, "user_input"), needs("t3", 3, rutvik, "permission")],
      viewer,
    );
    const row = sidebar.spaces.get(spaceId)!;
    expect(row.needsYou).toHaveLength(2);
    expect(row.more).toBe(2);
    expect(sidebar.spaces.has(archivedId)).toBe(false);
    expect(sidebar.assignedToMe.map((task) => task.id).sort()).toEqual([taskId(1), taskId(2)]);
  });
});

describe("space records", () => {
  const thread1 = ThreadId.make("thread-1");
  const system = (id: string, line: SpaceSystemLine, actorId = kousik): SpaceTaskLineEntry =>
    ({
      type: "system",
      id: MessageId.make(id),
      spaceId,
      actorId,
      line,
      createdAt: "2026-11-10T10:00:00.000Z",
    }) as SpaceTaskLineEntry;
  const moved = (by: Extract<SpaceSystemLine, { type: "task-status" }>["by"], askedBy = rutvik) =>
    system("move", {
      type: "task-status",
      taskId: taskId(1),
      from: "in-progress",
      to: "in-review",
      by,
      askedBy: by.type === "member" ? null : askedBy,
      version: 2,
      undoOf: null,
    });
  const ctx = (patch: Partial<SpaceRecordContext> = {}): SpaceRecordContext => ({
    viewer,
    inThread: null,
    onTask: null,
    threadTitle: (id) => (id === thread1 ? "Fix preview" : null),
    undone: new Set(),
    ...patch,
  });
  const words = (view: ReturnType<typeof spaceRecordText>) =>
    view.segments
      .map((segment) =>
        segment.type === "text"
          ? segment.text
          : segment.type === "task"
            ? "[task]"
            : `<${segment.text}>`,
      )
      .join("");
  const agent = { type: "agent" as const, threadId: thread1 };
  const pair = {
    type: "pair" as const,
    runId: RunId.make("run-1"),
    actionId: SpaceActionId.make("act-1"),
  };

  it.each([
    [
      "person, in the room",
      moved({ type: "member", memberId: kousik }),
      ctx(),
      "Kousik moved [task] to In review",
    ],
    ["you", moved({ type: "member", memberId: rutvik }), ctx(), "You moved [task] to In review"],
    [
      "agent, in the room",
      moved(agent),
      ctx(),
      "Fix preview moved [task] to In review · asked by you",
    ],
    [
      "agent, in its thread",
      moved(agent),
      ctx({ inThread: thread1 }),
      "Agent moved [task] to In review · asked by you",
    ],
    [
      "agent, on the task page",
      moved(agent, hanad),
      ctx({ onTask: taskId(1) }),
      "Fix preview moved this to In review · asked by Hanad Ali",
    ],
    ["pair", moved(pair), ctx(), "Pair moved [task] to In review · asked by you"],
  ])("names who moved a status: %s", (_name, entry, context, text) => {
    expect(spaceRecordText(entry, context)).toMatchObject({ lead: "move", muted: false });
    expect(words(spaceRecordText(entry, context))).toBe(text);
  });

  it("reads the other task lines, and this thread in its own view", () => {
    const added = system("add", {
      type: "task-thread-added",
      taskId: taskId(1),
      threadId: thread1,
      threadOwnerId: kousik,
      via: "start",
    });
    expect(words(spaceRecordText(added, ctx()))).toBe(
      "Kousik started a thread on [task]: <Fix preview>",
    );
    expect(words(spaceRecordText(added, ctx({ inThread: thread1 })))).toBe(
      "Kousik started this thread on [task]",
    );
    const created = system("c", { type: "task-created", taskId: taskId(1), ownerId: rutvik });
    expect(words(spaceRecordText(created, ctx()))).toBe(
      "Kousik created [task] and assigned it to you",
    );
  });

  it("mutes an undone move and leads the Undo line with who undid it", () => {
    const move = moved(pair);
    const undo = system(
      "undo",
      {
        type: "task-status",
        taskId: taskId(1),
        from: "in-review",
        to: "in-progress",
        by: { type: "member", memberId: hanad },
        askedBy: null,
        version: 3,
        undoOf: move.id,
      },
      hanad,
    );
    const undone = spaceUndoneEntryIds([move, undo]);
    expect(spaceRecordText(move, ctx({ undone })).muted).toBe(true);
    const view = spaceRecordText(undo, ctx({ undone }));
    expect(view.lead).toBe("undo");
    expect(words(view)).toBe("Hanad Ali undid this · [task] is back to In progress");
  });

  it("offers Undo on an agent's move until the status changes again", () => {
    const move = moved(agent);
    const task = spaceTask(1, { statusVersion: 2 });
    expect(spaceStatusUndo(move, task, space, viewer, [move])).toEqual({
      state: "available",
      input: { spaceId, taskId: taskId(1), entryId: move.id },
    });
    expect(spaceStatusUndo(move, { ...task, statusVersion: 3 }, space, viewer, [move])).toEqual({
      state: "disabled",
      tooltip: "Status changed since",
    });
    const own = moved({ type: "member", memberId: kousik });
    expect(spaceStatusUndo(own, task, space, viewer, [own])).toBeNull();
    const archived = { ...space, archivedAt: "2026-11-12T00:00:00.000Z" };
    expect(spaceStatusUndo(move, task, archived, viewer, [move])).toBeNull();
    const outsider = { ...viewer, memberId: MemberId.make("mem-gone") };
    expect(spaceStatusUndo(move, task, space, outsider, [move])).toBeNull();
  });

  it("follows the live room's task and lines until the task snapshot catches up", () => {
    const at = (entry: SpaceTaskLineEntry, createdAt: string) => ({ ...entry, createdAt });
    const created = at(
      system("c", { type: "task-created", taskId: taskId(1), ownerId: hanad }),
      "2026-11-10T09:00:00.000Z",
    );
    const handedBack = at(
      system("h", { type: "task-handed-back", taskId: taskId(1), reason: "Out" }),
      "2026-11-10T11:00:00.000Z",
    );
    const other = system("o", { type: "task-edited", taskId: taskId(2) });
    const post = { ...other, type: "post" } as unknown as SpaceRoomEntry;
    expect(spaceTaskEntries([created], [created, other, post, handedBack], taskId(1))).toEqual([
      created,
      handedBack,
    ]);
    const snapshot = [created, handedBack];
    expect(spaceTaskEntries(snapshot, [handedBack], taskId(1))).toBe(snapshot);

    const stale = spaceTask(1, { updatedAt: "2026-11-10T09:00:00.000Z" });
    const live = spaceTask(1, { updatedAt: "2026-11-10T11:00:00.000Z", ownerId: kousik });
    expect(spaceLiveTask(live, stale)).toBe(live);
    expect(spaceLiveTask(stale, live)).toBe(live);
    expect(spaceLiveTask(null, stale)).toBe(stale);

    const elsewhere = spaceTask(3, { spaceId: SpaceId.make("spc_ffffffffffffffffffff") });
    const list = { spaces: [space], tasks: [stale, elsewhere] };
    const room = {
      type: "member",
      space,
      entries: [],
      hasMoreEntries: false,
      tasks: [live, spaceTask(4, { status: "done" })],
      threads: [],
      notes: [],
      actions: [],
    } as unknown as SpaceRoomMemberState;
    expect(spaceListWithRoom(list, room).tasks).toEqual([live, elsewhere]);
    expect(spaceListWithRoom(list, null)).toBe(list);
  });

  it("dates an assignment from the newest line that gave the task to its owner", () => {
    const at = (entry: SpaceTaskLineEntry, createdAt: string) => ({ ...entry, createdAt });
    const created = at(
      system("c", { type: "task-created", taskId: taskId(1), ownerId: kousik }),
      "2026-11-10T09:00:00.000Z",
    );
    const toHanad = at(
      system("a1", { type: "task-assigned", taskId: taskId(1), from: kousik, to: hanad }),
      "2026-11-10T10:00:00.000Z",
    );
    const elsewhere = at(
      system("a2", { type: "task-assigned", taskId: taskId(2), from: kousik, to: hanad }),
      "2026-11-10T12:00:00.000Z",
    );
    const entries = [created, toHanad, elsewhere];
    expect(spaceTaskAssignedAt(spaceTask(1, { ownerId: hanad }), entries)).toBe(toHanad.createdAt);
    expect(spaceTaskAssignedAt(spaceTask(1, { ownerId: kousik }), entries)).toBe(created.createdAt);
    expect(spaceTaskAssignedAt(spaceTask(1, { ownerId: rutvik }), entries)).toBeNull();
  });

  it("suggests Mark Done once a pull request merged after the last status change", () => {
    const pr = (number: number, mergedAt: string, state = "merged") =>
      ({
        repository: "interviewstreet/pair-be",
        number,
        source: "agent",
        snapshot: { state, mergedAt, updatedAt: mergedAt, syncedAt: mergedAt },
      }) as unknown as ThreadPullRequestLink;
    const task = spaceTask(1, { status: "in-review", statusChangedAt: "2026-11-10T10:00:00.000Z" });
    expect(
      spaceMergedSuggestion(task, [
        {
          pullRequests: [pr(470, "2026-11-10T09:00:00.000Z"), pr(471, "2026-11-10T11:00:00.000Z")],
        },
      ]),
    ).toEqual({ text: "pair-be#471 merged", action: "Mark Done", status: "done" });
    expect(
      spaceMergedSuggestion(task, [{ pullRequests: [pr(470, "2026-11-10T09:00:00.000Z")] }]),
    ).toBeNull();
    expect(
      spaceMergedSuggestion({ ...task, status: "done" }, [
        { pullRequests: [pr(471, "2026-11-10T11:00:00.000Z")] },
      ]),
    ).toBeNull();
  });
});

describe("where a space's threads run", () => {
  it.each([
    [
      { type: "project", projectId: ProjectId.make("p"), title: "pair-be" },
      "Threads run in pair-be.",
    ],
    [
      { type: "reuse", projectId: ProjectId.make("w"), title: "Question creation" },
      "Uses the workspace Question creation, which has the same repositories.",
    ],
    [
      { type: "create", title: "Question creation" },
      "Creates the workspace Question creation with pair-be and pair-fe.",
    ],
  ] as const)("says it under Repositories: %s", (preview, text) => {
    expect(spaceWorkspaceLine(preview, ["pair-be", "pair-fe"])).toBe(text);
  });

  it("leaves the workspace name out of the header when it is the space's name", () => {
    const repositoryIds = [ProjectId.make("a"), ProjectId.make("b")];
    expect(
      spaceHeaderWorkspaceLabel({ ...space, repositoryIds }, { title: "Question creation" }, [
        "pair-be",
        "pair-fe",
      ]),
    ).toEqual({ icon: "workspace", name: null, repositories: "pair-be, pair-fe" });
    expect(
      spaceHeaderWorkspaceLabel({ ...space, repositoryIds }, { title: "QC" }, [
        "pair-be",
        "pair-fe",
      ]),
    ).toEqual({ icon: "workspace", name: "QC", repositories: "pair-be, pair-fe" });
    expect(spaceHeaderWorkspaceLabel(space, { title: "pair-be" }, ["pair-be"])).toEqual({
      icon: "folder",
      name: "pair-be",
      repositories: null,
    });
  });
});

describe("asking an admin for a Team Claude key", () => {
  const teamMember = (id: MemberId, patch: Partial<TeamMember> = {}): TeamMember => ({
    id,
    name: NAMES[id] ?? id,
    role: "member",
    color: "#000",
    isOwner: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    removedAt: null,
    ...patch,
  });
  const set = (addedBy: MemberId): TeamClaudeKeyStatus => ({
    state: "set",
    last4: "4f2a",
    addedBy,
    addedAt: "2026-11-13T09:00:00.000Z",
    lastUsedAt: null,
    activeSpaceCount: 1,
  });
  const unset: TeamClaudeKeyStatus = { state: "unset", activeSpaceCount: 1 };

  it.each([
    [
      "the space owner, an admin",
      [teamMember(rutvik, { isOwner: true }), teamMember(kousik, { role: "admin" })],
      set(rutvik),
      kousik,
    ],
    [
      "whoever added the key",
      [
        teamMember(hanad, { role: "admin" }),
        teamMember(rutvik, { isOwner: true, createdAt: "2026-02-01T00:00:00.000Z" }),
        teamMember(kousik),
      ],
      set(rutvik),
      rutvik,
    ],
    [
      "the first admin by join order",
      [
        teamMember(rutvik, { role: "admin", createdAt: "2026-02-01T00:00:00.000Z" }),
        teamMember(hanad, { role: "admin" }),
        teamMember(kousik),
      ],
      unset,
      hanad,
    ],
  ])("asks %s", (_name, members, status, admin) => {
    expect(spaceAskAdmin(space, members, status)?.admin.id).toBe(admin);
  });

  it("drafts the ask with a mention token, and none without admins", () => {
    const ask = spaceAskAdmin(null, [teamMember(rutvik, { isOwner: true })], unset);
    expect(ask).toMatchObject({
      label: "Ask Rutvik",
      draft: {
        text: "@Rutvik can you add a Team Claude key? Settings → Team",
        tokens: [{ mention: { type: "member", memberId: rutvik }, label: "Rutvik" }],
      },
    });
    expect(spaceAskAdmin(space, [teamMember(kousik)], unset)).toBeNull();
  });

  it("drafts in the most recently opened space shared with the admin", () => {
    const other = { ...space, id: SpaceId.make("spc_00000000000000000002") };
    const withoutAdmin = {
      ...space,
      id: SpaceId.make("spc_00000000000000000003"),
      members: space.members.filter((member) => member.memberId !== hanad),
    };
    const visits = new Map([
      [space.id, 1],
      [other.id, 2],
      [withoutAdmin.id, 3],
    ]);
    expect(spaceAskTargetSpace([space, other, withoutAdmin], rutvik, hanad, visits)?.id).toBe(
      other.id,
    );
    expect(spaceAskTargetSpace([withoutAdmin], rutvik, hanad, visits)).toBeNull();
  });
});

describe("space room state", () => {
  const post = (id: string, createdAt: string, authorId = kousik): SpaceRoomEntry => ({
    type: "post",
    id: MessageId.make(id),
    spaceId,
    authorId,
    authorKind: "user",
    text: id,
    mentions: [],
    pairRequested: false,
    createdAt,
  });
  const room = (entries: SpaceRoomEntry[]): SpaceRoomMemberState => ({
    type: "member",
    space,
    entries,
    hasMoreEntries: false,
    tasks: [],
    threads: [],
    notes: [],
    actions: [],
  });

  it("appends live entries once and ignores an older space", () => {
    const one = post("one", "2026-11-10T10:00:00.000Z");
    const state = applySpaceRoomEvent(room([one]), { type: "space.room-entry", payload: one });
    expect(state.entries).toHaveLength(1);
    const later = applySpaceRoomEvent(state, {
      type: "space.room-entry",
      payload: post("two", "2026-11-10T10:01:00.000Z"),
    });
    expect(later.entries.map((entry) => entry.id)).toEqual(["one", "two"]);
    const stale = applySpaceRoomEvent(later, {
      type: "space.updated",
      payload: { ...space, name: "Old", updatedAt: "2026-11-09T00:00:00.000Z" },
    });
    expect(stale).toBe(later);
  });

  it("keeps live entries newer than a resynced page", () => {
    const current = room([
      post("one", "2026-11-10T10:00:00.000Z"),
      post("three", "2026-11-10T10:03:00.000Z"),
    ]);
    const merged = mergeSpaceRoomView(
      current,
      room([post("one", "2026-11-10T10:00:00.000Z"), post("two", "2026-11-10T10:02:00.000Z")]),
    );
    expect(merged.type === "member" && merged.entries.map((entry) => entry.id)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("drops older pages once a resynced live page no longer starts where they end", () => {
    const one = post("one", "2026-11-10T10:00:00.000Z");
    const older = {
      entries: [post("zero", "2026-11-10T09:00:00.000Z")],
      hasMore: true,
      anchorId: one.id,
    };
    expect(joinedSpaceOlderEntries(older, [one])).toBe(older);
    expect(joinedSpaceOlderEntries(older, [post("five", "2026-11-10T10:05:00.000Z")])).toBeNull();
  });

  it("puts the New divider at the first entry someone else posted after the visit", () => {
    const entries = [
      post("seen", "2026-11-10T10:00:00.000Z"),
      post("mine", "2026-11-10T10:05:00.000Z", rutvik),
      post("new", "2026-11-10T10:06:00.000Z"),
    ];
    expect(spaceNewDividerIndex(entries, "2026-11-10T10:01:00.000Z", rutvik)).toBe(2);
    expect(spaceNewDividerIndex(entries, null, rutvik)).toBeNull();
  });

  it("groups a run of posts until a new day, the New divider or a Pair item breaks it", () => {
    const entries = [
      post("a", "2026-11-12T10:00:00"),
      post("b", "2026-11-12T10:01:00"),
      post("c", "2026-11-12T10:02:00"),
      post("d", "2026-11-12T10:04:00"),
      post("e", "2026-11-13T09:00:00"),
    ];
    const rows = spaceFeedRows(
      entries,
      [{ key: "p1", createdAt: "2026-11-12T10:03:00" }],
      2,
      // @effect-diagnostics-next-line globalDate:off - the feed labels local calendar days
      new Date("2026-11-13T12:00:00"),
    );
    expect(
      rows.map((row) =>
        row.type === "entry" ? `${row.entry.id}${row.continued ? "+" : ""}` : row.type,
      ),
    ).toEqual(["day", "a", "b+", "new", "c", "pair", "d", "day", "e"]);
    expect(rows.flatMap((row) => (row.type === "day" ? [row.label] : []))).toEqual([
      "Yesterday",
      "Today",
    ]);
  });
});

describe("space controls", () => {
  it("gives the owner management and everyone else posting", () => {
    expect(spaceControls(space, kousik, true)).toMatchObject({
      canManage: true,
      canArchive: true,
      canLeave: false,
      canPost: true,
    });
    expect(spaceControls(space, rutvik, true)).toMatchObject({
      canManage: false,
      canArchive: false,
      canLeave: true,
      canPost: true,
    });
    expect(spaceControls(space, MemberId.make("mem-gone"), true).isMember).toBe(false);
    expect(spaceControls(space, rutvik, false).canPost).toBe(false);
  });

  it("makes an archived space read-only, with Unarchive for its owner", () => {
    const archived = { ...space, archivedAt: "2026-11-12T00:00:00.000Z", archivedBy: kousik };
    expect(spaceControls(archived, kousik, true)).toMatchObject({
      archived: true,
      canPost: false,
      canCreateTask: false,
      canEditNotes: false,
      canManage: false,
      canUnarchive: true,
    });
    expect(spaceControls(archived, rutvik, true).canUnarchive).toBe(false);
  });

  it("splits task controls between its owner, its creator and whoever assigned it", () => {
    const task = spaceTask(1, {
      ownerId: rutvik,
      createdBy: kousik,
      assignedBy: kousik,
      status: "todo",
    });
    expect(spaceTaskControls(task, space, rutvik, true)).toMatchObject({
      canEdit: true,
      canHandBack: true,
      canRemind: false,
      canSetStatus: true,
    });
    expect(spaceTaskControls(task, space, kousik, true)).toMatchObject({
      canEdit: true,
      canHandBack: false,
      canRemind: true,
    });
    expect(spaceTaskControls(task, space, hanad, true)).toMatchObject({
      canEdit: false,
      canReassign: false,
      canSetStatus: true,
      canRemind: false,
    });
    const archived = { ...space, archivedAt: "2026-11-12T00:00:00.000Z" };
    expect(spaceTaskControls(task, archived, rutvik, true)).toMatchObject({
      canEdit: false,
      canSetStatus: false,
      canStartThread: false,
    });
  });

  it("asks who takes a leaver's or removed member's open tasks, and says Undo keeps them", () => {
    const remove = { type: "remove" as const, space, memberId: hanad, reassignTo: rutvik };
    expect(spaceConfirmCopy(remove, viewer, 2)).toMatchObject({
      title: "Remove Hanad Ali from Question creation?",
      reassignLabel: "Hanad Ali owns 2 open tasks. Reassign them to",
      action: "Remove Hanad Ali",
    });
    expect(spaceConfirmCopy(remove, viewer, 0).reassignLabel).toBeNull();
    expect(spaceConfirmMutation(remove)).toEqual({
      type: "member.remove",
      spaceId,
      memberId: hanad,
      reassignTo: rutvik,
    });
    expect(spaceConfirmMutation({ ...remove, reassignTo: null })).toEqual({
      type: "member.remove",
      spaceId,
      memberId: hanad,
    });
    expect(spaceConfirmUndo(remove, viewer, 2)).toMatchObject({
      title: "Hanad Ali was removed from the space",
      restored: "Hanad Ali is back. Their 2 open tasks stay with you.",
      mutation: { type: "member.add", memberIds: [hanad], restore: true },
    });
    expect(spaceConfirmUndo({ type: "leave", space, reassignTo: kousik }, viewer, 1)).toMatchObject(
      {
        label: "Ask to be added back",
        mutation: { type: "join.request", spaceId },
      },
    );
    expect(spaceConfirmMutation({ type: "leave", space, reassignTo: kousik })).toEqual({
      type: "leave",
      spaceId,
      reassignTo: kousik,
    });
    expect(spaceConfirmUndo({ type: "transfer", space, memberId: hanad }, viewer, 0)).toBeNull();
  });
});

describe("space room events", () => {
  const room = (tasks: ReadonlyArray<SpaceTask>): SpaceRoomMemberState => ({
    type: "member",
    space,
    entries: [],
    hasMoreEntries: false,
    tasks,
    threads: [],
    notes: [],
    actions: [],
  });

  it("upserts a task by id, keeps the newest copy, and drops a deleted one", () => {
    const older = spaceTask(1, { updatedAt: "2026-11-10T10:00:00.000Z" });
    const newer = spaceTask(1, { status: "in-review", updatedAt: "2026-11-10T11:00:00.000Z" });
    const added = applySpaceRoomEvent(room([]), { type: "space.task.updated", payload: older });
    expect(added.tasks).toEqual([older]);
    const updated = applySpaceRoomEvent(added, { type: "space.task.updated", payload: newer });
    expect(updated.tasks).toEqual([newer]);
    expect(applySpaceRoomEvent(updated, { type: "space.task.updated", payload: older })).toBe(
      updated,
    );
    const deleted = applySpaceRoomEvent(updated, {
      type: "space.task.updated",
      payload: {
        ...newer,
        deletedAt: "2026-11-10T12:00:00.000Z",
        updatedAt: "2026-11-10T12:00:00.000Z",
      },
    });
    expect(deleted.tasks).toEqual([]);
    // A resynced page keeps a newer live copy, and leaves out what it no longer holds.
    const merged = mergeSpaceRoomView(updated, room([older]));
    expect(merged.type === "member" && merged.tasks).toEqual([newer]);
    expect(
      mergeSpaceRoomView(updated, room([])).type === "member" &&
        mergeSpaceRoomView(updated, room([])),
    ).toMatchObject({ tasks: [] });
  });
});
