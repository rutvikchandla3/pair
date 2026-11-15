import type { LineageShell, LineageViewer } from "@t3tools/client-runtime/branch-lineage";
import {
  MemberId,
  type OrchestrationV2ThreadShellBranchLink,
  RunId,
  SandboxId,
  type ThreadBranchOffDraft,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type BranchOffForm,
  branchOffInput,
  branchOffStartFromOptions,
  lineageComposerModel,
  lineageMenuItems,
  lineageShareRestriction,
} from "./lineagePresentation";

const kousik = MemberId.make("mem-kousik");
const hanad = MemberId.make("mem-hanad");
const NAMES: Record<string, string> = { [kousik]: "Kousik", [hanad]: "Hanad" };
const viewerAs = (memberId: MemberId): LineageViewer => ({
  memberId,
  nameOf: (id) => NAMES[id] ?? "Former member",
});
const asHanad = viewerAs(hanad);
const asKousik = viewerAs(kousik);

const sourceId = ThreadId.make("thr-prompt-builder");
const branchId = ThreadId.make("thr-rationale");
const sandboxId = SandboxId.make("sbx_0123456789abcdef0123");

type BranchLinkSource = NonNullable<OrchestrationV2ThreadShellBranchLink["source"]>;

const sourceShell = (overrides: Partial<LineageShell> = {}): LineageShell => ({
  id: sourceId,
  title: "Prompt builder",
  branch: "kousik/prompt-builder",
  ownerId: kousik,
  sandboxId,
  activeRunId: null,
  pendingRuntimeRequest: null,
  archivedAt: null,
  settledAt: null,
  ...overrides,
});

const branchShell = (source: Partial<BranchLinkSource> = {}): LineageShell =>
  sourceShell({
    id: branchId,
    title: "Rationale per question",
    branch: "hanad/rationale-per-question",
    ownerId: hanad,
    sandbox: { state: "ready", ownerThreadId: sourceId },
    branchLink: {
      revision: 1,
      openOffers: 0,
      source: {
        threadId: sourceId,
        ownerId: kousik,
        title: "Prompt builder",
        state: "open",
        toOffer: 2,
        behind: 1,
        updateInProgress: null,
        undoableUpdate: false,
        offerState: null,
        allApplied: false,
        shippedLabel: null,
        unshipped: 0,
        ...source,
      },
    },
  });

describe("lineageMenuItems", () => {
  it("offers Branch off… on someone else's cloud thread, naming whose latest", () => {
    expect(lineageMenuItems(sourceShell(), asHanad)).toEqual([
      { id: "branchOff", title: "Branch off…", subtitle: "Your own branch, from Kousik's latest" },
    ]);
  });

  it("offers Update, Offer and Move to my own machine on your branch on their machine", () => {
    expect(lineageMenuItems(branchShell(), asHanad).map((item) => item.title)).toEqual([
      "Update from Prompt builder",
      "Offer to Kousik",
      "Move to my own machine",
    ]);
  });

  it("holds Share for your branch on someone else's machine until you move it", () => {
    expect(lineageShareRestriction(branchShell(), asHanad)).toBe(
      "On Kousik's machine, sharing follows Kousik's list.",
    );
    expect(lineageShareRestriction(sourceShell(), asKousik)).toBeNull();
  });

  it("offers nothing on someone else's branch or a local thread", () => {
    expect(lineageMenuItems(branchShell(), asKousik)).toEqual([]);
    const { sandboxId: _cloud, ...local } = sourceShell();
    expect(lineageMenuItems(local, asHanad)).toEqual([]);
  });
});

describe("lineageComposerModel", () => {
  it("says where a message goes on someone else's cloud thread, with Branch off", () => {
    expect(lineageComposerModel(sourceShell(), asHanad).hint?.text).toBe(
      "Goes into Kousik's conversation",
    );
    expect(
      lineageComposerModel(sourceShell({ activeRunId: RunId.make("run-1") }), asHanad).hint?.text,
    ).toBe("Goes into Kousik's conversation, after the current turn");
    expect(lineageComposerModel(sourceShell(), asKousik).hint).toBeNull();
  });

  it("pins the open update with Abort for the branch's holder only, and holds Update and Offer", () => {
    const updating = branchShell({
      updateInProgress: { conflictedPaths: ["src/schema.ts"], resolver: "self" },
    });
    const mine = lineageComposerModel(updating, asHanad);
    expect(mine.resolving).toMatchObject({
      line: "Resolving update from Prompt builder · src/schema.ts",
      canAbort: true,
    });
    expect(mine.actions).toEqual([]);
    expect(lineageComposerModel(updating, asKousik).resolving?.canAbort).toBe(false);
  });

  it("shows Update and Offer on your own branch when each has work", () => {
    expect(lineageComposerModel(branchShell(), asHanad).actions.map((a) => a.kind)).toEqual([
      "update",
      "offer",
    ]);
    expect(
      lineageComposerModel(branchShell({ behind: 0 }), asHanad).actions.map((a) => a.kind),
    ).toEqual(["offer"]);
  });
});

describe("branch off draft", () => {
  const draft = (overrides: Partial<ThreadBranchOffDraft> = {}): ThreadBranchOffDraft => ({
    allowed: true,
    sourceTitle: "Prompt builder",
    sourceOwnerId: kousik,
    latestTurn: { turn: 6, at: null, uncommittedFiles: 2 },
    turns: [
      { runId: RunId.make("run-4"), turn: 4, at: "2026-11-15T10:00:00.000Z", title: "Schema v2" },
      { runId: RunId.make("run-5"), turn: 5, at: "2026-11-15T10:30:00.000Z", title: "Preview" },
    ],
    machine: { state: "ready", working: 1, ownerId: kousik },
    audience: [kousik, hanad],
    busy: false,
    suggestedBranch: "hanad/rationale-per-question",
    ...overrides,
  });
  const form = (overrides: Partial<BranchOffForm> = {}): BranchOffForm => ({
    startFrom: { type: "latest" },
    baseBranch: "main",
    runsOn: "source-machine",
    branch: "hanad/rationale-per-question",
    prompt: "Add a one-line rationale to each question",
    summary: null,
    ...overrides,
  });
  const choices = ["source-machine", "new-machine"] as const;

  it("lists the latest checkpoint, then turns newest first, then a branch", () => {
    expect(branchOffStartFromOptions(draft(), "turn 6 · with 2 uncommitted files")).toEqual([
      {
        id: "latest",
        value: { type: "latest" },
        title: "Latest · turn 6 · with 2 uncommitted files",
      },
      {
        id: "turn:run-5",
        value: { type: "turn", runId: RunId.make("run-5") },
        title: "Turn 5 · Preview",
      },
      {
        id: "turn:run-4",
        value: { type: "turn", runId: RunId.make("run-4") },
        title: "Turn 4 · Schema v2",
      },
      { id: "branch", value: { type: "branch" }, title: "A branch…" },
    ]);
  });

  it("sends the edited summary with the prompt and the chosen start", () => {
    expect(
      branchOffInput(
        draft(),
        sourceId,
        form({ startFrom: { type: "branch" }, baseBranch: " main ", summary: " So far… " }),
        choices,
      ),
    ).toEqual({
      sourceThreadId: sourceId,
      runsOn: "source-machine",
      startFrom: { type: "branch", branch: "main" },
      branch: "hanad/rationale-per-question",
      prompt: "Add a one-line rationale to each question",
      contextSummary: "So far…",
    });
  });

  it("holds Branch off until it can be sent", () => {
    expect(
      branchOffInput(draft({ allowed: false, reason: "no-account" }), sourceId, form(), choices),
    ).toBeNull();
    expect(
      branchOffInput(draft(), sourceId, form({ prompt: " ", summary: null }), choices),
    ).toBeNull();
    expect(
      branchOffInput(draft(), sourceId, form({ prompt: "", summary: "Context" }), choices),
    ).not.toBeNull();
    expect(branchOffInput(draft(), sourceId, form({ branch: " " }), choices)).toBeNull();
    expect(
      branchOffInput(
        draft(),
        sourceId,
        form({ startFrom: { type: "branch" }, baseBranch: "" }),
        choices,
      ),
    ).toBeNull();
    expect(branchOffInput(draft(), sourceId, form(), ["new-machine"])).toBeNull();
  });
});
