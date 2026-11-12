import {
  MemberId,
  MessageId,
  RunId,
  RuntimeRequestId,
  type Space,
  SpaceId,
  type SpaceRoomEntry,
  ThreadId,
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
  spaceComposerHint,
  spaceControls,
  spaceTaskControls,
  spaceMentionCandidates,
  spaceMentionQuery,
  spaceNewDividerIndex,
  spaceTasksNeedingViewer,
  splitSpacePostText,
  type SpaceMentionToken,
  type SpaceRoomMemberState,
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
  pairBilling: { type: "team" },
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
    expect(spaceComposerHint([], space, viewer)).toBeNull();
    expect(
      spaceComposerHint(
        [
          { type: "member", memberId: kousik },
          { type: "member", memberId: hanad },
        ],
        space,
        viewer,
      ),
    ).toBe("Kousik and Hanad Ali will be notified");
    expect(spaceComposerHint([{ type: "pair" }], space, viewer)).toBe(
      "Pair replies here · Team Claude key",
    );
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

describe("space overview", () => {
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  const task = (id: string, patch: Partial<typeof v2ThreadShell>) => ({
    ...v2ThreadShell,
    id: ThreadId.make(id),
    space: {
      kind: "task" as const,
      spaceId,
      createdBy: kousik,
      description: "Do it",
      base: { baseRef: "main" },
    },
    ...patch,
  });
  const run = RunId.make("run-1");
  const pendingRequest = (kind: "user_input" | "permission") => ({
    id: RuntimeRequestId.make(`request-${kind}`),
    kind,
    createdAt: at("2026-11-10T09:00:00Z"),
  });
  const threads = [
    task("unstarted-mine", {
      latestRunId: null,
      ownerId: rutvik,
      updatedAt: at("2026-11-10T10:00:00Z"),
    }),
    task("needs-mine", {
      latestRunId: run,
      status: "running",
      ownerId: rutvik,
      pendingRuntimeRequest: pendingRequest("user_input"),
      updatedAt: at("2026-11-10T09:00:00Z"),
    }),
    task("needs-other", {
      latestRunId: run,
      status: "running",
      ownerId: hanad,
      pendingRuntimeRequest: pendingRequest("permission"),
      updatedAt: at("2026-11-10T11:00:00Z"),
    }),
    task("done", { latestRunId: run, status: "completed", ownerId: hanad }),
  ];

  it("groups by section, with only the viewer's needs under Needs you", () => {
    expect(
      groupSpaceOverview(threads, viewer).map((section) => [
        section.id,
        section.rows.map((row) => row.thread.id),
      ]),
    ).toEqual([
      ["needs-you", ["needs-mine"]],
      ["in-progress", ["needs-other"]],
      ["not-started", ["unstarted-mine"]],
      ["done", ["done"]],
    ]);
  });

  it("counts an unstarted task as needing its owner", () => {
    expect(spaceTasksNeedingViewer(threads, viewer).map((row) => row.thread.id)).toEqual([
      "unstarted-mine",
      "needs-mine",
    ]);
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

  it("splits task controls between its owner and its creator", () => {
    const unstarted = {
      ...v2ThreadShell,
      latestRunId: null,
      ownerId: rutvik,
      space: {
        kind: "task" as const,
        spaceId,
        createdBy: kousik,
        description: "Do it",
        base: { baseRef: "main" },
      },
    };
    expect(spaceTaskControls(unstarted, space, rutvik, true)).toMatchObject({
      canStart: true,
      canNudge: false,
      modelLocked: false,
    });
    expect(spaceTaskControls(unstarted, space, kousik, true)).toMatchObject({
      canStart: false,
      canNudge: true,
      modelLocked: true,
    });
    expect(spaceTaskControls(unstarted, space, hanad, true)).toMatchObject({
      canStart: false,
      canNudge: false,
    });
    const running = { ...unstarted, latestRunId: RunId.make("run-1"), status: "running" as const };
    expect(spaceTaskControls(running, space, kousik, true)).toMatchObject({
      canNudge: false,
      stopNeedsConfirm: true,
    });
  });
});
