import type {
  BranchLineage,
  EnvironmentId,
  LineageNotice,
  LineageRunsOn,
  LineageView,
  LineageWorkState,
  MemberId,
  Offer,
  OfferId,
  OfferPreview,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadShellBranchLink,
  ThreadBranchOffDraft,
  ThreadId,
  ThreadUpdatePreview,
} from "@t3tools/contracts";

import type { SpaceViewer } from "./spaces.ts";

// Branch off (docs/product/spaces-redesign.md Part 2): the viewer-relative words web and mobile
// show. Members are "You" or their name, never a gendered pronoun.

export interface LineageViewer extends SpaceViewer {
  /** Holds threads with no recorded owner. */
  readonly serverOwnerId?: MemberId | null;
}

/** The shell fields lineage copy reads; pass `EnvironmentThreadShell.source`. */
export type LineageShell = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "title"
  | "branch"
  | "ownerId"
  | "sandboxId"
  | "sandbox"
  | "branchLink"
  | "activeRunId"
  | "pendingRuntimeRequest"
  | "archivedAt"
  | "settledAt"
  | "followedAt"
>;

type BranchLinkSource = NonNullable<OrchestrationV2ThreadShellBranchLink["source"]>;
type LineageUpdateInProgress = NonNullable<BranchLinkSource["updateInProgress"]>;

const UNAVAILABLE_TITLE = "a thread you can't open";
const DELETED_TITLE = "a deleted thread";

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** "A", "A and B", "A, B and C". */
export function joinNames(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const isViewer = (viewer: LineageViewer, memberId: MemberId | null | undefined) =>
  memberId != null && viewer.memberId !== null && memberId === viewer.memberId;

/** Sentence subject: "You" or the name. */
const who = (viewer: LineageViewer, memberId: MemberId) =>
  isViewer(viewer, memberId) ? "You" : viewer.nameOf(memberId);

/** Mid-sentence possessive: "your" or "Kousik's". */
const whose = (viewer: LineageViewer, memberId: MemberId) =>
  isViewer(viewer, memberId) ? "your" : `${viewer.nameOf(memberId)}'s`;

/** "You offer", "Hanad offers". */
const offersFrom = (sender: string) => `${sender} ${sender === "You" ? "offer" : "offers"}`;

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The member who holds the thread; a thread with no recorded owner is the server owner's. */
export function lineageHolderOf(
  shell: Pick<LineageShell, "ownerId">,
  viewer: LineageViewer,
): MemberId | null {
  return shell.ownerId ?? viewer.serverOwnerId ?? null;
}

const turnRunning = (shell: Pick<LineageShell, "activeRunId">) => shell.activeRunId !== null;

/** Branch off is offered on an unarchived cloud thread that is not itself a branch (one level). */
export function canBranchOff(
  shell: Pick<LineageShell, "sandboxId" | "branchLink" | "archivedAt">,
  viewer: LineageViewer,
): boolean {
  return (
    viewer.memberId !== null &&
    shell.sandboxId !== undefined &&
    shell.archivedAt === null &&
    (shell.branchLink?.source ?? null) === null
  );
}

/** A source's branches among the shells the viewer has, so the count matches what they can open. */
export function lineageBranchesOf<T extends Pick<LineageShell, "branchLink" | "archivedAt">>(
  shells: ReadonlyArray<T>,
  sourceThreadId: ThreadId,
): ReadonlyArray<T> {
  return shells.filter(
    (shell) => shell.archivedAt === null && shell.branchLink?.source?.threadId === sourceThreadId,
  );
}

function lineageWorkStateOf(
  shell: Pick<LineageShell, "pendingRuntimeRequest" | "activeRunId" | "settledAt">,
): LineageWorkState {
  if (shell.pendingRuntimeRequest !== null) return "waiting";
  if (shell.activeRunId !== null) return "working";
  return shell.settledAt !== null ? "settled" : "idle";
}

/** "Offer to Kousik"; a source of your own, or one with no owner, is named by its title. */
function offerActionLabel(
  source: { readonly ownerId: MemberId | null; readonly title: string | null },
  viewer: LineageViewer,
): string {
  if (source.ownerId !== null && !isViewer(viewer, source.ownerId)) {
    return `Offer to ${viewer.nameOf(source.ownerId)}`;
  }
  return source.title === null ? "Offer" : `Offer to ${source.title}`;
}

const updateActionLabel = (sourceTitle: string, running: boolean) =>
  running ? "Update after this turn" : `Update from ${sourceTitle}`;

export type LineageActionKind = "update" | "offer" | "branchOff" | "startFromMain" | "settle";

export interface LineageAction {
  readonly kind: LineageActionKind;
  readonly label: string;
}

export interface LineageChipCopy {
  readonly role: "source" | "branch";
  /** Without the ⑂ glyph, which clients draw as an icon. */
  readonly text: string;
  /** An offer waits on the viewer: the glyph turns indigo. */
  readonly accent: boolean;
  /** Each only when it has work to do; the popover shows the same buttons. */
  readonly actions: ReadonlyArray<LineageAction>;
}

const BRANCH_OFF_ACTION: LineageAction = { kind: "branchOff", label: "Branch off…" };
const SETTLE_ACTION: LineageAction = { kind: "settle", label: "Settle" };
const START_FROM_MAIN_ACTION: LineageAction = {
  kind: "startFromMain",
  label: "Start from main with them",
};

/**
 * Null when the thread has no lineage the viewer can see. `branches` are the source's branches
 * among the viewer's shells (`lineageBranchesOf`); ignored on a branch.
 */
export function lineageChipCopy(
  shell: LineageShell,
  branches: ReadonlyArray<unknown>,
  viewer: LineageViewer,
): LineageChipCopy | null {
  const link = shell.branchLink;
  const source = link?.source ?? null;
  const ownsThread = isViewer(viewer, lineageHolderOf(shell, viewer));
  if (source === null) {
    const offers = link?.openOffers ?? 0;
    if (branches.length === 0 && offers === 0) return null;
    const parts: string[] = [];
    if (branches.length > 0) parts.push(plural(branches.length, "branch", "branches"));
    if (offers > 0) parts.push(plural(offers, "offer"));
    return {
      role: "source",
      text: parts.join(" · "),
      accent: offers > 0 && ownsThread,
      actions: canBranchOff(shell, viewer) ? [BRANCH_OFF_ACTION] : [],
    };
  }
  const branch = (text: string, actions: ReadonlyArray<LineageAction> = []): LineageChipCopy => ({
    role: "branch",
    text,
    accent: false,
    actions: ownsThread ? actions : [],
  });
  const title = source.title;
  const state = title === null ? "unavailable" : (source.state ?? "open");
  if (title === null || state === "unavailable") return branch(`from ${UNAVAILABLE_TITLE}`);
  if (state === "deleted") return branch(`from ${DELETED_TITLE}`);
  const settled = shell.settledAt !== null;
  if (state === "shipped" || state === "settled") {
    const lead =
      state === "settled"
        ? `${title} is settled`
        : source.shippedLabel === null
          ? `${title} shipped`
          : `${title} shipped in ${source.shippedLabel}`;
    const parts = [lead];
    if (source.unshipped > 0) parts.push(`${plural(source.unshipped, "commit")} not in it`);
    return branch(parts.join(" · "), [
      ...(source.unshipped > 0 ? [START_FROM_MAIN_ACTION] : []),
      ...(settled ? [] : [SETTLE_ACTION]),
    ]);
  }
  const updating = source.updateInProgress !== null;
  const allApplied = source.allApplied && source.toOffer === 0;
  const parts = [`from ${title}`];
  if (state === "archived") parts.push("archived");
  if (updating) parts.push("updating");
  else {
    if (allApplied) parts.push("all applied");
    else if (source.toOffer > 0) parts.push(`${source.toOffer} to offer`);
    if (source.behind > 0) parts.push(`${source.behind} behind`);
  }
  const actions: LineageAction[] = [];
  if (!updating && source.behind > 0) {
    actions.push({ kind: "update", label: updateActionLabel(title, turnRunning(shell)) });
  }
  if (!updating && source.toOffer > 0) {
    actions.push({ kind: "offer", label: offerActionLabel(source, viewer) });
  }
  if (!updating && allApplied && !settled) actions.push(SETTLE_ACTION);
  return branch(parts.join(" · "), actions);
}

export interface LineagePopoverRow {
  readonly threadId: ThreadId;
  readonly role: "source" | "branch";
  readonly title: string;
  readonly canOpen: boolean;
  /** Marked "this thread". */
  readonly isThisThread: boolean;
  readonly ownerId: MemberId | null;
  /** "You" or the name; null when unknown. */
  readonly owner: string | null;
  readonly branch: string | null;
  readonly workState: LineageWorkState | null;
  /** "Kousik's machine", "Your machine" or "Its own machine". */
  readonly where: string | null;
  /** "2 commits to offer · 1 turn behind"; null when even. */
  readonly counts: string | null;
  /** "Kousik · kousik/prompt-builder · working". */
  readonly meta: string;
}

export interface LineagePopoverCopy {
  readonly heading: string;
  readonly rows: ReadonlyArray<LineagePopoverRow>;
}

const machineOf = (viewer: LineageViewer, ownerId: MemberId | null) =>
  ownerId === null ? null : capitalize(`${whose(viewer, ownerId)} machine`);

/** Source first, then its branches, from `lineage.read`; `shells` fill in what the view lacks. */
export function lineagePopoverRows(
  view: LineageView,
  shells: ReadonlyArray<LineageShell>,
  viewer: LineageViewer,
): LineagePopoverCopy {
  const shellOf = (threadId: ThreadId) => shells.find((shell) => shell.id === threadId) ?? null;
  const thisThreadId = view.thread.threadId;
  const sourceShell = view.source === null ? shellOf(thisThreadId) : shellOf(view.source.threadId);
  const source =
    view.source ??
    (view.thread.role === "source" && sourceShell !== null
      ? {
          threadId: sourceShell.id,
          title: sourceShell.title,
          ownerId: lineageHolderOf(sourceShell, viewer),
          state: "open" as const,
          canOpen: true,
        }
      : null);
  const sourceOwnerId = source?.ownerId ?? null;
  const row = (fields: Omit<LineagePopoverRow, "owner" | "meta">): LineagePopoverRow => {
    const owner = fields.ownerId === null ? null : who(viewer, fields.ownerId);
    return {
      ...fields,
      owner,
      meta: [owner, fields.branch, fields.workState].filter((part) => part !== null).join(" · "),
    };
  };
  const rows: LineagePopoverRow[] = [];
  if (source !== null) {
    const available = source.canOpen && source.title !== null;
    rows.push(
      row({
        threadId: source.threadId,
        role: "source",
        title: available
          ? (source.title ?? UNAVAILABLE_TITLE)
          : source.state === "deleted"
            ? DELETED_TITLE
            : UNAVAILABLE_TITLE,
        canOpen: available,
        isThisThread: source.threadId === thisThreadId,
        ownerId: available ? source.ownerId : null,
        branch: available ? (sourceShell?.branch ?? null) : null,
        workState: available && sourceShell !== null ? lineageWorkStateOf(sourceShell) : null,
        where: available ? machineOf(viewer, source.ownerId) : null,
        counts: null,
      }),
    );
  }
  for (const branch of view.branches) {
    const counts = [
      branch.toOffer > 0 ? `${plural(branch.toOffer, "commit")} to offer` : null,
      branch.behind > 0 ? `${plural(branch.behind, "turn")} behind` : null,
    ].filter((part) => part !== null);
    rows.push(
      row({
        threadId: branch.threadId,
        role: "branch",
        title: branch.title,
        canOpen: true,
        isThisThread: branch.threadId === thisThreadId,
        ownerId: branch.ownerId,
        branch: branch.branch,
        workState: branch.workState,
        where:
          branch.runsOn === "new-machine" ? "Its own machine" : machineOf(viewer, sourceOwnerId),
        counts: counts.length === 0 ? null : counts.join(" · "),
      }),
    );
  }
  const heading =
    source !== null && source.canOpen && source.title !== null
      ? `${source.title} and its branches`
      : "Branches";
  return { heading, rows };
}

/** Client-local, per environment: the apps persist the last Runs on choice under this key. */
export function rememberedRunsOnKey(environmentId: EnvironmentId): string {
  return `t3code:branch-off:runs-on:${environmentId}`;
}

export function parseRememberedRunsOn(value: unknown): LineageRunsOn | null {
  return value === "source-machine" || value === "new-machine" ? value : null;
}

/** Three or more threads working: the draft preselects New machine. */
const BUSY_MACHINE_WORKING = 3;

export interface RunsOnOption {
  readonly value: LineageRunsOn;
  readonly label: string;
  /** The card's second line, e.g. "Seconds · 1 thread working". */
  readonly subtitle: string;
}

export interface RunsOnChoice {
  /** Only New machine when the source's machine failed, was discarded, or doesn't exist. */
  readonly options: ReadonlyArray<RunsOnOption>;
  readonly selected: LineageRunsOn;
  /** Shown above the disclosure, never in place of it. */
  readonly reason: string | null;
  /** Shown in full under whichever option is selected. */
  readonly disclosures: Readonly<Record<LineageRunsOn, string>>;
}

export function runsOnOptions(
  draft: ThreadBranchOffDraft,
  viewer: LineageViewer,
  options: {
    readonly remembered: LineageRunsOn | null;
    /** The draft's provider, e.g. "Claude". */
    readonly providerName: string;
  },
): RunsOnChoice {
  const machine = draft.machine;
  const ownerId = machine.ownerId ?? draft.sourceOwnerId;
  const ownMachine = ownerId === null || isViewer(viewer, ownerId);
  const ownerName = ownerId === null ? null : viewer.nameOf(ownerId);
  const machineLabel = ownMachine ? "Your machine" : `${ownerName}'s machine`;
  const others = draft.audience
    .filter((id) => !isViewer(viewer, id))
    .map((id) => viewer.nameOf(id));
  const signIns = `your ${options.providerName} and GitHub sign-ins`;
  const reach = (what: string, tail: string) =>
    others.length === 0
      ? ""
      : ` ${joinNames(others)} can open ${what} and reach ${signIns}${tail}.`;
  const sourceDisclosure = ownMachine
    ? `Shares your running database and services.${reach("this machine", " from its terminal")}`
    : `Shares ${ownerName}'s running database and services.${reach("this machine", " from its terminal")} Machine time counts toward ${ownerName}.`;
  const newDisclosure = `Its own database and services, on your machine time.${reach("it", ", as with any thread you share")}`;
  const newOption: RunsOnOption = {
    value: "new-machine",
    label: "New machine",
    subtitle: "About a minute · own database and services",
  };
  const disclosures = { "source-machine": sourceDisclosure, "new-machine": newDisclosure };
  const state = machine.state ?? "ready";
  if (state === "failed" || state === "gone" || state === "none") {
    return {
      options: [newOption],
      selected: "new-machine",
      reason:
        state === "none"
          ? null
          : `${machineLabel} ${state === "failed" ? "failed" : "was discarded"}, so it runs on a new machine.`,
      disclosures,
    };
  }
  const busy = draft.busy || machine.working >= BUSY_MACHINE_WORKING;
  const sourceOption: RunsOnOption = {
    value: "source-machine",
    label: machineLabel,
    subtitle:
      state === "asleep"
        ? "asleep, wakes when you start"
        : machine.working === 0
          ? "Seconds"
          : `Seconds · ${plural(machine.working, "thread")} working`,
  };
  const cpus = machine.vcpus === undefined ? "" : ` on ${machine.vcpus} vCPU`;
  return {
    options: [sourceOption, newOption],
    selected: busy ? "new-machine" : (options.remembered ?? "source-machine"),
    reason: busy
      ? `${machineLabel} has ${plural(machine.working, "thread")} working${cpus}, so New machine is selected. You can still pick it.`
      : null,
    disclosures,
  };
}

export interface BranchOffDraftCopy {
  readonly title: string;
  readonly subtitle: string;
  readonly latestLabel: string;
  /** "turn 6 · with 2 uncommitted files"; clients add how long ago. */
  readonly latestDetail: string;
  readonly contextLabel: string;
  readonly contextHint: string;
  /** "Joins the task: …", or null without a task. */
  readonly taskLine: string | null;
  /** Why Branch off is disabled; `connect` names the account to connect first. */
  readonly blocked: { readonly text: string; readonly connect: string | null } | null;
}

export function branchOffDraftCopy(
  draft: ThreadBranchOffDraft,
  viewer: LineageViewer,
  providerName: string,
): BranchOffDraftCopy {
  const ownerId = draft.sourceOwnerId;
  const builder =
    ownerId === null || isViewer(viewer, ownerId)
      ? "your agent"
      : `${viewer.nameOf(ownerId)}'s agent`;
  const latest = draft.latestTurn;
  return {
    title: `Branch off ${draft.sourceTitle}`,
    subtitle: `Your own thread, branch and worktree, starting from what ${builder} has built so far. ${draft.sourceTitle}'s conversation and files stay as they are.`,
    latestLabel: `${draft.sourceTitle}, latest`,
    latestDetail:
      latest.uncommittedFiles === 0
        ? `turn ${latest.turn}`
        : `turn ${latest.turn} · with ${plural(latest.uncommittedFiles, "uncommitted file")}`,
    contextLabel: `Start with a summary of ${draft.sourceTitle}'s conversation`,
    contextHint: "Written on your account. It shows as your first message, and you can edit it.",
    taskLine: draft.taskTitle === undefined ? null : `Joins the task: ${draft.taskTitle}`,
    blocked: draft.allowed ? null : branchOffBlocked(draft.reason, providerName),
  };
}

function branchOffBlocked(
  reason: ThreadBranchOffDraft["reason"],
  providerName: string,
): NonNullable<BranchOffDraftCopy["blocked"]> {
  switch (reason) {
    case "no-account":
      return {
        text: `Connect ${providerName} to branch off on your own account.`,
        connect: `Connect ${providerName}`,
      };
    case "branch-of-branch":
      return { text: "A branch can't be branched off. Branch off its source.", connect: null };
    case "not-cloud":
      return { text: "Branch off is for cloud threads.", connect: null };
    case "source-unavailable":
    case "not-allowed":
      return { text: "You can't open this thread anymore.", connect: null };
    default:
      return { text: "This thread can't be branched off right now.", connect: null };
  }
}

export interface ComposerBranchOffHint {
  readonly text: string;
  readonly running: boolean;
  readonly prompt: string;
  readonly cta: string;
}

export function composerBranchOffHint(
  shell: LineageShell,
  viewer: LineageViewer,
): ComposerBranchOffHint | null {
  const holderId = lineageHolderOf(shell, viewer);
  if (holderId === null || isViewer(viewer, holderId) || !canBranchOff(shell, viewer)) return null;
  const running = turnRunning(shell);
  return {
    text: `Goes into ${viewer.nameOf(holderId)}'s conversation${running ? ", after the current turn" : ""}`,
    running,
    prompt: "Want to work on your own?",
    cta: "Branch off",
  };
}

export type LineageNoticeActionKind =
  | "undoUpdate"
  | "abortUpdate"
  | "withdraw"
  | "offerAgain"
  | "updateAndOfferAgain"
  | "revertOffer"
  | "bringBack";

export interface LineageNoticeAction {
  readonly kind: LineageNoticeActionKind;
  readonly label: string;
  /** Quiet text after the link, e.g. "until your next turn". */
  readonly hint: string | null;
  readonly offerId: OfferId | null;
}

export interface LineageNoticeCopy {
  readonly text: string;
  /** A second quiet part, e.g. "on Kousik's machine" or "waiting for Kousik". */
  readonly detail: string | null;
  readonly tone: "muted" | "success" | "warning" | "error";
  /** The other thread the row names, for a link. */
  readonly threadId: ThreadId | null;
  /** Set on an offer in its source: the row is the offer card (`offerCardCopy`). */
  readonly cardOfferId: OfferId | null;
  /** Shown only while it still applies. */
  readonly action: LineageNoticeAction | null;
}

export interface LineageNoticeContext {
  readonly viewer: LineageViewer;
  /** The thread the row is on. */
  readonly thread: LineageShell;
  /** Its `lineage.read` answer; null while loading, when rows show no actions. */
  readonly view: LineageView | null;
}

const action = (
  kind: LineageNoticeActionKind,
  label: string,
  offerId: OfferId | null = null,
  hint: string | null = null,
): LineageNoticeAction => ({ kind, label, hint, offerId });

/** "src/schema.ts", "a.ts and b.ts". */
const joinPaths = (paths: ReadonlyArray<string>) => joinNames(paths);

export function lineageNoticeCopy(
  notice: LineageNotice,
  context: LineageNoticeContext,
): LineageNoticeCopy {
  const { viewer, thread, view } = context;
  const link = thread.branchLink?.source ?? null;
  const holderId = lineageHolderOf(thread, viewer);
  const viewerHolds = isViewer(viewer, holderId);
  const offerOf = (offerId: OfferId) => view?.offers.find((offer) => offer.id === offerId) ?? null;
  const sourceTitle = view?.source != null ? view.source.title : (link?.title ?? null);
  const sourceState = view?.source?.state ?? link?.state ?? null;
  const source = sourceTitle ?? (sourceState === "deleted" ? DELETED_TITLE : UNAVAILABLE_TITLE);
  const sourceOwnerId = view?.source?.ownerId ?? link?.ownerId ?? null;
  const branchTitleOf = (threadId: ThreadId) =>
    view?.branches.find((branch) => branch.threadId === threadId)?.title ?? UNAVAILABLE_TITLE;
  const lineage = view?.lineage ?? null;
  const commitsOf = (offer: Offer | null) =>
    offer === null ? "changes" : plural(offer.commits.length, "commit");
  const senderOf = (senderId: MemberId, offer: Offer | null) =>
    offer?.senderKind === "agent"
      ? `${capitalize(whose(viewer, senderId))} agent`
      : who(viewer, senderId);
  const newestOffer = (branchThreadId: ThreadId) =>
    view?.offers
      .filter((offer) => offer.branchThreadId === branchThreadId)
      .reduce<Offer | null>(
        (newest, offer) =>
          newest === null || Date.parse(offer.createdAt) > Date.parse(newest.createdAt)
            ? offer
            : newest,
        null,
      ) ?? null;
  const isLatestOffer = (offer: Offer) => newestOffer(offer.branchThreadId)?.id === offer.id;
  const sourceReachable = sourceTitle !== null && sourceState !== "deleted";
  const copy = (
    text: string,
    fields: Partial<Omit<LineageNoticeCopy, "text">> = {},
  ): LineageNoticeCopy => ({
    text,
    detail: null,
    tone: "muted",
    threadId: null,
    cardOfferId: null,
    action: null,
    ...fields,
  });
  // Apply, Decline and Revert read differently in the source and the branch.
  const inBranch = (offer: Offer | null) =>
    offer !== null ? offer.branchThreadId === thread.id : link !== null;

  switch (notice.kind) {
    case "branched-off":
      return copy(
        `${who(viewer, notice.actorId)} branched off this thread → ${branchTitleOf(notice.branchThreadId)}`,
        {
          threadId: notice.branchThreadId,
        },
      );
    case "branched-from": {
      const owner =
        sourceTitle === null || notice.sourceOwnerId === null
          ? ""
          : `${whose(viewer, notice.sourceOwnerId)} `;
      const files =
        notice.uncommittedFiles === 0
          ? ""
          : `, with its ${plural(notice.uncommittedFiles, "uncommitted file")}`;
      return copy(
        `${who(viewer, notice.actorId)} branched off ${owner}${source} at turn ${notice.turn}${files}`,
        {
          threadId: notice.sourceThreadId,
          detail:
            notice.runsOn === "new-machine"
              ? "on a new machine"
              : notice.sourceOwnerId === null
                ? "on its machine"
                : `on ${whose(viewer, notice.sourceOwnerId)} machine`,
        },
      );
    }
    case "updated":
      return copy(`Updated from ${source} · turn ${notice.turn}, ${plural(notice.files, "file")}`, {
        action:
          viewerHolds &&
          lineage !== null &&
          lineage.update === null &&
          lineage.undoableUpdate?.snapshotSha === notice.snapshotSha
            ? action("undoUpdate", "Undo update", null, "until your next turn")
            : null,
      });
    case "update-conflict":
      return copy(
        `Updating from ${source} · ${joinPaths(notice.paths)} ${notice.paths.length === 1 ? "has" : "have"} conflict markers`,
        {
          tone: "warning",
          action:
            viewerHolds && lineage?.update != null ? action("abortUpdate", "Abort update") : null,
        },
      );
    case "update-aborted":
      return copy(`Update from ${source} aborted`);
    case "update-undone":
      return copy(`Update from ${source} undone`);
    case "agent-told": {
      const agent =
        holderId === null ? "The agent" : `${capitalize(whose(viewer, holderId))} agent`;
      return copy(`${agent} was told: ${notice.text}`);
    }
    case "offer": {
      const offer = offerOf(notice.offerId);
      return copy(
        `${offersFrom(senderOf(notice.senderId, offer))} ${commitsOf(offer)} from ${offer === null ? UNAVAILABLE_TITLE : branchTitleOf(offer.branchThreadId)}`,
        { cardOfferId: notice.offerId, threadId: offer?.branchThreadId ?? null },
      );
    }
    case "offer-sent": {
      const offer = offerOf(notice.offerId);
      const sender = senderOf(notice.senderId, offer);
      const text =
        offer?.replaced === true
          ? `${sender} updated ${isViewer(viewer, notice.senderId) ? "your" : "the"} offer · it replaces the open one`
          : `${sender} offered ${commitsOf(offer)} to ${source}`;
      const open = offer?.state === "open";
      return copy(text, {
        threadId: link?.threadId ?? null,
        detail: !open
          ? null
          : offer.waiting === "source-archived"
            ? `Waiting · ${source} is archived`
            : sourceOwnerId === null || isViewer(viewer, sourceOwnerId)
              ? null
              : `waiting for ${viewer.nameOf(sourceOwnerId)}`,
        action:
          open && isViewer(viewer, offer.senderId)
            ? action("withdraw", "Withdraw", offer.id)
            : null,
      });
    }
    case "applied": {
      const offer = offerOf(notice.offerId);
      if (inBranch(offer)) {
        return copy(
          `${who(viewer, notice.actorId)} applied ${whose(viewer, notice.senderId)} changes`,
          { tone: "success" },
        );
      }
      const revertible =
        viewerHolds && offer !== null && offer.state === "applied" && offer.revertedAt === null;
      return copy(
        `${who(viewer, notice.actorId)} applied ${whose(viewer, notice.senderId)} changes from ${offer === null ? UNAVAILABLE_TITLE : branchTitleOf(offer.branchThreadId)} · ${plural(notice.files, "file")}`,
        {
          threadId: offer?.branchThreadId ?? null,
          action: revertible
            ? action("revertOffer", `Revert ${whose(viewer, notice.senderId)} changes`, offer.id)
            : null,
        },
      );
    }
    case "declined": {
      const offer = offerOf(notice.offerId);
      if (!inBranch(offer)) {
        return copy(
          `${who(viewer, notice.actorId)} declined ${whose(viewer, notice.senderId)} ${offer === null ? "offer" : commitsOf(offer)}`,
        );
      }
      const again =
        viewerHolds &&
        offer !== null &&
        offer.state === "declined" &&
        isLatestOffer(offer) &&
        sourceReachable &&
        (link?.toOffer ?? 0) > 0;
      return copy(`${who(viewer, notice.actorId)} declined`, {
        action: again ? action("offerAgain", "Offer again", offer.id) : null,
      });
    }
    case "withdrawn":
      return copy(
        `${who(viewer, notice.senderId)} withdrew ${isViewer(viewer, notice.senderId) ? "your" : "the"} offer`,
      );
    case "returned": {
      const offer = offerOf(notice.offerId);
      const sender = offer?.senderId ?? holderId;
      const theirOffer =
        sender === null ? "The offer" : `${capitalize(whose(viewer, sender))} offer`;
      if (!inBranch(offer)) {
        return copy(`${theirOffer} came back · it no longer applies cleanly`, { tone: "error" });
      }
      const gone = offer?.returnReason === "source-gone";
      const changed = notice.paths.length === 0 ? "changed" : `changed ${joinPaths(notice.paths)}`;
      const again =
        viewerHolds &&
        !gone &&
        sourceReachable &&
        offer !== null &&
        offer.state === "returned" &&
        isLatestOffer(offer);
      return copy(
        gone
          ? `${source} is no longer available. ${theirOffer} came back`
          : `${source} ${changed} after the offer was sent. ${theirOffer} came back`,
        {
          tone: "error",
          action: again ? action("updateAndOfferAgain", "Update and offer again", offer.id) : null,
        },
      );
    }
    case "reverted": {
      const offer = offerOf(notice.offerId);
      return inBranch(offer)
        ? copy(
            `${who(viewer, notice.actorId)} reverted ${whose(viewer, notice.senderId)} applied changes`,
          )
        : copy(
            `${who(viewer, notice.actorId)} reverted ${whose(viewer, notice.senderId)} changes · ${plural(notice.files, "file")}`,
          );
    }
    case "credited-commit":
      return copy(
        `Committed "${notice.subject}" · Co-authored-by: ${viewer.nameOf(notice.coAuthor)}`,
        { tone: "success" },
      );
    case "reverted-kept":
    case "reverted-removed": {
      const offer = offerOf(notice.offerId);
      const actorId = offer?.revertedBy ?? sourceOwnerId;
      const senderId = offer?.senderId ?? holderId;
      const changes =
        senderId === null ? "the applied changes" : `${whose(viewer, senderId)} applied changes`;
      const lead =
        actorId === null
          ? `${capitalize(changes)} were reverted in ${source}`
          : `${who(viewer, actorId)} reverted ${changes}`;
      if (notice.kind === "reverted-kept") {
        return copy(
          senderId !== null && isViewer(viewer, senderId)
            ? `${lead}. You still have them here, and can offer them again.`
            : `${lead}. They're still here, and can be offered again.`,
        );
      }
      const reverted = lineage?.reverted ?? null;
      return copy(`${lead}, and this Update removed them here too`, {
        action:
          viewerHolds &&
          reverted !== null &&
          reverted.offerId === notice.offerId &&
          !reverted.keptHere
            ? action("bringBack", "Bring them back", notice.offerId)
            : null,
      });
    }
    case "brought-back":
      return copy(`Brought back ${plural(notice.commits.length, "commit")}, ready to offer`);
    case "moved-machine":
      return copy(
        `${who(viewer, notice.actorId)} moved this thread to ${holderId === null ? "its" : whose(viewer, holderId)} own machine`,
      );
  }
}

export type OfferCardButtonKind = "apply" | "viewChanges" | "decline" | "withdraw";

export interface OfferCardButton {
  readonly kind: OfferCardButtonKind;
  readonly label: string;
  readonly primary: boolean;
}

interface OfferCardHead {
  /** "Hanad", "Hanad's agent", "You"; clients set it in bold. */
  readonly sender: string;
  /** The full header: "Hanad offers 2 commits from Rationale per question". */
  readonly header: string;
  /** This offer replaced an open one. */
  readonly updated: boolean;
}

export type OfferCardCopy =
  | (OfferCardHead & {
      readonly state: "open";
      readonly note: string | null;
      /** "3 files"; clients add the colored +/− counts. */
      readonly summary: string;
      readonly check: { readonly text: string; readonly tone: "success" | "muted" };
      /** For the holder only. */
      readonly explainer: string | null;
      /** For everyone but the holder: "Waiting for Kousik". */
      readonly waitingFor: string | null;
      readonly buttons: ReadonlyArray<OfferCardButton>;
    })
  | (OfferCardHead & {
      readonly state: "closed";
      /** One quiet line. */
      readonly line: string;
    });

export function offerCardCopy(
  offer: Offer,
  context: {
    readonly viewer: LineageViewer;
    /** Who decides: the source thread's holder. */
    readonly sourceHolderId: MemberId | null;
    /** A turn is running on the source. */
    readonly sourceRunning: boolean;
    readonly branchTitle: string | null;
    readonly sourceTitle: string | null;
  },
): OfferCardCopy {
  const { viewer } = context;
  const sender =
    offer.senderKind === "agent"
      ? `${capitalize(whose(viewer, offer.senderId))} agent`
      : who(viewer, offer.senderId);
  const commits = plural(offer.commits.length, "commit");
  const head: OfferCardHead = {
    sender,
    header: `${offersFrom(sender)} ${commits} from ${context.branchTitle ?? UNAVAILABLE_TITLE}`,
    updated: offer.replaced,
  };
  const deciderId = offer.decidedBy ?? context.sourceHolderId;
  const senderChanges = `${whose(viewer, offer.senderId)} changes`;
  switch (offer.state) {
    case "applied":
      return {
        ...head,
        state: "closed",
        line: `${deciderId === null ? "Applied" : `${who(viewer, deciderId)} applied`} ${senderChanges} · ${plural(offer.files.length, "file")}${offer.revertedAt === null ? "" : " · reverted"}`,
      };
    case "declined":
      return {
        ...head,
        state: "closed",
        line:
          deciderId === null
            ? `Declined ${whose(viewer, offer.senderId)} ${commits}`
            : `${who(viewer, deciderId)} declined ${whose(viewer, offer.senderId)} ${commits}`,
      };
    case "withdrawn":
      return {
        ...head,
        state: "closed",
        line: `${who(viewer, offer.senderId)} withdrew ${isViewer(viewer, offer.senderId) ? "your" : "the"} offer`,
      };
    case "returned":
      return {
        ...head,
        state: "closed",
        line: `${capitalize(whose(viewer, offer.senderId))} offer came back · it no longer applies cleanly`,
      };
    case "open":
      break;
  }
  const holds = isViewer(viewer, context.sourceHolderId);
  const waitingArchived = offer.waiting === "source-archived";
  const check = waitingArchived
    ? {
        text: `Waiting · ${context.sourceTitle ?? "the thread"} is archived`,
        tone: "muted" as const,
      }
    : !holds
      ? { text: "Applies cleanly", tone: "success" as const }
      : offer.armedAt !== null
        ? { text: "Applies when this turn ends", tone: "muted" as const }
        : context.sourceRunning
          ? {
              text: "Applies cleanly now · checked again when this turn ends",
              tone: "success" as const,
            }
          : {
              text: "Applies cleanly · your agent is idle, so it applies now",
              tone: "success" as const,
            };
  const viewChanges: OfferCardButton = {
    kind: "viewChanges",
    label: "View changes",
    primary: false,
  };
  const buttons: OfferCardButton[] = [];
  if (holds) {
    if (!waitingArchived && offer.armedAt === null) {
      buttons.push({
        kind: "apply",
        label: context.sourceRunning ? "Apply when this turn ends" : "Apply",
        primary: true,
      });
    }
    buttons.push(viewChanges, { kind: "decline", label: "Decline", primary: false });
  } else {
    buttons.push(viewChanges);
    if (isViewer(viewer, offer.senderId)) {
      buttons.push({ kind: "withdraw", label: "Withdraw", primary: false });
    }
  }
  return {
    ...head,
    state: "open",
    note: offer.note,
    summary: plural(offer.files.length, "file"),
    check,
    explainer: holds
      ? `Writes ${senderChanges} into your files, uncommitted, next to your own work. Your next commit of them credits ${who(viewer, offer.senderId)}.`
      : null,
    waitingFor:
      holds || context.sourceHolderId === null
        ? null
        : `Waiting for ${viewer.nameOf(context.sourceHolderId)}`,
    buttons,
  };
}

export interface OfferDialogCopy {
  readonly title: string;
  readonly description: string;
  /** "2 commits · 3 files"; clients add the colored +/− counts. */
  readonly summary: string;
  /** Uncommitted files are committed first, as the sender. */
  readonly uncommitted: string | null;
  readonly check: { readonly clean: boolean; readonly text: string; readonly note: string };
  readonly footer: string;
  /** Offer when clean; otherwise Update from the source first. */
  readonly primary: { readonly kind: "offer" | "update"; readonly label: string };
}

export function offerDialogCopy(
  preview: OfferPreview,
  context: {
    readonly viewer: LineageViewer;
    /** The branch's record, to say "since your last Update" after one. */
    readonly lineage: BranchLineage | null;
    /** The source's latest turn, when known. */
    readonly sourceTurn: number | null;
  },
): OfferDialogCopy {
  const { viewer } = context;
  const source = preview.sourceTitle;
  const holder =
    preview.sourceOwnerId === null || isViewer(viewer, preview.sourceOwnerId)
      ? null
      : viewer.nameOf(preview.sourceOwnerId);
  const updated =
    (context.lineage?.snapshots.filter((snapshot) => snapshot.state === "on-branch").length ?? 0) >
    1;
  const uncommitted = preview.uncommittedFiles.length;
  const check = preview.check.clean
    ? {
        clean: true,
        text: `Applies cleanly on ${source}'s latest checkpoint${context.sourceTurn === null ? "" : ` (turn ${context.sourceTurn})`}, uncommitted work included`,
        note:
          holder === null
            ? "Only your lines are offered: the diff starts from your last update."
            : `${holder} sees only your lines: the diff starts from your last update of ${holder}'s work.`,
      }
    : {
        clean: false,
        text: `${source} changed ${joinPaths(preview.check.paths)} since ${updated ? "your last Update" : "you branched"}.`,
        note: `Update from ${source} first. You or your agent resolve it in your branch, and ${holder === null ? `${source}'s` : `${holder}'s`} files are never touched.`,
      };
  return {
    title: `Offer your changes to ${source}`,
    description:
      holder === null
        ? `They show in ${source}, where you choose Apply or Decline. Apply writes them into its files between turns.`
        : `${holder} sees them in ${source} and chooses Apply or Decline. Apply writes your changes into ${holder}'s files between turns, and ${holder}'s next commit of them credits you.`,
    summary: `${plural(preview.commits.length, "commit")} · ${plural(preview.files.length, "file")}`,
    uncommitted:
      uncommitted === 0
        ? null
        : `Your ${plural(uncommitted, "uncommitted file")} ${uncommitted === 1 ? "is" : "are"} committed first, as you.`,
    check,
    footer: check.clean
      ? `You can withdraw it until ${holder === null ? "it's applied" : `${holder} applies it`}.`
      : "Nothing is offered until it applies cleanly.",
    primary: check.clean
      ? {
          kind: "offer",
          label: offerActionLabel({ ownerId: preview.sourceOwnerId, title: source }, viewer),
        }
      : { kind: "update", label: `Update from ${source}` },
  };
}

export interface UpdateDialogCopy {
  readonly title: string;
  readonly summary: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly conflict: boolean;
    readonly label: string;
  }>;
  /** Only with conflicts; the first is the default. */
  readonly choices: ReadonlyArray<{
    readonly value: "agent" | "self";
    readonly label: string;
    readonly cost: string;
  }>;
  readonly footer: string | null;
  readonly primary: string;
}

export function updateDialogCopy(
  preview: ThreadUpdatePreview,
  context: {
    readonly viewer: LineageViewer;
    readonly sourceOwnerId: MemberId | null;
    /** The branch's provider, e.g. "Claude". */
    readonly providerName: string;
    /** A turn is running on the branch, so the Update waits for it. */
    readonly turnRunning: boolean;
  },
): UpdateDialogCopy {
  const { viewer } = context;
  const source = preview.sourceTitle;
  const conflicts = preview.conflicts.length;
  const owner =
    context.sourceOwnerId === null || isViewer(viewer, context.sourceOwnerId)
      ? `${source}'s`
      : `${viewer.nameOf(context.sourceOwnerId)}'s`;
  return {
    title: `Update from ${source}`,
    summary: `${plural(preview.files.length, "file")} changed on ${source} since your last Update.${conflicts === 0 ? "" : ` ${conflicts} ${conflicts === 1 ? "conflicts" : "conflict"} with yours.`}`,
    files: preview.files.map((file) => ({
      path: file.path,
      conflict: file.status === "conflict",
      label: file.status === "conflict" ? "conflicts with your edit" : "merges cleanly",
    })),
    choices:
      conflicts === 0
        ? []
        : [
            {
              value: "agent",
              label: "Update and let my agent resolve it",
              cost: `Starts one turn on your ${context.providerName} account to resolve ${joinPaths(preview.conflicts)}, then commits.`,
            },
            {
              value: "self",
              label: "Update and resolve it myself",
              cost: `Leaves conflict markers in your worktree. ${owner} files are never touched.`,
            },
          ],
    footer: conflicts === 0 ? null : "You can abort until it's resolved.",
    primary: context.turnRunning ? "Update after this turn" : "Update",
  };
}

export interface ResolvingRowCopy {
  readonly text: string;
  readonly paths: ReadonlyArray<string>;
  /** `text` and the paths on one line. */
  readonly line: string;
  readonly action: { readonly kind: "abortUpdate"; readonly label: string };
}

/** Pinned above the composer while an Update's conflict is open; the same on mobile. */
export function resolvingRowCopy(
  update: LineageUpdateInProgress,
  sourceTitle: string | null,
): ResolvingRowCopy {
  const text = sourceTitle === null ? "Resolving update" : `Resolving update from ${sourceTitle}`;
  return {
    text,
    paths: update.conflictedPaths,
    line:
      update.conflictedPaths.length === 0 ? text : `${text} · ${update.conflictedPaths.join(", ")}`,
    action: { kind: "abortUpdate", label: "Abort update" },
  };
}

/** Behind Push and Create PR in a branch whose source is open. */
export function gitButtonLineageWarning(
  shell: Pick<LineageShell, "branchLink">,
  viewer: LineageViewer,
): string | null {
  const source = shell.branchLink?.source ?? null;
  if (source === null || source.title === null || (source.state ?? "open") !== "open") return null;
  const ships = `${source.title}'s pull request ships this work.`;
  if (source.ownerId === null || isViewer(viewer, source.ownerId)) return ships;
  const owner = viewer.nameOf(source.ownerId);
  return `${ships} Pushing also includes ${owner}'s unpushed work, authored as ${owner}.`;
}

/** Revert to a turn in a source names the applied changes it discards: those decided after it. */
export function revertAcrossApplyNote(
  view: Pick<LineageView, "offers">,
  targetTurnAt: string,
  viewer: LineageViewer,
): string | null {
  const after = Date.parse(targetTurnAt);
  const files = new Map<MemberId, number>();
  for (const offer of view.offers) {
    if (offer.state !== "applied" || offer.revertedAt !== null || offer.decidedAt === null)
      continue;
    if (!(Date.parse(offer.decidedAt) > after)) continue;
    files.set(offer.senderId, (files.get(offer.senderId) ?? 0) + offer.files.length);
  }
  if (files.size === 0) return null;
  const parts = [...files].map(
    ([senderId, count]) => `${whose(viewer, senderId)} applied changes (${plural(count, "file")})`,
  );
  const [only] = files.keys();
  const keeps =
    files.size === 1 && only !== undefined
      ? `${capitalize(whose(viewer, only))} branch keeps them`
      : "Their branches keep them";
  return `This also discards ${joinNames(parts)}. ${keeps}, so they can be offered again.`;
}

/** Another member's thread on a machine. */
export interface MachineThread {
  readonly ownerId: MemberId | null;
  readonly title: string;
}

const othersOn = (threads: ReadonlyArray<MachineThread>, viewer: LineageViewer) =>
  threads.filter(
    (thread): thread is MachineThread & { readonly ownerId: MemberId } =>
      thread.ownerId !== null && !isViewer(viewer, thread.ownerId),
  );

/** Sleep or Discard confirms by name when others' threads share the machine. */
export function machineOthersNote(
  threads: ReadonlyArray<MachineThread>,
  viewer: LineageViewer,
  kind: "sleep" | "discard",
): string | null {
  const others = othersOn(threads, viewer);
  const [first] = others;
  if (first === undefined) return null;
  const named = joinNames(
    others.map((thread) => `${viewer.nameOf(thread.ownerId)}'s ${thread.title}`),
  );
  const on = `${named} ${others.length === 1 ? "is" : "are"} on this machine too.`;
  if (kind === "sleep") return on;
  return others.length === 1
    ? `${on} ${viewer.nameOf(first.ownerId)}'s agent stops there. Work up to its last turn is kept, and ${viewer.nameOf(first.ownerId)}'s next message offers a new machine.`
    : `${on} Their agents stop there. Work up to each thread's last turn is kept, and each owner's next message offers a new machine.`;
}

/** Settling or archiving a source asks first while others' threads keep its machine running. */
export function sourceKeepsMachineNote(
  threads: ReadonlyArray<MachineThread>,
  viewer: LineageViewer,
): string | null {
  const others = othersOn(threads, viewer);
  if (others.length === 0) return null;
  const owners = [...new Set(others.map((thread) => thread.ownerId))].map(
    (ownerId) => `${viewer.nameOf(ownerId)}'s`,
  );
  return others.length === 1
    ? `${owners[0]} thread is still on this machine and keeps it running.`
    : `${joinNames(owners)} threads are still on this machine and keep it running.`;
}

/** Removing a member from a machine's sharing; null when they have no thread on it. */
export function removeMemberMachineNote(
  memberId: MemberId,
  threadCount: number,
  viewer: LineageViewer,
): { readonly body: string; readonly moveFirst: string } | null {
  if (threadCount === 0) return null;
  const name = viewer.nameOf(memberId);
  const them = threadCount === 1 ? "it" : "them";
  return {
    body: `${name} has ${plural(threadCount, "thread")} on this machine and will lose access to ${them}.`,
    moveFirst: `Move ${them} to ${name}'s own machine first`,
  };
}

export function moveToOwnMachineConfirm(threadTitle: string) {
  return {
    title: "Move to your own machine?",
    body: `${threadTitle} continues on a new machine from its latest turn, with its conversation and lineage. Then you can share it or add it to another task.`,
    confirm: "Move to my own machine",
  } as const;
}

export type CloudThreadMenuItemId =
  | "branchOff"
  | "sideChat"
  | "follow"
  | "copyLink"
  | "continueLocally"
  | "share"
  | "assign"
  | "fork"
  | "moveToOwnMachine";

export interface CloudThreadMenuItem {
  readonly id: CloudThreadMenuItemId;
  readonly label: string;
  readonly detail: string | null;
  readonly disabled: boolean;
  /** Why it's disabled beyond the label, e.g. sharing on someone else's machine. */
  readonly disabledReason: string | null;
  /** A non-owner's Side chat runs in plan mode. */
  readonly readOnly: boolean;
  /** Items in one group sit together; clients draw separators between groups. */
  readonly group: "lineage" | "thread" | "owner";
}

/** Null for a thread without a machine; local threads keep their menu as it is. */
export function menuItemsForCloudThread(
  shell: LineageShell,
  viewer: LineageViewer,
): ReadonlyArray<CloudThreadMenuItem> | null {
  if (shell.sandboxId === undefined) return null;
  const holderId = lineageHolderOf(shell, viewer);
  const owner = isViewer(viewer, holderId);
  const item = (
    id: CloudThreadMenuItemId,
    label: string,
    group: CloudThreadMenuItem["group"],
    fields: Partial<Omit<CloudThreadMenuItem, "id" | "label" | "group">> = {},
  ): CloudThreadMenuItem => ({
    id,
    label,
    group,
    detail: null,
    disabled: false,
    disabledReason: null,
    readOnly: false,
    ...fields,
  });
  const items: CloudThreadMenuItem[] = [];
  if (canBranchOff(shell, viewer)) {
    items.push(
      item("branchOff", "Branch off…", "lineage", {
        detail:
          owner || holderId === null
            ? "Your own branch, from this thread's latest"
            : `Your own branch, from ${viewer.nameOf(holderId)}'s latest`,
      }),
    );
  }
  items.push(
    item(
      "sideChat",
      "Side chat",
      "lineage",
      owner ? {} : { detail: "Ask without changing anything", readOnly: true },
    ),
  );
  if (!owner)
    items.push(item("follow", shell.followedAt != null ? "Unfollow" : "Follow", "thread"));
  items.push(
    item("copyLink", "Copy link", "thread"),
    item("continueLocally", "Continue locally", "thread"),
  );
  if (!owner) {
    items.push(
      item("share", "Share… (owner only)", "owner", { disabled: true }),
      item("assign", "Assign to… (owner only)", "owner", { disabled: true }),
    );
    return items;
  }
  const link = shell.branchLink?.source ?? null;
  const onOthersMachine =
    link !== null && shell.sandbox !== undefined && shell.sandbox.ownerThreadId !== shell.id;
  const machineOwner =
    link?.ownerId != null && !isViewer(viewer, link.ownerId) ? viewer.nameOf(link.ownerId) : null;
  items.push(
    item(
      "share",
      "Share…",
      "owner",
      onOthersMachine
        ? {
            disabled: true,
            disabledReason:
              machineOwner === null
                ? "On this machine, sharing follows its owner's list."
                : `On ${machineOwner}'s machine, sharing follows ${machineOwner}'s list.`,
          }
        : {},
    ),
    item("assign", "Assign to…", "owner"),
    item("fork", "Fork", "owner"),
  );
  if (onOthersMachine) items.push(item("moveToOwnMachine", "Move to my own machine", "owner"));
  return items;
}
