import type {
  EnvironmentId,
  LineageUpdateResolver,
  OfferId,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { branchLineageEnvironment } from "~/state/branchLineage";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { toastManager } from "../ui/toast";
import { openLineageDialog } from "./lineageDialogTarget";

const plural = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;

/** Every lineage action a person takes from the web: chip, header, cards, rows, palette, keys. */
export function useLineageActions() {
  const options = { reportFailure: false } as const;
  const updatePreview = useAtomQueryRunner(branchLineageEnvironment.updatePreview, {
    reportFailure: false,
    refresh: true,
  });
  const update = useOrchestrationCommand(branchLineageEnvironment.update, options);
  const abortUpdate = useOrchestrationCommand(branchLineageEnvironment.abortUpdate, options);
  const undoUpdate = useOrchestrationCommand(branchLineageEnvironment.undoUpdate, options);
  const bringBack = useOrchestrationCommand(branchLineageEnvironment.bringBack, options);
  const offerWithdraw = useOrchestrationCommand(branchLineageEnvironment.offerWithdraw, options);
  const offerApply = useOrchestrationCommand(branchLineageEnvironment.offerApply, options);
  const offerDecline = useOrchestrationCommand(branchLineageEnvironment.offerDecline, options);
  const revertOffer = useOrchestrationCommand(branchLineageEnvironment.revertOffer, options);
  const startFromMain = useOrchestrationCommand(branchLineageEnvironment.startFromMain, options);

  /** The update's outcome, or null when it failed (already toasted). */
  const runUpdate = async (
    ref: ScopedThreadRef,
    onConflict: LineageUpdateResolver,
  ): Promise<"merged" | "conflicted" | "armed" | null> => {
    const result = await update({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId, onConflict },
    });
    if (result._tag !== "Success") {
      toastCommandFailure("Couldn't update", result);
      return null;
    }
    if (result.value.result === "armed") {
      toastManager.add({ type: "info", title: "Updates after this turn" });
    } else if (result.value.result === "merged" && result.value.files > 0) {
      toastManager.add({
        type: "success",
        title: "Updated",
        description: `${plural(result.value.files, "file")} changed`,
      });
    }
    return result.value.result;
  };

  const byOffer =
    (
      command: typeof offerApply,
      failure: string,
    ): ((environmentId: EnvironmentId, offerId: OfferId) => Promise<void>) =>
    async (environmentId, offerId) => {
      toastCommandFailure(failure, await command({ environmentId, input: { offerId } }));
    };
  const byThread =
    (command: typeof abortUpdate, failure: string): ((ref: ScopedThreadRef) => Promise<void>) =>
    async (ref) => {
      toastCommandFailure(
        failure,
        await command({ environmentId: ref.environmentId, input: { threadId: ref.threadId } }),
      );
    };

  return {
    /**
     * Clean previews merge in one click; a conflict opens the dialog with its two choices.
     * True once the branch has merged.
     */
    startUpdate: async (ref: ScopedThreadRef): Promise<boolean> => {
      const preview = await updatePreview({
        environmentId: ref.environmentId,
        input: { threadId: ref.threadId },
      });
      if (preview._tag !== "Success") {
        toastCommandFailure("Couldn't check the update", preview);
        return false;
      }
      if (preview.value.conflicts.length > 0) {
        openLineageDialog({ kind: "update", threadRef: ref });
        return false;
      }
      return (await runUpdate(ref, "agent")) === "merged";
    },
    runUpdate,
    openOffer: (ref: ScopedThreadRef) => openLineageDialog({ kind: "offer", threadRef: ref }),
    abortUpdate: byThread(abortUpdate, "Couldn't abort the update"),
    undoUpdate: byThread(undoUpdate, "Couldn't undo the update"),
    bringBack: byThread(bringBack, "Couldn't bring them back"),
    withdraw: byOffer(offerWithdraw, "Couldn't withdraw the offer"),
    apply: byOffer(offerApply, "Couldn't apply the offer"),
    decline: byOffer(offerDecline, "Couldn't decline the offer"),
    revertOffer: byOffer(revertOffer, "Couldn't revert the changes"),
    startFromMain: async (ref: ScopedThreadRef) => {
      const result = await startFromMain({
        environmentId: ref.environmentId,
        input: { threadId: ref.threadId },
      });
      if (result._tag !== "Success") {
        toastCommandFailure("Couldn't start from main", result);
        return;
      }
      toastManager.add({
        type: "success",
        title: `Started from ${result.value.base}`,
        description: `${plural(result.value.commits, "commit")} moved${result.value.movedMachine ? ", on your own machine" : ""}.`,
      });
    },
  };
}
