import {
  type BranchLineage,
  BranchLineageError,
  type BranchLineageErrorReason,
  type BranchLineageStep,
  type LineageNotice,
  type MemberId,
  type Offer,
  type OfferReturnReason,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// Pure transitions for branch off's records. The orchestrator reads the records under the source's
// lock and calls these, so a decision here is final: the first of a racing Apply and Withdraw wins.

/** The refusal an `OrchestratorDispatchError` carries; `BranchLineageService` hands it on. */
export const lineageRefusal = (reason: BranchLineageErrorReason, message: string) =>
  new BranchLineageError({ reason, message });

type Decision<A> = A | BranchLineageError;

const isBranchLineageError = Schema.is(BranchLineageError);

export const isRefusal = <A>(decision: Decision<A>): decision is BranchLineageError =>
  isBranchLineageError(decision);

/** A new offer replaces the branch's open one: the old one is withdrawn, the new one "updated". */
export function decideOfferCreate(input: {
  readonly offer: Offer;
  readonly lineage: BranchLineage | null;
  /** The branch's offers that are still open. */
  readonly openOffers: ReadonlyArray<Offer>;
  readonly exists: boolean;
  readonly now: string;
}): Decision<ReadonlyArray<Offer>> {
  const { offer, lineage } = input;
  if (input.exists) return lineageRefusal("failed", `Offer ${offer.id} already exists.`);
  if (lineage === null || lineage.sourceThreadId !== offer.sourceThreadId)
    return lineageRefusal("not-found", `Thread ${offer.branchThreadId} is not a branch of it.`);
  if (offer.state !== "open" || offer.armedAt !== null)
    return lineageRefusal("failed", "A new offer starts open and unarmed.");
  if (lineage.update !== null)
    return lineageRefusal("update-open", "Finish the open Update before offering.");
  // An armed offer is Apply's already: replacing it would race the step.
  if (input.openOffers.some((open) => open.armedAt !== null))
    return lineageRefusal("busy", "The open offer is being applied.");
  const replaced = input.openOffers.map((open): Offer => ({
    ...open,
    state: "withdrawn",
    updatedAt: input.now,
  }));
  return [...replaced, { ...offer, replaced: replaced.length > 0 }];
}

const requireOpen = (offer: Offer): BranchLineageError | null =>
  offer.state !== "open"
    ? lineageRefusal("not-allowed", `The offer is already ${offer.state}.`)
    : offer.armedAt !== null
      ? lineageRefusal("busy", "The offer is being applied.")
      : null;

/** The sender, until Apply is pressed. Without an actor the server withdraws it. */
export function decideOfferWithdraw(input: {
  readonly offer: Offer;
  readonly actorId: MemberId | undefined;
  readonly now: string;
}): Decision<Offer> {
  const refused = requireOpen(input.offer);
  if (refused !== null) return refused;
  if (input.actorId !== undefined && input.actorId !== input.offer.senderId)
    return lineageRefusal("not-allowed", "Only the sender can withdraw an offer.");
  return { ...input.offer, state: "withdrawn", updatedAt: input.now };
}

/** Apply and Decline are the source holder's alone, with no admin override. */
const requireHolder = (actorId: MemberId, holderId: MemberId | null) =>
  actorId === holderId
    ? null
    : lineageRefusal("not-source-owner", "Only the thread's owner can decide on an offer.");

export function decideOfferArm(input: {
  readonly offer: Offer;
  readonly actorId: MemberId;
  readonly holderId: MemberId | null;
  readonly stepPending: boolean;
  readonly sourceArchived: boolean;
  readonly now: string;
}): Decision<Offer> {
  const refused =
    requireOpen(input.offer) ??
    requireHolder(input.actorId, input.holderId) ??
    (input.sourceArchived
      ? lineageRefusal("source-unavailable", "Unarchive the thread to apply.")
      : input.stepPending
        ? lineageRefusal("busy", "Another change is waiting for this turn to end.")
        : null);
  if (refused !== null) return refused;
  return { ...input.offer, armedAt: input.now, updatedAt: input.now };
}

export function decideOfferDecline(input: {
  readonly offer: Offer;
  readonly actorId: MemberId;
  readonly holderId: MemberId | null;
  readonly now: string;
}): Decision<Offer> {
  const refused = requireOpen(input.offer) ?? requireHolder(input.actorId, input.holderId);
  if (refused !== null) return refused;
  return {
    ...input.offer,
    state: "declined",
    decidedBy: input.actorId,
    decidedAt: input.now,
    updatedAt: input.now,
  };
}

/** Only an armed offer is applied: the step that armed it wrote it. */
export function decideOfferApplied(input: {
  readonly offer: Offer;
  readonly actorId: MemberId;
  readonly now: string;
}): Decision<Offer> {
  if (input.offer.state !== "open" || input.offer.armedAt === null)
    return lineageRefusal("not-allowed", "Only an armed open offer can be applied.");
  return {
    ...input.offer,
    state: "applied",
    decidedBy: input.actorId,
    decidedAt: input.now,
    updatedAt: input.now,
  };
}

/** An open offer, armed or not, goes back to its sender. Terminal for that offer. */
export function decideOfferReturned(input: {
  readonly offer: Offer;
  readonly reason: OfferReturnReason;
  readonly paths: ReadonlyArray<string>;
  readonly now: string;
}): Decision<Offer> {
  if (input.offer.state !== "open")
    return lineageRefusal("not-allowed", `The offer is already ${input.offer.state}.`);
  return {
    ...input.offer,
    state: "returned",
    armedAt: null,
    returnReason: input.reason,
    returnPaths: [...input.paths],
    updatedAt: input.now,
  };
}

/** Revert is the holder's, once per applied offer. */
export function decideOfferRevertArm(input: {
  readonly offer: Offer;
  readonly actorId: MemberId;
  readonly holderId: MemberId | null;
}): BranchLineageError | null {
  if (input.offer.state !== "applied" || input.offer.revertedAt !== null)
    return lineageRefusal(
      "not-allowed",
      "Only applied changes that are still here can be reverted.",
    );
  return requireHolder(input.actorId, input.holderId);
}

export function decideOfferReverted(input: {
  readonly offer: Offer;
  readonly actorId: MemberId;
  readonly now: string;
}): Decision<Offer> {
  if (input.offer.state !== "applied" || input.offer.revertedAt !== null)
    return lineageRefusal("not-allowed", "These changes were already reverted.");
  return {
    ...input.offer,
    revertedAt: input.now,
    revertedBy: input.actorId,
    updatedAt: input.now,
  };
}

/** A record rewrite must name the same pair and move `revision` forward. */
export function decideLineageRecord(input: {
  readonly threadId: ThreadId;
  readonly existing: BranchLineage | null;
  readonly next: BranchLineage;
}): BranchLineageError | null {
  const { existing, next } = input;
  if (next.branchThreadId !== input.threadId)
    return lineageRefusal("failed", "A lineage record is written on its branch's stream.");
  if (existing === null)
    return lineageRefusal("not-found", `Thread ${input.threadId} is not a branch.`);
  if (existing.sourceThreadId !== next.sourceThreadId)
    return lineageRefusal("failed", "A branch keeps its source.");
  if (next.revision <= existing.revision)
    return lineageRefusal(
      "busy",
      `Lineage revision ${next.revision} is not after ${existing.revision}.`,
    );
  return null;
}

/** One step at a time per thread. Idle, it runs now; during a turn, at the turn's end. */
export function decideStepArm(input: {
  readonly step: Omit<BranchLineageStep, "state">;
  readonly pending: BranchLineageStep | null;
  readonly turnRunning: boolean;
}): Decision<BranchLineageStep> {
  if (input.pending !== null)
    return lineageRefusal("busy", "Another change is waiting for this turn to end.");
  return { ...input.step, state: input.turnRunning ? "armed" : "running" };
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

export interface LineageNoticeContext {
  readonly nameOf: (memberId: MemberId) => string;
  readonly titleOf: (threadId: ThreadId) => string;
  /** The thread the notice is on: Apply and Decline read differently in the source and branch. */
  readonly where: "source" | "branch";
  readonly sourceThreadId: ThreadId;
  readonly branchThreadId: ThreadId;
  readonly offer?: Pick<Offer, "commits" | "senderKind">;
}

/** The third-person sentence older clients show; newer ones word `lineage` for the viewer. */
export function lineageNoticeMessage(notice: LineageNotice, context: LineageNoticeContext): string {
  const { nameOf, titleOf } = context;
  const source = titleOf(context.sourceThreadId);
  const branch = titleOf(context.branchThreadId);
  const sender = (senderId: MemberId) =>
    context.offer?.senderKind === "agent" ? `${nameOf(senderId)}'s agent` : nameOf(senderId);
  const commits = plural(context.offer?.commits.length ?? 0, "commit");
  switch (notice.kind) {
    case "branched-off":
      return `${nameOf(notice.actorId)} branched off this thread → ${branch}`;
    case "branched-from": {
      const owner = notice.sourceOwnerId === null ? "" : `${nameOf(notice.sourceOwnerId)}'s `;
      const files =
        notice.uncommittedFiles === 0
          ? ""
          : `, with its ${plural(notice.uncommittedFiles, "uncommitted file")}`;
      return `${nameOf(notice.actorId)} branched off ${owner}${source} at turn ${notice.turn}${files}`;
    }
    case "updated":
      return `Updated from ${source} · ${plural(notice.files, "file")}`;
    case "update-conflict":
      return `Resolving update from ${source} · ${notice.paths.join(", ")}`;
    case "update-aborted":
      return `Update from ${source} aborted`;
    case "update-undone":
      return `Update from ${source} undone`;
    case "agent-told":
      return notice.text;
    case "offer":
      return `${sender(notice.senderId)} offered ${commits} from ${branch}`;
    case "offer-sent":
      return `${sender(notice.senderId)} offered ${commits} to ${source}`;
    case "applied":
      return context.where === "source"
        ? `${nameOf(notice.actorId)} applied ${nameOf(notice.senderId)}'s changes from ${branch} · ${plural(notice.files, "file")}`
        : `${nameOf(notice.actorId)} applied ${nameOf(notice.senderId)}'s changes`;
    case "declined":
      return context.where === "source"
        ? `${nameOf(notice.actorId)} declined ${nameOf(notice.senderId)}'s ${commits}`
        : `${nameOf(notice.actorId)} declined`;
    case "withdrawn":
      return `${sender(notice.senderId)} withdrew the offer`;
    case "returned":
      return `${source} changed since the offer was sent. The offer came back`;
    case "reverted":
      return `${nameOf(notice.actorId)} reverted ${nameOf(notice.senderId)}'s changes · ${plural(notice.files, "file")}`;
    case "credited-commit":
      return `${notice.subject} · credits ${nameOf(notice.coAuthor)}`;
    case "reverted-kept":
      return "The applied changes were reverted in the source. They're still here, and can be offered again.";
    case "reverted-removed":
      return "The applied changes were reverted in the source, and this Update removed them here too";
    case "brought-back":
      return `Brought back ${plural(notice.commits.length, "commit")}`;
    case "moved-machine":
      return `${nameOf(notice.actorId)} moved this thread to its own machine`;
  }
}
