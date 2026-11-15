import {
  type EnvironmentId,
  type OfferId,
  type ScopedThreadRef,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

const threadKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}\u0000${threadId}`;

// Writes on one branch share a lane, so an Update, Abort and Offer land in the order pressed;
// writes on one offer share another.
const threadLane = ({
  environmentId,
  input,
}: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly threadId: ThreadId };
}) => `${environmentId}:lineage:${input.threadId}`;
const offerLane = ({
  environmentId,
  input,
}: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly offerId: OfferId };
}) => `${environmentId}:offer:${input.offerId}`;
const sourceLane = ({
  environmentId,
  input,
}: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly sourceThreadId: ThreadId };
}) => `${environmentId}:branch-off:${input.sourceThreadId}`;

/**
 * Branch off for one environment. Reads refetch while read whenever the thread's shell moves its
 * `branchLink.revision`, which every lineage or offer change touching the thread does.
 */
export function createBranchLineageEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  deps: {
    readonly threadShells: {
      readonly quietThreadShellAtom: (
        ref: ScopedThreadRef,
      ) => Atom.Atom<EnvironmentThreadShell | null>;
    };
  },
) {
  /** The thread's lineage revision from its shell, keyed `env\u0000threadId`; null without one. */
  const revisionFamily = Atom.family((key: string) => {
    const separator = key.indexOf("\u0000");
    const environmentId = key.slice(0, separator) as EnvironmentId;
    const threadId = key.slice(separator + 1) as ThreadId;
    return Atom.make(
      (get) =>
        get(deps.threadShells.quietThreadShellAtom({ environmentId, threadId }))?.source.branchLink
          ?.revision ?? null,
    ).pipe(Atom.withLabel(`branch-lineage-revision:${key}`));
  });
  const revisionAtom = (ref: ScopedThreadRef) =>
    revisionFamily(threadKey(ref.environmentId, ref.threadId));

  /** `lineage.read`: the chip's popover, timeline actions and offer cards; keyed `{ threadId }`. */
  const view = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:branch-lineage:read",
    tag: WS_METHODS.lineageRead,
    refreshTrigger: ({ environmentId, input }) =>
      revisionFamily(threadKey(environmentId, input.threadId)),
  });

  /** `thread.branchOffDraft` for the draft; keyed `{ sourceThreadId }`. */
  const branchOffDraft = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:branch-lineage:branch-off-draft",
    tag: WS_METHODS.threadBranchOffDraft,
    refreshTrigger: ({ environmentId, input }) =>
      revisionFamily(threadKey(environmentId, input.sourceThreadId)),
  });

  /** `thread.updatePreview` for the Update dialog; keyed `{ threadId }` of the branch. */
  const updatePreview = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:branch-lineage:update-preview",
    tag: WS_METHODS.threadUpdatePreview,
    refreshTrigger: ({ environmentId, input }) =>
      revisionFamily(threadKey(environmentId, input.threadId)),
  });

  /** `offer.preview` for the Offer dialog; keyed `{ threadId }` of the branch. */
  const offerPreview = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:branch-lineage:offer-preview",
    tag: WS_METHODS.offerPreview,
    refreshTrigger: ({ environmentId, input }) =>
      revisionFamily(threadKey(environmentId, input.threadId)),
  });

  /** `offer.diff` for View changes; keyed `{ offerId }`. An offer's commits never change. */
  const offerDiff = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:branch-lineage:offer-diff",
    tag: WS_METHODS.offerDiff,
  });

  return {
    revisionAtom,
    view,
    branchOffDraft,
    updatePreview,
    offerPreview,
    offerDiff,
    branchOff: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:branch-lineage:branch-off",
      tag: WS_METHODS.threadBranchOff,
      concurrency: { mode: "serial", key: sourceLane },
    }),
    /** Runs a model on the caller's account; a second press joins the first. */
    branchOffSummary: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:branch-lineage:branch-off-summary",
      tag: WS_METHODS.threadBranchOffSummary,
      concurrency: { mode: "singleFlight", key: sourceLane },
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:branch-lineage:update",
      tag: WS_METHODS.threadUpdate,
      concurrency: { mode: "serial", key: threadLane },
    }),
    abortUpdate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:branch-lineage:abort-update",
      tag: WS_METHODS.threadAbortUpdate,
      concurrency: { mode: "serial", key: threadLane },
    }),
    undoUpdate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:branch-lineage:undo-update",
      tag: WS_METHODS.threadUndoUpdate,
      concurrency: { mode: "serial", key: threadLane },
    }),
    bringBack: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:branch-lineage:bring-back",
      tag: WS_METHODS.threadBringBack,
      concurrency: { mode: "serial", key: threadLane },
    }),
    offerCreate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:branch-lineage:offer-create",
      tag: WS_METHODS.offerCreate,
      concurrency: { mode: "serial", key: threadLane },
    }),
    offerWithdraw: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:branch-lineage:offer-withdraw",
      tag: WS_METHODS.offerWithdraw,
      concurrency: { mode: "serial", key: offerLane },
    }),
    offerApply: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:branch-lineage:offer-apply",
      tag: WS_METHODS.offerApply,
      concurrency: { mode: "serial", key: offerLane },
    }),
    offerDecline: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:branch-lineage:offer-decline",
      tag: WS_METHODS.offerDecline,
      concurrency: { mode: "serial", key: offerLane },
    }),
    revertOffer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:branch-lineage:revert-offer",
      tag: WS_METHODS.threadRevertOffer,
      concurrency: { mode: "serial", key: offerLane },
    }),
    moveToOwnMachine: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:branch-lineage:move-to-own-machine",
      tag: WS_METHODS.threadMoveToOwnMachine,
      concurrency: { mode: "serial", key: threadLane },
    }),
    startFromMain: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:branch-lineage:start-from-main",
      tag: WS_METHODS.threadStartFromMain,
      concurrency: { mode: "serial", key: threadLane },
    }),
  };
}
