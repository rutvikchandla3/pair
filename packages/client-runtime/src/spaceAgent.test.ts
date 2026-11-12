import {
  MemberId,
  MessageId,
  RunId,
  type SpaceAction,
  SpaceActionId,
  SpaceId,
  type SpaceNoteItem,
  SpaceNoteId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  type SpaceAgentRoomState,
  type SpacePairProjection,
  applySpaceAgentEvent,
  mergeSpaceActions,
  spaceActionView,
  spacePairFeedItems,
  spacePairRoom,
  spacePairStatusLine,
} from "./spaceAgent.ts";
import { spaceSidebarShells } from "./spaces.ts";
import { v2ThreadShell } from "./state/orchestrationV2TestFixtures.ts";

const rutvik = MemberId.make("mem-rutvik");
const kousik = MemberId.make("mem-kousik");
const hanad = MemberId.make("mem-hanad");
const NAMES: Record<string, string> = { [rutvik]: "Rutvik", [kousik]: "Kousik", [hanad]: "Hanad" };
const viewer = { memberId: rutvik, nameOf: (id: MemberId) => NAMES[id] ?? "Former member" };
const spaceId = SpaceId.make("spc_0123456789abcdef0123");
const taskId = ThreadId.make("task-1");

const action = (id: string, patch: Partial<SpaceAction> = {}): SpaceAction => ({
  id: SpaceActionId.make(id),
  spaceId,
  request: { type: "task.create", title: "Review list", description: "Sort it", ownerId: hanad },
  actorId: rutvik,
  via: { runId: RunId.make("run-1"), roomMessageId: MessageId.make("post-1") },
  state: "done",
  outcome: {
    type: "task.created",
    threadId: taskId,
    ownerId: hanad,
    title: "Review list",
    started: false,
  },
  proposal: null,
  undo: null,
  resolvedBy: null,
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-10T10:00:00.000Z",
  ...patch,
});

const note = (version: number, text = "Tag difficulty after review"): SpaceNoteItem => ({
  id: SpaceNoteId.make("note-1"),
  spaceId,
  section: "decision",
  text,
  sources: [],
  createdBy: { type: "pair", askedBy: rutvik, runId: RunId.make("run-1") },
  lastEditedBy: { type: "member", memberId: kousik },
  version,
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-10T10:00:00.000Z",
});

describe("@pair room events", () => {
  it("keeps the newest copy of an action, live or from a resynced page", () => {
    const proposed = action("a", { state: "proposed", updatedAt: "2026-11-10T10:00:00.000Z" });
    const done = action("a", { updatedAt: "2026-11-10T10:01:00.000Z" });
    const state = applySpaceAgentEvent(
      { notes: [], actions: [proposed] },
      { type: "space.action.updated", payload: done },
    );
    expect(state.actions).toEqual([done]);
    const stale = applySpaceAgentEvent(state, { type: "space.action.updated", payload: proposed });
    expect(stale).toBe(state);
    expect(mergeSpaceActions([done], [proposed])).toEqual([done]);
  });

  it("applies note changes by version, so a late removal loses to a later edit", () => {
    const writer = { type: "member" as const, memberId: kousik };
    const change = { spaceId, noteId: note(1).id, writer, actionId: null, tombstone: null };
    const empty: SpaceAgentRoomState = { notes: [], actions: [] };
    const added = applySpaceAgentEvent(empty, {
      type: "space.notes.changed",
      payload: { ...change, before: null, after: note(1) },
    });
    const edited = applySpaceAgentEvent(added, {
      type: "space.notes.changed",
      payload: { ...change, before: note(1), after: note(2, "Tag it before review") },
    });
    expect(edited.notes.map((item) => item.text)).toEqual(["Tag it before review"]);
    const replayed = applySpaceAgentEvent(edited, {
      type: "space.notes.changed",
      payload: { ...change, before: null, after: note(1) },
    });
    expect(replayed).toBe(edited);
    const lateRemoval = applySpaceAgentEvent(edited, {
      type: "space.notes.changed",
      payload: { ...change, before: note(1), after: null },
    });
    expect(lateRemoval).toBe(edited);
    const removed = applySpaceAgentEvent(edited, {
      type: "space.notes.changed",
      payload: { ...change, before: note(2), after: null },
    });
    expect(removed.notes).toEqual([]);
  });
});

describe("@pair queue", () => {
  const at = (minute: number) => DateTime.makeUnsafe(`2026-11-10T10:${minute}0:00.000Z`);
  const projection: SpacePairProjection = {
    runs: [
      {
        id: RunId.make("run-1"),
        ordinal: 1,
        userMessageId: MessageId.make("post-1"),
        status: "failed",
        startedAt: at(1),
      },
      {
        id: RunId.make("run-2"),
        ordinal: 2,
        userMessageId: MessageId.make("post-2"),
        status: "running",
        startedAt: at(2),
      },
      {
        id: RunId.make("run-3"),
        ordinal: 3,
        userMessageId: MessageId.make("post-3"),
        status: "queued",
        startedAt: null,
      },
      {
        id: RunId.make("run-4"),
        ordinal: 4,
        userMessageId: MessageId.make("post-1:retry:1"),
        status: "failed",
        startedAt: at(3),
      },
    ],
    messages: [
      { id: MessageId.make("post-1"), authorId: hanad },
      { id: MessageId.make("post-2"), authorId: kousik },
      { id: MessageId.make("post-3"), authorId: rutvik },
    ],
    turnItems: [
      {
        id: TurnItemId.make("text-2"),
        runId: RunId.make("run-2"),
        ordinal: 1,
        type: "assistant_message",
      },
      {
        id: TurnItemId.make("error-4"),
        runId: RunId.make("run-4"),
        ordinal: 1,
        type: "error",
        failure: {
          class: "usage_limit",
          message: "Team Claude key hit its usage limit",
          code: null,
          retryable: true,
          resetAt: "2026-11-10T14:00:00.000Z",
        },
      },
    ],
  };
  const room = spacePairRoom(projection);
  const space = { ownerId: kousik };
  const line = (trigger: string, as = viewer) =>
    spacePairStatusLine(
      room.byTrigger.get(MessageId.make(trigger)),
      room,
      space,
      as,
      () => "14:00",
    );

  it("puts each tag's latest reply under its post, with who Pair answers first", () => {
    expect(room.replying?.runId).toBe("run-2");
    expect(line("post-3")).toEqual({
      text: "Queued · Pair is answering Kousik first",
      tone: "muted",
      control: "cancel",
    });
    expect(line("post-2")).toEqual({
      text: "Pair is replying to Kousik",
      tone: "muted",
      control: null,
    });
  });

  it("follows a retry: the newest attempt's limit shows, with Retry for the tagger", () => {
    const reply = room.byTrigger.get(MessageId.make("post-1"));
    expect(reply).toMatchObject({ runId: "run-4", status: "limited", taggerId: hanad });
    expect(line("post-1")?.text).toBe(
      "Pair couldn't reply: Team Claude key hit its usage limit · Resets 14:00",
    );
    expect(line("post-1")?.control).toBeNull();
    expect(line("post-1", { ...viewer, memberId: hanad })?.control).toBe("retry");
  });

  it("files each started reply with the actions it took, in start order", () => {
    const loose = action("loose", { via: null, createdAt: "2026-11-10T10:15:00.000Z" });
    const items = spacePairFeedItems(room, [
      action("a", { via: { runId: RunId.make("run-2"), roomMessageId: MessageId.make("post-2") } }),
      loose,
    ]);
    expect(items.map((item) => [item.key, item.actions.map((a) => a.id)])).toEqual([
      ["run-1", []],
      ["loose", ["loose"]],
      ["run-2", ["a"]],
      ["run-4", []],
    ]);
  });
});

describe("@pair records", () => {
  const context = (started: boolean | null, as = viewer) => ({
    viewer: as,
    now: Date.parse("2026-11-10T11:00:00.000Z"),
    taskStarted: () => started,
  });

  it("offers Undo of a created task to the tagger only, until its owner starts it", () => {
    expect(spaceActionView(action("a"), context(false))).toMatchObject({
      kind: "record",
      detail: "for Hanad · asked by you",
      canUndo: true,
    });
    expect(spaceActionView(action("a"), context(true)).kind === "record").toBe(true);
    expect(spaceActionView(action("a"), context(true))).toMatchObject({ canUndo: false });
    expect(
      spaceActionView(action("a"), context(false, { ...viewer, memberId: hanad })),
    ).toMatchObject({ detail: "for you · asked by Rutvik", canUndo: false });
  });

  it("reads a confirm card past its deadline as expired, with Ask again for the tagger", () => {
    const card = action("card", {
      state: "proposed",
      request: { type: "task.message", taskId, text: "Use 3 sizes" },
      outcome: null,
      proposal: {
        snapshot: {
          threadId: taskId,
          title: "Preview renderer",
          ownerId: hanad,
          latestRunId: null,
          updatedAt: "2026-11-10T09:00:00.000Z",
        },
        permission: "space-member",
        expiresAt: "2026-11-11T10:00:00.000Z",
      },
    });
    expect(spaceActionView(card, context(true))).toMatchObject({
      kind: "confirm",
      canAnswer: true,
    });
    expect(spaceActionView(card, context(true, { ...viewer, memberId: kousik }))).toMatchObject({
      canAnswer: false,
      waitingFor: "Rutvik",
    });
    expect(
      spaceActionView(card, { ...context(true), now: Date.parse("2026-11-12T00:00:00.000Z") }),
    ).toEqual({
      kind: "closed",
      text: "This request expired. Nothing was sent",
      taskId,
      title: "Preview renderer",
      askAgain: "@pair message Preview renderer: Use 3 sizes",
    });
  });
});

describe("space sidebar unread", () => {
  it("leaves a room read when its latest line is the viewer's own, and keys rooms by revision", () => {
    const updatedAt = DateTime.makeUnsafe("2026-11-10T10:05:00.000Z");
    const room = (by: MemberId, revision: string) => ({
      ...v2ThreadShell,
      id: ThreadId.make("room"),
      space: {
        kind: "room" as const,
        spaceId,
        revision,
        latestEntry: { by, at: "2026-11-10T10:05:00.000Z" },
      },
      updatedAt,
      lastVisitedAt: DateTime.makeUnsafe("2026-11-10T10:00:00.000Z"),
    });
    expect(spaceSidebarShells([room(rutvik, "r1")], rutvik).unreadRoomIds.size).toBe(0);
    expect(spaceSidebarShells([room(kousik, "r1")], rutvik).unreadRoomIds.has("room")).toBe(true);
    expect(spaceSidebarShells([room(rutvik, "r1")], rutvik).roomsKey).not.toBe(
      spaceSidebarShells([room(rutvik, "r2")], rutvik).roomsKey,
    );
  });
});
