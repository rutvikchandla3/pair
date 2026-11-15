import {
  type ComposerBranchOffHint,
  type LineageAction,
  type LineageShell,
  type LineageViewer,
  type ResolvingRowCopy,
  composerBranchOffHint,
  lineageChipCopy,
  lineageHolderOf,
  menuItemsForCloudThread,
  resolvingRowCopy,
} from "@t3tools/client-runtime/branch-lineage";
import type {
  LineageRunsOn,
  RunId,
  ThreadBranchOffDraft,
  ThreadBranchOffInput,
} from "@t3tools/contracts";

// Mobile's side of Branch off (docs/product/spaces-redesign.md Part 2, "Where it shows → Mobile").
// The words come from client-runtime; this decides which of them a phone shows where.

export type LineageMenuItemId = "branchOff" | "update" | "offer" | "moveToOwnMachine";

interface LineageMenuItem {
  readonly id: LineageMenuItemId;
  readonly title: string;
  readonly subtitle: string | null;
}

/**
 * The thread menu's lineage entries. Side chat, Fork and Continue locally aren't phone actions, and
 * Follow, Share and Assign stay in the Team menu with their owner-only states.
 */
export function lineageMenuItems(
  shell: LineageShell,
  viewer: LineageViewer,
): ReadonlyArray<LineageMenuItem> {
  const items: LineageMenuItem[] = [];
  const cloud = menuItemsForCloudThread(shell, viewer) ?? [];
  const branchOff = cloud.find((item) => item.id === "branchOff");
  if (branchOff !== undefined) {
    items.push({ id: "branchOff", title: branchOff.label, subtitle: branchOff.detail });
  }
  for (const action of lineageComposerActions(shell, viewer)) {
    items.push({
      id: action.kind === "update" ? "update" : "offer",
      title: action.label,
      subtitle: null,
    });
  }
  if (cloud.some((item) => item.id === "moveToOwnMachine")) {
    items.push({ id: "moveToOwnMachine", title: "Move to my own machine", subtitle: null });
  }
  return items;
}

/** Why the owner can't share this thread yet: it runs on someone else's machine. */
export function lineageShareRestriction(shell: LineageShell, viewer: LineageViewer): string | null {
  const share = menuItemsForCloudThread(shell, viewer)?.find((item) => item.id === "share");
  return share?.disabledReason ?? null;
}

/** Update and Offer on the viewer's own branch, each only when it has work to do. */
function lineageComposerActions(
  shell: LineageShell,
  viewer: LineageViewer,
): ReadonlyArray<LineageAction & { readonly kind: "update" | "offer" }> {
  const chip = lineageChipCopy(shell, [], viewer);
  if (chip === null || chip.role !== "branch") return [];
  return chip.actions.filter(
    (action): action is LineageAction & { readonly kind: "update" | "offer" } =>
      action.kind === "update" || action.kind === "offer",
  );
}

interface LineageComposerModel {
  /** On someone else's cloud thread: where a message goes, with Branch off. */
  readonly hint: ComposerBranchOffHint | null;
  /** Pinned while an Update's conflict is open. */
  readonly resolving: (ResolvingRowCopy & { readonly canAbort: boolean }) | null;
  /** The Update and Offer buttons above the composer. */
  readonly actions: ReadonlyArray<LineageAction & { readonly kind: "update" | "offer" }>;
}

export function lineageComposerModel(
  shell: LineageShell,
  viewer: LineageViewer,
): LineageComposerModel {
  const source = shell.branchLink?.source ?? null;
  const update = source?.updateInProgress ?? null;
  const holderId = lineageHolderOf(shell, viewer);
  return {
    hint: composerBranchOffHint(shell, viewer),
    resolving:
      update === null
        ? null
        : {
            ...resolvingRowCopy(update, source?.title ?? null),
            canAbort: holderId !== null && holderId === viewer.memberId,
          },
    actions: lineageComposerActions(shell, viewer),
  };
}

/** Where the branch starts: the source's latest checkpoint, one of its turns, or a branch. */
export type BranchOffStartFrom =
  | { readonly type: "latest" }
  | { readonly type: "turn"; readonly runId: RunId }
  | { readonly type: "branch" };

interface BranchOffStartFromOption {
  readonly id: string;
  readonly value: BranchOffStartFrom;
  readonly title: string;
}

export function branchOffStartFromOptions(
  draft: ThreadBranchOffDraft,
  latestDetail: string,
): ReadonlyArray<BranchOffStartFromOption> {
  return [
    { id: "latest", value: { type: "latest" }, title: `Latest · ${latestDetail}` },
    ...[...draft.turns]
      .sort((left, right) => right.turn - left.turn)
      .map((turn) => ({
        id: `turn:${turn.runId}`,
        value: { type: "turn" as const, runId: turn.runId },
        title: `Turn ${turn.turn} · ${turn.title}`,
      })),
    { id: "branch", value: { type: "branch" }, title: "A branch…" },
  ];
}

export function branchOffStartFromLabel(
  startFrom: BranchOffStartFrom,
  options: ReadonlyArray<BranchOffStartFromOption>,
  baseBranch: string,
): string {
  if (startFrom.type === "branch") {
    return baseBranch.trim() === "" ? "A branch" : `Branch ${baseBranch.trim()}`;
  }
  const id = startFrom.type === "latest" ? "latest" : `turn:${startFrom.runId}`;
  return options.find((option) => option.id === id)?.title ?? "Latest";
}

export interface BranchOffForm {
  readonly startFrom: BranchOffStartFrom;
  /** The branch to start from when `startFrom` is a branch, e.g. `main`. */
  readonly baseBranch: string;
  readonly runsOn: LineageRunsOn;
  readonly branch: string;
  readonly prompt: string;
  /** The context summary as the user left it; null when not asked for or removed. */
  readonly summary: string | null;
}

/** The RPC input, or null while the draft can't be sent yet. */
export function branchOffInput(
  draft: ThreadBranchOffDraft,
  sourceThreadId: ThreadBranchOffInput["sourceThreadId"],
  form: BranchOffForm,
  runsOnChoices: ReadonlyArray<LineageRunsOn>,
): ThreadBranchOffInput | null {
  const branch = form.branch.trim();
  const prompt = form.prompt.trim();
  const summary = form.summary?.trim() ?? "";
  const baseBranch = form.baseBranch.trim();
  if (!draft.allowed || branch === "" || !runsOnChoices.includes(form.runsOn)) return null;
  if (prompt === "" && summary === "") return null;
  if (form.startFrom.type === "branch" && baseBranch === "") return null;
  return {
    sourceThreadId,
    runsOn: form.runsOn,
    startFrom:
      form.startFrom.type === "branch"
        ? { type: "branch", branch: baseBranch }
        : form.startFrom.type === "turn"
          ? { type: "turn", runId: form.startFrom.runId }
          : { type: "latest" },
    branch,
    prompt,
    ...(summary === "" ? {} : { contextSummary: summary }),
  };
}
