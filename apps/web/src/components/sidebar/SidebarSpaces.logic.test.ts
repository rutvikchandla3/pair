import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  MemberId,
  type OrchestrationV2ThreadShell,
  SpaceId,
  SpaceTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  reorderSidebarSpaces,
  sidebarBranchOwnersBySource,
  sidebarSelectedSpaceId,
  sidebarThreadLead,
} from "./SidebarSpaces.logic";

const ENV = EnvironmentId.make("env-team");
const OTHER_ENV = EnvironmentId.make("env-other");
const SPACE = SpaceId.make("spc_00000000000000000001");
const TASK = SpaceTaskId.make("stk_00000000000000000001");
const TASK_THREAD = ThreadId.make("thread-on-task");
const HANAD = MemberId.make("member-hanad");
const ASHA = MemberId.make("member-asha");

const taskSpace = {
  kind: "task",
  spaceId: SPACE,
  taskId: TASK,
  linkedBy: HANAD,
  linkedAt: "2026-11-15T10:00:00.000Z",
  via: "start",
} as const;

type BranchLink = NonNullable<OrchestrationV2ThreadShell["branchLink"]>;
const branchOf = (threadId: string, title: string | null): BranchLink => ({
  revision: 1,
  source: {
    threadId: ThreadId.make(threadId),
    ownerId: HANAD,
    title,
    state: "open",
    toOffer: 0,
    behind: 0,
    updateInProgress: null,
    undoableUpdate: false,
    offerState: null,
    allApplied: false,
    shippedLabel: null,
    unshipped: 0,
  },
  openOffers: 0,
});

describe("sidebarSelectedSpaceId", () => {
  const threadSpaceId = (threadId: ThreadId) => (threadId === TASK_THREAD ? SPACE : null);
  it.each([
    ["the room", { environmentId: ENV, spaceId: SPACE }, SPACE],
    ["a task page", { environmentId: ENV, spaceId: SPACE, taskId: TASK }, SPACE],
    ["a thread on one of its tasks", { environmentId: ENV, threadId: TASK_THREAD }, SPACE],
    ["a thread on no task", { environmentId: ENV, threadId: "thread-solo" }, null],
    ["another environment's room", { environmentId: OTHER_ENV, spaceId: SPACE }, null],
    ["a page outside spaces", {}, null],
  ])("%s", (_name, route, expected) => {
    expect(sidebarSelectedSpaceId({ environmentId: ENV, route, threadSpaceId })).toBe(expected);
  });
});

describe("reorderSidebarSpaces", () => {
  const [a, b, c] = ["a", "b", "c"].map((id) => SpaceId.make(`spc_${id.padStart(20, "0")}`)) as [
    SpaceId,
    SpaceId,
    SpaceId,
  ];
  it("moves the dragged space onto the target's place, and ignores no-op drops", () => {
    expect(reorderSidebarSpaces([a, b, c], c, a)).toEqual([c, a, b]);
    expect(reorderSidebarSpaces([a, b, c], a, c)).toEqual([b, c, a]);
    const ids = [a, b, c];
    expect(reorderSidebarSpaces(ids, a, a)).toBe(ids);
    expect(reorderSidebarSpaces(ids, a, SpaceId.make("spc_00000000000000000fff"))).toBe(ids);
  });
});

describe("sidebarThreadLead", () => {
  const names = {
    spaceName: (spaceId: SpaceId) => (spaceId === SPACE ? "Question creation" : null),
    taskTitle: (taskId: string) => (taskId === TASK ? "Seed role catalog" : null),
  };
  it.each([
    ["a plain thread", {}, null],
    ["a room", { space: { kind: "room", spaceId: SPACE } }, null],
    [
      "a thread on a space task",
      { space: taskSpace },
      { glyph: "space", label: "Question creation › Seed role catalog" },
    ],
    [
      "a thread on a task no longer open",
      { space: { ...taskSpace, taskId: SpaceTaskId.make("stk_00000000000000000fff") } },
      { glyph: "space", label: "Question creation" },
    ],
    [
      "a branch, even on a task",
      { space: taskSpace, branchLink: branchOf("source", "Prompt builder") },
      { glyph: "branch", label: "Branched from Prompt builder" },
    ],
    [
      "a branch of a thread the viewer can't open",
      { branchLink: branchOf("source", null) },
      { glyph: "branch", label: "Branched from a thread you can't open" },
    ],
    [
      "a source, which isn't a branch",
      { branchLink: { revision: 1, source: null, openOffers: 2 } },
      null,
    ],
  ] as const)("%s", (_name, shell, expected) => {
    expect(
      sidebarThreadLead(shell as Pick<OrchestrationV2ThreadShell, "space" | "branchLink">, names),
    ).toEqual(expected);
  });
});

describe("sidebarBranchOwnersBySource", () => {
  it("lists each source's branchers once, per environment", () => {
    const shell = (
      environmentId: EnvironmentId,
      id: string,
      ownerId: MemberId | null,
      branchLink?: BranchLink,
    ) => ({
      environmentId,
      id: ThreadId.make(id),
      source: { ownerId, ...(branchLink === undefined ? {} : { branchLink }) },
    });
    const owners = sidebarBranchOwnersBySource([
      shell(ENV, "source", HANAD),
      shell(ENV, "branch-1", ASHA, branchOf("source", "Source")),
      shell(ENV, "branch-2", HANAD, branchOf("source", "Source")),
      shell(ENV, "branch-3", ASHA, branchOf("source", "Source")),
      shell(OTHER_ENV, "branch-4", ASHA, branchOf("elsewhere", "Elsewhere")),
    ]);
    expect([...owners]).toEqual([
      [scopedThreadKey(scopeThreadRef(ENV, ThreadId.make("source"))), `${ASHA},${HANAD}`],
      [scopedThreadKey(scopeThreadRef(OTHER_ENV, ThreadId.make("elsewhere"))), ASHA],
    ]);
  });
});
