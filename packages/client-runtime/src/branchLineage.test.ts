import {
  type BranchLineage,
  EnvironmentId,
  type LineageNotice,
  type LineageView,
  MemberId,
  type Offer,
  OfferId,
  type OfferPreview,
  type OrchestrationV2ThreadShellBranchLink,
  RunId,
  SandboxId,
  type ThreadBranchOffDraft,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  type LineageShell,
  type LineageViewer,
  branchOffDraftCopy,
  composerBranchOffHint,
  gitButtonLineageWarning,
  joinNames,
  lineageBranchesOf,
  lineageChipCopy,
  lineageNoticeCopy,
  lineagePopoverRows,
  machineOthersNote,
  menuItemsForCloudThread,
  offerCardCopy,
  offerDialogCopy,
  parseRememberedRunsOn,
  rememberedRunsOnKey,
  removeMemberMachineNote,
  resolvingRowCopy,
  revertAcrossApplyNote,
  runsOnOptions,
  sourceKeepsMachineNote,
  updateDialogCopy,
} from "./branchLineage.ts";

const kousik = MemberId.make("mem-kousik");
const hanad = MemberId.make("mem-hanad");
const rutvik = MemberId.make("mem-rutvik");
const ankur = MemberId.make("mem-ankur");
const NAMES: Record<string, string> = {
  [kousik]: "Kousik",
  [hanad]: "Hanad",
  [rutvik]: "Rutvik",
  [ankur]: "Ankur",
};
const viewerAs = (memberId: MemberId): LineageViewer => ({
  memberId,
  nameOf: (id) => NAMES[id] ?? "Former member",
});
const asHanad = viewerAs(hanad);
const asKousik = viewerAs(kousik);
const asRutvik = viewerAs(rutvik);

const sourceId = ThreadId.make("thr-prompt-builder");
const branchId = ThreadId.make("thr-rationale");
const otherBranchId = ThreadId.make("thr-loading");
const sandboxId = SandboxId.make("sbx_0123456789abcdef0123");
const offerId = OfferId.make("ofr_0123456789abcdef0123");
const olderOfferId = OfferId.make("ofr_0000000000000000000a");

type BranchLinkSource = NonNullable<OrchestrationV2ThreadShellBranchLink["source"]>;

const linkTo = (source: Partial<BranchLinkSource> = {}): OrchestrationV2ThreadShellBranchLink => ({
  revision: 1,
  openOffers: 0,
  source: {
    threadId: sourceId,
    ownerId: kousik,
    title: "Prompt builder",
    state: "open",
    toOffer: 0,
    behind: 0,
    updateInProgress: null,
    undoableUpdate: false,
    offerState: null,
    allApplied: false,
    shippedLabel: null,
    unshipped: 0,
    ...source,
  },
});

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

const branchShell = (
  source: Partial<BranchLinkSource> = {},
  overrides: Partial<LineageShell> = {},
): LineageShell =>
  sourceShell({
    id: branchId,
    title: "Rationale per question",
    branch: "hanad/rationale-per-question",
    ownerId: hanad,
    branchLink: linkTo(source),
    sandbox: { state: "ready", ownerThreadId: sourceId },
    ...overrides,
  });

const offer = (overrides: Partial<Offer> = {}): Offer => ({
  id: offerId,
  sourceThreadId: sourceId,
  branchThreadId: branchId,
  senderId: hanad,
  senderKind: "person",
  note: "Adds a one-line rationale to each question.",
  state: "open",
  commits: [
    { sha: "a1b2c3d", subject: "Add a rationale to the Question schema", authorName: "Hanad" },
    { sha: "e4f5a6b", subject: "Show the rationale under each question", authorName: "Hanad" },
  ],
  files: [
    { path: "src/schema.ts", status: "modified", additions: 2, deletions: 0 },
    { path: "src/rationale.ts", status: "added", additions: 38, deletions: 0 },
    { path: "src/Preview.tsx", status: "modified", additions: 44, deletions: 12 },
  ],
  additions: 84,
  deletions: 12,
  base: "base",
  tip: "tip",
  replaced: false,
  armedAt: null,
  returnReason: null,
  returnPaths: [],
  decidedBy: null,
  decidedAt: null,
  revertedAt: null,
  revertedBy: null,
  waiting: null,
  createdAt: "2026-11-15T11:41:00.000Z",
  updatedAt: "2026-11-15T11:41:00.000Z",
  ...overrides,
});

const lineageRecord = (overrides: Partial<BranchLineage> = {}): BranchLineage => ({
  branchThreadId: branchId,
  sourceThreadId: sourceId,
  sourceOwnerId: kousik,
  createdAt: "2026-11-15T11:12:00.000Z",
  createdBy: hanad,
  runsOn: "source-machine",
  startFrom: { type: "latest" },
  snapshots: [
    {
      sha: "snap1",
      sourceRunId: null,
      sourceTurn: 6,
      createdAt: "2026-11-15T11:12:00.000Z",
      state: "on-branch",
      mergeCommit: null,
      undoCommit: null,
    },
  ],
  update: null,
  undoableUpdate: null,
  toOffer: { count: 2, commits: ["a1b2c3d", "e4f5a6b"] },
  behind: 1,
  sourceState: "open",
  shipped: null,
  unshipped: 0,
  reverted: null,
  revision: 1,
  ...overrides,
});

const branchView = (overrides: Partial<LineageView> = {}): LineageView => ({
  thread: { threadId: branchId, role: "branch" },
  source: {
    threadId: sourceId,
    title: "Prompt builder",
    ownerId: kousik,
    state: "open",
    canOpen: true,
  },
  branches: [
    {
      threadId: branchId,
      title: "Rationale per question",
      ownerId: hanad,
      branch: "hanad/rationale-per-question",
      runsOn: "source-machine",
      toOffer: 2,
      behind: 1,
      workState: "idle",
    },
  ],
  lineage: lineageRecord(),
  offers: [],
  ...overrides,
});

const sourceView = (overrides: Partial<LineageView> = {}): LineageView =>
  branchView({
    thread: { threadId: sourceId, role: "source" },
    source: null,
    lineage: null,
    ...overrides,
  });

describe("joinNames", () => {
  it("joins with commas and a final and", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["Kousik"])).toBe("Kousik");
    expect(joinNames(["Kousik", "Rutvik"])).toBe("Kousik and Rutvik");
    expect(joinNames(["Kousik", "Rutvik", "Ankur"])).toBe("Kousik, Rutvik and Ankur");
  });
});

describe("lineageBranchesOf", () => {
  it("lists the unarchived branches of a source", () => {
    const live = branchShell();
    const archived = branchShell(
      {},
      { id: otherBranchId, archivedAt: DateTime.makeUnsafe("2026-11-15T12:00:00.000Z") },
    );
    expect(lineageBranchesOf([sourceShell(), live, archived], sourceId)).toEqual([live]);
  });
});

describe("lineageChipCopy", () => {
  it("counts a source's branches and offers, accented when an offer waits on the viewer", () => {
    expect(lineageChipCopy(sourceShell(), [branchShell()], asKousik)).toEqual({
      role: "source",
      text: "1 branch",
      accent: false,
      actions: [{ kind: "branchOff", label: "Branch off…" }],
    });
    const withOffer = sourceShell({ branchLink: { revision: 2, source: null, openOffers: 1 } });
    const twoBranches = [branchShell(), branchShell({}, { id: otherBranchId })];
    expect(lineageChipCopy(withOffer, twoBranches, asKousik)).toMatchObject({
      text: "2 branches · 1 offer",
      accent: true,
    });
    expect(lineageChipCopy(withOffer, twoBranches, asRutvik)?.accent).toBe(false);
  });

  it("shows nothing on a thread without branches or offers", () => {
    expect(lineageChipCopy(sourceShell(), [], asKousik)).toBeNull();
  });

  it("reads to offer and behind on a branch, omitting zero parts", () => {
    expect(lineageChipCopy(branchShell({ toOffer: 2, behind: 1 }), [], asHanad)).toEqual({
      role: "branch",
      text: "from Prompt builder · 2 to offer · 1 behind",
      accent: false,
      actions: [
        { kind: "update", label: "Update from Prompt builder" },
        { kind: "offer", label: "Offer to Kousik" },
      ],
    });
    expect(lineageChipCopy(branchShell({ toOffer: 2 }), [], asHanad)).toMatchObject({
      text: "from Prompt builder · 2 to offer",
      actions: [{ kind: "offer", label: "Offer to Kousik" }],
    });
    expect(lineageChipCopy(branchShell(), [], asHanad)).toMatchObject({
      text: "from Prompt builder",
      actions: [],
    });
  });

  it("says Update after this turn while the branch's turn runs", () => {
    const running = branchShell({ behind: 1 }, { activeRunId: RunId.make("run-1") });
    expect(lineageChipCopy(running, [], asHanad)?.actions).toEqual([
      { kind: "update", label: "Update after this turn" },
    ]);
  });

  it("offers no actions to someone who doesn't own the branch, and never Branch off", () => {
    expect(lineageChipCopy(branchShell({ toOffer: 2, behind: 1 }), [], asRutvik)?.actions).toEqual(
      [],
    );
  });

  it("holds Update and Offer while an update is open", () => {
    const updating = branchShell({
      toOffer: 2,
      behind: 1,
      updateInProgress: { conflictedPaths: ["src/schema.ts"], resolver: "self" },
    });
    expect(lineageChipCopy(updating, [], asHanad)).toMatchObject({
      text: "from Prompt builder · updating",
      actions: [],
    });
  });

  it("names every state of a source that changed hands or disappeared", () => {
    const text = (source: Partial<BranchLinkSource>) =>
      lineageChipCopy(branchShell({ toOffer: 2, ...source }), [], asHanad);
    expect(text({ title: null, state: "unavailable" })).toMatchObject({
      text: "from a thread you can't open",
      actions: [],
    });
    expect(text({ state: "deleted" })).toMatchObject({
      text: "from a deleted thread",
      actions: [],
    });
    expect(text({ state: "archived", toOffer: 0 })?.text).toBe("from Prompt builder · archived");
  });

  it("names a shipped or settled source with the unshipped commits", () => {
    expect(
      lineageChipCopy(
        branchShell({ state: "shipped", shippedLabel: "pair-be#482", unshipped: 2 }),
        [],
        asHanad,
      ),
    ).toEqual({
      role: "branch",
      text: "Prompt builder shipped in pair-be#482 · 2 commits not in it",
      accent: false,
      actions: [
        { kind: "startFromMain", label: "Start from main with them" },
        { kind: "settle", label: "Settle" },
      ],
    });
    expect(
      lineageChipCopy(branchShell({ state: "settled", unshipped: 2 }), [], asHanad)?.text,
    ).toBe("Prompt builder is settled · 2 commits not in it");
    expect(
      lineageChipCopy(branchShell({ state: "settled", unshipped: 0 }), [], asHanad)?.actions,
    ).toEqual([{ kind: "settle", label: "Settle" }]);
  });

  it("reads all applied with Settle when nothing is left to offer", () => {
    expect(lineageChipCopy(branchShell({ allApplied: true }), [], asHanad)).toMatchObject({
      text: "from Prompt builder · all applied",
      actions: [{ kind: "settle", label: "Settle" }],
    });
  });
});

describe("lineagePopoverRows", () => {
  it("lists the source then its branches, from the viewer's side", () => {
    const working = sourceShell({ activeRunId: RunId.make("run-7") });
    expect(lineagePopoverRows(branchView(), [working], asHanad)).toEqual({
      heading: "Prompt builder and its branches",
      rows: [
        expect.objectContaining({
          threadId: sourceId,
          role: "source",
          title: "Prompt builder",
          isThisThread: false,
          owner: "Kousik",
          branch: "kousik/prompt-builder",
          workState: "working",
          where: "Kousik's machine",
          counts: null,
          meta: "Kousik · kousik/prompt-builder · working",
        }),
        expect.objectContaining({
          threadId: branchId,
          role: "branch",
          isThisThread: true,
          owner: "You",
          where: "Kousik's machine",
          counts: "2 commits to offer · 1 turn behind",
          meta: "You · hanad/rationale-per-question · idle",
        }),
      ],
    });
  });

  it("reads the source's own machine as yours, and a new-machine branch as its own", () => {
    const view = sourceView({
      branches: [{ ...branchView().branches[0]!, runsOn: "new-machine", toOffer: 0, behind: 0 }],
    });
    const rows = lineagePopoverRows(view, [sourceShell()], asKousik).rows;
    expect(rows.map((row) => [row.owner, row.where, row.isThisThread, row.counts])).toEqual([
      ["You", "Your machine", true, null],
      ["Hanad", "Its own machine", false, null],
    ]);
  });

  it("names a source the viewer can't open without its owner", () => {
    const view = branchView({
      source: { threadId: sourceId, title: null, ownerId: kousik, state: null, canOpen: false },
    });
    expect(lineagePopoverRows(view, [], asHanad)).toMatchObject({
      heading: "Branches",
      rows: [{ title: "a thread you can't open", canOpen: false, owner: null, meta: "" }, {}],
    });
  });
});

describe("runsOnOptions", () => {
  const draft = (overrides: Partial<ThreadBranchOffDraft> = {}): ThreadBranchOffDraft => ({
    allowed: true,
    sourceTitle: "Prompt builder",
    sourceOwnerId: kousik,
    latestTurn: { turn: 6, at: null, uncommittedFiles: 2 },
    turns: [],
    machine: { state: "ready", working: 1, vcpus: 4, ownerId: kousik },
    audience: [kousik, rutvik, ankur, hanad],
    busy: false,
    suggestedBranch: "hanad/rationale-per-question",
    ...overrides,
  });
  const choose = (
    input: ThreadBranchOffDraft,
    remembered: "source-machine" | "new-machine" | null = null,
  ) => runsOnOptions(input, asHanad, { remembered, providerName: "Claude" });

  it("selects the source's machine the first time, with both lines in full", () => {
    expect(choose(draft())).toEqual({
      options: [
        {
          value: "source-machine",
          label: "Kousik's machine",
          subtitle: "Seconds · 1 thread working",
        },
        {
          value: "new-machine",
          label: "New machine",
          subtitle: "About a minute · own database and services",
        },
      ],
      selected: "source-machine",
      reason: null,
      disclosures: {
        "source-machine":
          "Shares Kousik's running database and services. Kousik, Rutvik and Ankur can open this machine and reach your Claude and GitHub sign-ins from its terminal. Machine time counts toward Kousik.",
        "new-machine":
          "Its own database and services, on your machine time. Kousik, Rutvik and Ankur can open it and reach your Claude and GitHub sign-ins, as with any thread you share.",
      },
    });
  });

  it("remembers the last choice", () => {
    expect(choose(draft(), "new-machine").selected).toBe("new-machine");
    expect(choose(draft(), "source-machine").selected).toBe("source-machine");
  });

  it("selects New machine on a busy machine whatever was remembered, and says why", () => {
    const busy = choose(
      draft({ machine: { state: "ready", working: 3, vcpus: 4, ownerId: kousik } }),
      "source-machine",
    );
    expect(busy.selected).toBe("new-machine");
    expect(busy.options).toHaveLength(2);
    expect(busy.options[0]?.subtitle).toBe("Seconds · 3 threads working");
    expect(busy.reason).toBe(
      "Kousik's machine has 3 threads working on 4 vCPU, so New machine is selected. You can still pick it.",
    );
    expect(choose(draft({ busy: true })).selected).toBe("new-machine");
  });

  it("says an asleep machine wakes when you start", () => {
    const asleep = choose(draft({ machine: { state: "asleep", working: 0, ownerId: kousik } }));
    expect(asleep.selected).toBe("source-machine");
    const [option] = asleep.options;
    expect(`${option?.label} · ${option?.subtitle}`).toBe(
      "Kousik's machine · asleep, wakes when you start",
    );
  });

  it("offers only New machine when the source's machine failed or is gone", () => {
    const failed = choose(
      draft({ machine: { state: "failed", working: 0, ownerId: kousik } }),
      "source-machine",
    );
    expect(failed.options.map((option) => option.value)).toEqual(["new-machine"]);
    expect(failed.selected).toBe("new-machine");
    expect(failed.reason).toBe("Kousik's machine failed, so it runs on a new machine.");
    expect(choose(draft({ machine: { state: "gone", working: 0, ownerId: kousik } })).reason).toBe(
      "Kousik's machine was discarded, so it runs on a new machine.",
    );
  });

  it("words branching off your own thread without naming you", () => {
    const own = runsOnOptions(
      draft({
        sourceOwnerId: hanad,
        machine: { state: "ready", working: 0, ownerId: hanad },
        audience: [hanad],
      }),
      asHanad,
      { remembered: null, providerName: "Codex" },
    );
    expect(own.options[0]).toMatchObject({ label: "Your machine", subtitle: "Seconds" });
    expect(own.disclosures["source-machine"]).toBe("Shares your running database and services.");
    expect(own.disclosures["new-machine"]).toBe(
      "Its own database and services, on your machine time.",
    );
  });
});

describe("branchOffDraftCopy", () => {
  const draft: ThreadBranchOffDraft = {
    allowed: true,
    sourceTitle: "Prompt builder",
    sourceOwnerId: kousik,
    latestTurn: { turn: 6, at: null, uncommittedFiles: 2 },
    turns: [],
    machine: { state: "ready", working: 1, ownerId: kousik },
    audience: [],
    busy: false,
    suggestedBranch: "hanad/rationale-per-question",
    taskTitle: "Generate question from prompt",
  };

  it("words the draft without pronouns", () => {
    expect(branchOffDraftCopy(draft, asHanad, "Claude")).toEqual({
      title: "Branch off Prompt builder",
      subtitle:
        "Your own thread, branch and worktree, starting from what Kousik's agent has built so far. Prompt builder's conversation and files stay as they are.",
      latestLabel: "Prompt builder, latest",
      latestDetail: "turn 6 · with 2 uncommitted files",
      contextLabel: "Start with a summary of Prompt builder's conversation",
      contextHint: "Written on your account. It shows as your first message, and you can edit it.",
      taskLine: "Joins the task: Generate question from prompt",
      blocked: null,
    });
  });

  it("asks to connect the account when there is none", () => {
    expect(
      branchOffDraftCopy({ ...draft, allowed: false, reason: "no-account" }, asHanad, "Claude")
        .blocked,
    ).toEqual({
      text: "Connect Claude to branch off on your own account.",
      connect: "Connect Claude",
    });
  });
});

describe("composerBranchOffHint", () => {
  it("shows on someone else's cloud thread, after the current turn while one runs", () => {
    expect(composerBranchOffHint(sourceShell(), asHanad)).toEqual({
      text: "Goes into Kousik's conversation",
      running: false,
      prompt: "Want to work on your own?",
      cta: "Branch off",
    });
    expect(
      composerBranchOffHint(sourceShell({ activeRunId: RunId.make("run-7") }), asHanad),
    ).toMatchObject({
      text: "Goes into Kousik's conversation, after the current turn",
      running: true,
    });
  });

  it("hides on your own thread, a branch, a local thread and an archived one", () => {
    expect(composerBranchOffHint(sourceShell(), asKousik)).toBeNull();
    expect(composerBranchOffHint(branchShell(), asKousik)).toBeNull();
    const { sandboxId: _, ...local } = sourceShell();
    expect(composerBranchOffHint(local, asHanad)).toBeNull();
  });
});

describe("lineageNoticeCopy", () => {
  const inBranch = (
    notice: LineageNotice,
    view: LineageView | null = branchView(),
    viewer = asHanad,
    thread = branchShell({ toOffer: 2, behind: 1 }),
  ) => lineageNoticeCopy(notice, { viewer, thread, view });
  const inSource = (notice: LineageNotice, view: LineageView | null, viewer = asKousik) =>
    lineageNoticeCopy(notice, { viewer, thread: sourceShell(), view });

  it("words the branch-off rows for each side", () => {
    expect(
      inBranch({
        kind: "branched-from",
        actorId: hanad,
        sourceThreadId: sourceId,
        sourceOwnerId: kousik,
        turn: 6,
        uncommittedFiles: 2,
        runsOn: "source-machine",
      }),
    ).toMatchObject({
      text: "You branched off Kousik's Prompt builder at turn 6, with its 2 uncommitted files",
      detail: "on Kousik's machine",
      threadId: sourceId,
      action: null,
    });
    expect(
      inSource({ kind: "branched-off", actorId: hanad, branchThreadId: branchId }, sourceView()),
    ).toMatchObject({
      text: "Hanad branched off this thread → Rationale per question",
      threadId: branchId,
    });
  });

  it("offers Undo update only for the update still undoable", () => {
    const updated: LineageNotice = { kind: "updated", snapshotSha: "snap2", files: 2, turn: 7 };
    const undoable = branchView({
      lineage: lineageRecord({
        undoableUpdate: {
          snapshotSha: "snap2",
          mergeCommit: "m",
          preUpdateHead: "h",
          wipCommit: null,
        },
      }),
    });
    expect(inBranch(updated, undoable)).toMatchObject({
      text: "Updated from Prompt builder · turn 7, 2 files",
      action: { kind: "undoUpdate", label: "Undo update", hint: "until your next turn" },
    });
    expect(inBranch(updated, branchView()).action).toBeNull();
    expect(inBranch(updated, undoable, asRutvik).action).toBeNull();
    expect(inBranch(updated, null).action).toBeNull();
  });

  it("offers Abort update while the conflict is open", () => {
    const conflict: LineageNotice = { kind: "update-conflict", paths: ["src/schema.ts"] };
    const open = branchView({
      lineage: lineageRecord({
        update: {
          snapshotSha: "snap2",
          conflictedPaths: ["src/schema.ts"],
          resolver: "self",
          startedAt: "2026-11-15T12:10:00.000Z",
          preUpdateHead: "h",
          wipCommit: null,
        },
      }),
    });
    expect(inBranch(conflict, open)).toMatchObject({
      text: "Updating from Prompt builder · src/schema.ts has conflict markers",
      tone: "warning",
      action: { kind: "abortUpdate", label: "Abort update" },
    });
    expect(inBranch(conflict, branchView()).action).toBeNull();
  });

  it("says who the agent was told by", () => {
    expect(inBranch({ kind: "agent-told", text: "an update is in progress." }).text).toBe(
      "Your agent was told: an update is in progress.",
    );
    expect(inBranch({ kind: "agent-told", text: "x" }, branchView(), asKousik).text).toBe(
      "Hanad's agent was told: x",
    );
  });

  it("offers Withdraw on an open offer to its sender only", () => {
    const sent: LineageNotice = { kind: "offer-sent", offerId, senderId: hanad };
    const open = branchView({ offers: [offer()] });
    expect(inBranch(sent, open)).toMatchObject({
      text: "You offered 2 commits to Prompt builder",
      detail: "waiting for Kousik",
      action: { kind: "withdraw", label: "Withdraw", offerId },
    });
    expect(inBranch(sent, open, asRutvik)).toMatchObject({
      text: "Hanad offered 2 commits to Prompt builder",
      action: null,
    });
    const applied = branchView({ offers: [offer({ state: "applied" })] });
    expect(inBranch(sent, applied)).toMatchObject({ detail: null, action: null });
    expect(inBranch(sent, branchView({ offers: [offer({ replaced: true })] })).text).toBe(
      "You updated your offer · it replaces the open one",
    );
    expect(
      inBranch(sent, branchView({ offers: [offer({ waiting: "source-archived" })] })).detail,
    ).toBe("Waiting · Prompt builder is archived");
  });

  it("labels an agent's offer with its member", () => {
    const agentOffer = sourceView({ offers: [offer({ senderKind: "agent" })] });
    expect(inSource({ kind: "offer", offerId, senderId: hanad }, agentOffer)).toMatchObject({
      text: "Hanad's agent offers 2 commits from Rationale per question",
      cardOfferId: offerId,
    });
  });

  it("offers Revert on an applied offer to the source's holder until it's reverted", () => {
    const applied: LineageNotice = {
      kind: "applied",
      offerId,
      actorId: kousik,
      senderId: hanad,
      files: 3,
    };
    const view = sourceView({ offers: [offer({ state: "applied", decidedBy: kousik })] });
    expect(inSource(applied, view)).toMatchObject({
      text: "You applied Hanad's changes from Rationale per question · 3 files",
      action: { kind: "revertOffer", label: "Revert Hanad's changes", offerId },
    });
    expect(inSource(applied, view, asRutvik).action).toBeNull();
    const reverted = sourceView({
      offers: [offer({ state: "applied", revertedAt: "2026-11-15T12:30:00.000Z" })],
    });
    expect(inSource(applied, reverted).action).toBeNull();
    expect(inBranch(applied, branchView({ offers: [offer({ state: "applied" })] }))).toMatchObject({
      text: "Kousik applied your changes",
      tone: "success",
    });
  });

  it("offers Offer again on the latest declined offer while there's something to offer", () => {
    const declined: LineageNotice = { kind: "declined", offerId, actorId: kousik, senderId: hanad };
    const view = branchView({ offers: [offer({ state: "declined" })] });
    expect(inBranch(declined, view)).toMatchObject({
      text: "Kousik declined",
      action: { kind: "offerAgain", label: "Offer again", offerId },
    });
    const newer = branchView({
      offers: [
        offer({ state: "declined" }),
        offer({ id: olderOfferId, createdAt: "2026-11-15T11:50:00.000Z" }),
      ],
    });
    expect(inBranch(declined, newer).action).toBeNull();
    expect(inBranch(declined, view, asHanad, branchShell({ toOffer: 0 })).action).toBeNull();
    expect(inSource(declined, sourceView({ offers: [offer({ state: "declined" })] })).text).toBe(
      "You declined Hanad's 2 commits",
    );
  });

  it("offers Update and offer again on a returned offer", () => {
    const returned: LineageNotice = { kind: "returned", offerId, paths: ["src/schema.ts"] };
    const view = branchView({ offers: [offer({ state: "returned", returnReason: "conflict" })] });
    expect(inBranch(returned, view)).toMatchObject({
      text: "Prompt builder changed src/schema.ts after the offer was sent. Your offer came back",
      tone: "error",
      action: { kind: "updateAndOfferAgain", label: "Update and offer again", offerId },
    });
    const gone = branchView({
      offers: [offer({ state: "returned", returnReason: "source-gone" })],
    });
    expect(inBranch(returned, gone)).toMatchObject({
      text: "Prompt builder is no longer available. Your offer came back",
      action: null,
    });
  });

  it("words withdrawals, reverts and credited commits for the viewer", () => {
    expect(inBranch({ kind: "withdrawn", offerId, senderId: hanad }).text).toBe(
      "You withdrew your offer",
    );
    expect(inSource({ kind: "withdrawn", offerId, senderId: hanad }, sourceView()).text).toBe(
      "Hanad withdrew the offer",
    );
    expect(
      inSource(
        { kind: "reverted", offerId, actorId: kousik, senderId: hanad, files: 3 },
        sourceView({ offers: [offer({ state: "applied" })] }),
      ).text,
    ).toBe("You reverted Hanad's changes · 3 files");
    expect(
      inSource(
        {
          kind: "credited-commit",
          sha: "abc",
          subject: "Show a rationale under each question",
          coAuthor: hanad,
        },
        sourceView(),
      ).text,
    ).toBe('Committed "Show a rationale under each question" · Co-authored-by: Hanad');
  });

  it("says what a revert did to the branch, with Bring them back while it applies", () => {
    const reverted = offer({
      state: "applied",
      revertedBy: kousik,
      revertedAt: "2026-11-15T12:30:00.000Z",
    });
    expect(
      inBranch({ kind: "reverted-kept", offerId }, branchView({ offers: [reverted] })).text,
    ).toBe(
      "Kousik reverted your applied changes. You still have them here, and can offer them again.",
    );
    const removed = branchView({
      offers: [reverted],
      lineage: lineageRecord({ reverted: { offerId, keptHere: false, commits: ["a1b2c3d"] } }),
    });
    expect(inBranch({ kind: "reverted-removed", offerId }, removed)).toMatchObject({
      text: "Kousik reverted your applied changes, and this Update removed them here too",
      action: { kind: "bringBack", label: "Bring them back", offerId },
    });
    expect(
      inBranch({ kind: "reverted-removed", offerId }, branchView({ offers: [reverted] })).action,
    ).toBeNull();
    expect(inBranch({ kind: "brought-back", commits: ["a", "b"] }).text).toBe(
      "Brought back 2 commits, ready to offer",
    );
  });

  it("says who moved a thread to whose machine", () => {
    expect(inBranch({ kind: "moved-machine", actorId: kousik }).text).toBe(
      "Kousik moved this thread to your own machine",
    );
    expect(inBranch({ kind: "moved-machine", actorId: hanad }, branchView(), asRutvik).text).toBe(
      "Hanad moved this thread to Hanad's own machine",
    );
  });
});

describe("offerCardCopy", () => {
  const card = (value: Offer, viewer: LineageViewer, sourceRunning = false) =>
    offerCardCopy(value, {
      viewer,
      sourceHolderId: kousik,
      sourceRunning,
      branchTitle: "Rationale per question",
      sourceTitle: "Prompt builder",
    });

  it("lets an idle holder apply now", () => {
    expect(card(offer(), asKousik)).toEqual({
      state: "open",
      sender: "Hanad",
      header: "Hanad offers 2 commits from Rationale per question",
      updated: false,
      note: "Adds a one-line rationale to each question.",
      summary: "3 files",
      check: { text: "Applies cleanly · your agent is idle, so it applies now", tone: "success" },
      explainer:
        "Writes Hanad's changes into your files, uncommitted, next to your own work. Your next commit of them credits Hanad.",
      waitingFor: null,
      buttons: [
        { kind: "apply", label: "Apply", primary: true },
        { kind: "viewChanges", label: "View changes", primary: false },
        { kind: "decline", label: "Decline", primary: false },
      ],
    });
  });

  it("arms Apply during a turn, then reads Applies when this turn ends", () => {
    expect(card(offer(), asKousik, true)).toMatchObject({
      check: { text: "Applies cleanly now · checked again when this turn ends" },
      buttons: [
        { kind: "apply", label: "Apply when this turn ends" },
        { kind: "viewChanges" },
        { kind: "decline" },
      ],
    });
    expect(card(offer({ armedAt: "2026-11-15T11:42:00.000Z" }), asKousik, true)).toMatchObject({
      check: { text: "Applies when this turn ends" },
      buttons: [{ kind: "viewChanges" }, { kind: "decline" }],
    });
  });

  it("shows others who decides, and lets the sender withdraw", () => {
    expect(card(offer(), asRutvik)).toMatchObject({
      check: { text: "Applies cleanly" },
      explainer: null,
      waitingFor: "Waiting for Kousik",
      buttons: [{ kind: "viewChanges", label: "View changes", primary: false }],
    });
    expect(card(offer(), asHanad)).toMatchObject({
      header: "You offer 2 commits from Rationale per question",
      buttons: [{ kind: "viewChanges" }, { kind: "withdraw", label: "Withdraw" }],
    });
  });

  it("labels an agent's offer and an updated one", () => {
    expect(card(offer({ senderKind: "agent", replaced: true }), asKousik)).toMatchObject({
      sender: "Hanad's agent",
      header: "Hanad's agent offers 2 commits from Rationale per question",
      updated: true,
    });
  });

  it("closes to one quiet line", () => {
    const line = (value: Offer, viewer = asKousik) => {
      const copy = card(value, viewer);
      return copy.state === "closed" ? copy.line : null;
    };
    expect(line(offer({ state: "applied", decidedBy: kousik }))).toBe(
      "You applied Hanad's changes · 3 files",
    );
    expect(
      line(
        offer({ state: "applied", decidedBy: kousik, revertedAt: "2026-11-15T12:00:00.000Z" }),
        asRutvik,
      ),
    ).toBe("Kousik applied Hanad's changes · 3 files · reverted");
    expect(line(offer({ state: "declined", decidedBy: kousik }), asHanad)).toBe(
      "Kousik declined your 2 commits",
    );
    expect(line(offer({ state: "withdrawn" }))).toBe("Hanad withdrew the offer");
    expect(line(offer({ state: "returned" }))).toBe(
      "Hanad's offer came back · it no longer applies cleanly",
    );
  });
});

describe("offerDialogCopy", () => {
  const preview = (
    check: OfferPreview["check"],
    uncommittedFiles: string[] = [],
  ): OfferPreview => ({
    commits: offer().commits,
    files: offer().files,
    additions: 84,
    deletions: 12,
    uncommittedFiles,
    check,
    sourceTitle: "Prompt builder",
    sourceOwnerId: kousik,
  });

  it("words a clean offer", () => {
    expect(
      offerDialogCopy(preview({ clean: true }, ["src/x.ts"]), {
        viewer: asHanad,
        lineage: null,
        sourceTurn: 7,
      }),
    ).toEqual({
      title: "Offer your changes to Prompt builder",
      description:
        "Kousik sees them in Prompt builder and chooses Apply or Decline. Apply writes your changes into Kousik's files between turns, and Kousik's next commit of them credits you.",
      summary: "2 commits · 3 files",
      uncommitted: "Your 1 uncommitted file is committed first, as you.",
      check: {
        clean: true,
        text: "Applies cleanly on Prompt builder's latest checkpoint (turn 7), uncommitted work included",
        note: "Kousik sees only your lines: the diff starts from your last update of Kousik's work.",
      },
      footer: "You can withdraw it until Kousik applies it.",
      primary: { kind: "offer", label: "Offer to Kousik" },
    });
  });

  it("refuses to send what wouldn't apply, and leads to Update", () => {
    const refused = offerDialogCopy(preview({ clean: false, paths: ["src/schema.ts"] }), {
      viewer: asHanad,
      lineage: lineageRecord(),
      sourceTurn: null,
    });
    expect(refused).toMatchObject({
      check: {
        clean: false,
        text: "Prompt builder changed src/schema.ts since you branched.",
        note: "Update from Prompt builder first. You or your agent resolve it in your branch, and Kousik's files are never touched.",
      },
      footer: "Nothing is offered until it applies cleanly.",
      primary: { kind: "update", label: "Update from Prompt builder" },
    });
    const updatedOnce = lineageRecord({
      snapshots: [...lineageRecord().snapshots, { ...lineageRecord().snapshots[0]!, sha: "snap2" }],
    });
    expect(
      offerDialogCopy(preview({ clean: false, paths: ["src/schema.ts"] }), {
        viewer: asHanad,
        lineage: updatedOnce,
        sourceTurn: null,
      }).check.text,
    ).toBe("Prompt builder changed src/schema.ts since your last Update.");
  });
});

describe("updateDialogCopy", () => {
  const files = [
    { path: "src/Preview.tsx", status: "clean" as const },
    { path: "src/loading.tsx", status: "clean" as const },
    { path: "src/schema.ts", status: "conflict" as const },
  ];

  it("previews a conflict with both choices and their cost", () => {
    expect(
      updateDialogCopy(
        { files, conflicts: ["src/schema.ts"], behind: 1, sourceTitle: "Prompt builder" },
        { viewer: asHanad, sourceOwnerId: kousik, providerName: "Claude", turnRunning: false },
      ),
    ).toEqual({
      title: "Update from Prompt builder",
      summary: "3 files changed on Prompt builder since your last Update. 1 conflicts with yours.",
      files: [
        { path: "src/Preview.tsx", conflict: false, label: "merges cleanly" },
        { path: "src/loading.tsx", conflict: false, label: "merges cleanly" },
        { path: "src/schema.ts", conflict: true, label: "conflicts with your edit" },
      ],
      choices: [
        {
          value: "agent",
          label: "Update and let my agent resolve it",
          cost: "Starts one turn on your Claude account to resolve src/schema.ts, then commits.",
        },
        {
          value: "self",
          label: "Update and resolve it myself",
          cost: "Leaves conflict markers in your worktree. Kousik's files are never touched.",
        },
      ],
      footer: "You can abort until it's resolved.",
      primary: "Update",
    });
  });

  it("merges a clean update at once, after the turn while one runs", () => {
    const clean = updateDialogCopy(
      { files: files.slice(0, 2), conflicts: [], behind: 1, sourceTitle: "Prompt builder" },
      { viewer: asHanad, sourceOwnerId: kousik, providerName: "Claude", turnRunning: true },
    );
    expect(clean).toMatchObject({
      summary: "2 files changed on Prompt builder since your last Update.",
      choices: [],
      footer: null,
      primary: "Update after this turn",
    });
  });
});

describe("resolvingRowCopy", () => {
  it("pins the open update with Abort update", () => {
    expect(
      resolvingRowCopy({ conflictedPaths: ["src/schema.ts"], resolver: "self" }, "Prompt builder"),
    ).toEqual({
      text: "Resolving update from Prompt builder",
      paths: ["src/schema.ts"],
      line: "Resolving update from Prompt builder · src/schema.ts",
      action: { kind: "abortUpdate", label: "Abort update" },
    });
  });
});

describe("gitButtonLineageWarning", () => {
  it("warns before pushing a branch of an open source", () => {
    expect(gitButtonLineageWarning(branchShell(), asHanad)).toBe(
      "Prompt builder's pull request ships this work. Pushing also includes Kousik's unpushed work, authored as Kousik.",
    );
    expect(gitButtonLineageWarning(branchShell({ state: "shipped" }), asHanad)).toBeNull();
    expect(gitButtonLineageWarning(sourceShell(), asKousik)).toBeNull();
  });
});

describe("revertAcrossApplyNote", () => {
  const target = "2026-11-15T11:30:00.000Z";

  it("names applied changes decided after the target turn and not reverted", () => {
    const view = {
      offers: [
        offer({ state: "applied", decidedAt: "2026-11-15T11:43:00.000Z" }),
        offer({ id: olderOfferId, state: "applied", decidedAt: "2026-11-15T11:00:00.000Z" }),
        offer({
          state: "applied",
          decidedAt: "2026-11-15T11:50:00.000Z",
          revertedAt: "2026-11-15T11:55:00.000Z",
        }),
        offer({ state: "declined", decidedAt: "2026-11-15T11:44:00.000Z" }),
      ],
    };
    expect(revertAcrossApplyNote(view, target, asKousik)).toBe(
      "This also discards Hanad's applied changes (3 files). Hanad's branch keeps them, so they can be offered again.",
    );
    expect(revertAcrossApplyNote({ offers: [] }, target, asKousik)).toBeNull();
  });

  it("names each sender", () => {
    const view = {
      offers: [
        offer({ state: "applied", decidedAt: "2026-11-15T11:43:00.000Z" }),
        offer({
          senderId: ankur,
          state: "applied",
          decidedAt: "2026-11-15T11:45:00.000Z",
          files: [offer().files[0]!],
        }),
      ],
    };
    expect(revertAcrossApplyNote(view, target, asKousik)).toBe(
      "This also discards Hanad's applied changes (3 files) and Ankur's applied changes (1 file). Their branches keep them, so they can be offered again.",
    );
  });
});

describe("machine rules", () => {
  const threads = [
    { ownerId: kousik, title: "Prompt builder" },
    { ownerId: hanad, title: "Rationale per question" },
  ];

  it("names others' threads before Sleep or Discard", () => {
    expect(machineOthersNote(threads, asKousik, "sleep")).toBe(
      "Hanad's Rationale per question is on this machine too.",
    );
    expect(machineOthersNote(threads, asKousik, "discard")).toBe(
      "Hanad's Rationale per question is on this machine too. Hanad's agent stops there. Work up to its last turn is kept, and Hanad's next message offers a new machine.",
    );
    expect(machineOthersNote(threads.slice(0, 1), asKousik, "sleep")).toBeNull();
  });

  it("asks before settling or archiving a source others still use", () => {
    expect(sourceKeepsMachineNote(threads, asKousik)).toBe(
      "Hanad's thread is still on this machine and keeps it running.",
    );
    expect(
      sourceKeepsMachineNote([...threads, { ownerId: ankur, title: "Loading state" }], asKousik),
    ).toBe("Hanad's and Ankur's threads are still on this machine and keep it running.");
  });

  it("offers to move a removed member's threads first", () => {
    expect(removeMemberMachineNote(hanad, 1, asKousik)).toEqual({
      body: "Hanad has 1 thread on this machine and will lose access to it.",
      moveFirst: "Move it to Hanad's own machine first",
    });
    expect(removeMemberMachineNote(hanad, 0, asKousik)).toBeNull();
  });
});

describe("menuItemsForCloudThread", () => {
  const summary = (items: ReturnType<typeof menuItemsForCloudThread>) =>
    items?.map((item) => [item.label, item.disabled, item.readOnly]);

  it("gives a non-owner Branch off and a read-only Side chat, and owner-only items disabled", () => {
    expect(summary(menuItemsForCloudThread(sourceShell(), asHanad))).toEqual([
      ["Branch off…", false, false],
      ["Side chat", false, true],
      ["Follow", false, false],
      ["Copy link", false, false],
      ["Continue locally", false, false],
      ["Share… (owner only)", true, false],
      ["Assign to… (owner only)", true, false],
    ]);
    expect(menuItemsForCloudThread(sourceShell(), asHanad)?.[0]?.detail).toBe(
      "Your own branch, from Kousik's latest",
    );
  });

  it("keeps Fork for the owner, and Move to my own machine on someone else's machine", () => {
    expect(summary(menuItemsForCloudThread(sourceShell(), asKousik))).toEqual([
      ["Branch off…", false, false],
      ["Side chat", false, false],
      ["Copy link", false, false],
      ["Continue locally", false, false],
      ["Share…", false, false],
      ["Assign to…", false, false],
      ["Fork", false, false],
    ]);
    const items = menuItemsForCloudThread(branchShell(), asHanad);
    expect(summary(items)?.map(([label]) => label)).toEqual([
      "Side chat",
      "Copy link",
      "Continue locally",
      "Share…",
      "Assign to…",
      "Fork",
      "Move to my own machine",
    ]);
    expect(items?.find((item) => item.id === "share")).toMatchObject({
      disabled: true,
      disabledReason: "On Kousik's machine, sharing follows Kousik's list.",
    });
  });

  it("leaves local threads alone", () => {
    const { sandboxId: _, ...local } = sourceShell();
    expect(menuItemsForCloudThread(local, asHanad)).toBeNull();
  });
});

describe("remembered Runs on", () => {
  it("is stored per environment and reads back only known choices", () => {
    expect(rememberedRunsOnKey(EnvironmentId.make("env-1"))).toBe(
      "t3code:branch-off:runs-on:env-1",
    );
    expect(parseRememberedRunsOn("new-machine")).toBe("new-machine");
    expect(parseRememberedRunsOn("isolated")).toBeNull();
    expect(parseRememberedRunsOn(null)).toBeNull();
  });
});
