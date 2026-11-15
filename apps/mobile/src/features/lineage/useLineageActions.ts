import { useNavigation } from "@react-navigation/native";
import { moveToOwnMachineConfirm } from "@t3tools/client-runtime/branch-lineage";
import type { OfferId, ScopedThreadRef } from "@t3tools/contracts";
import { Keyboard } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { branchLineageEnvironment, reportLineageResult } from "../../state/branch-lineage";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

type LineageSheetName = "ThreadBranchOff" | "ThreadLineage" | "ThreadUpdate" | "ThreadOffer";

/** Opens the lineage sheets and runs the one-tap lineage commands, alerting a refusal. */
export function useLineageActions() {
  const navigation = useNavigation();
  const options = { reportFailure: false };
  const abortUpdate = useAtomCommand(branchLineageEnvironment.abortUpdate, options);
  const undoUpdate = useAtomCommand(branchLineageEnvironment.undoUpdate, options);
  const bringBack = useAtomCommand(branchLineageEnvironment.bringBack, options);
  const withdraw = useAtomCommand(branchLineageEnvironment.offerWithdraw, options);
  const apply = useAtomCommand(branchLineageEnvironment.offerApply, options);
  const decline = useAtomCommand(branchLineageEnvironment.offerDecline, options);
  const revertOffer = useAtomCommand(branchLineageEnvironment.revertOffer, options);
  const startFromMain = useAtomCommand(branchLineageEnvironment.startFromMain, options);
  const moveToOwnMachine = useAtomCommand(branchLineageEnvironment.moveToOwnMachine, options);
  const settle = useAtomCommand(threadEnvironment.settle, options);

  const thread = (ref: ScopedThreadRef) => ({
    environmentId: ref.environmentId,
    input: { threadId: ref.threadId },
  });
  const offer = (ref: ScopedThreadRef, offerId: OfferId) => ({
    environmentId: ref.environmentId,
    input: { offerId },
  });

  return {
    open: (sheet: LineageSheetName, ref: ScopedThreadRef) => {
      Keyboard.dismiss();
      navigation.navigate(sheet, {
        environmentId: String(ref.environmentId),
        threadId: String(ref.threadId),
      });
    },
    openOfferChanges: (ref: ScopedThreadRef, offerId: OfferId) => {
      Keyboard.dismiss();
      navigation.navigate("ThreadOfferChanges", {
        environmentId: String(ref.environmentId),
        threadId: String(ref.threadId),
        offerId: String(offerId),
      });
    },
    abortUpdate: async (ref: ScopedThreadRef) =>
      reportLineageResult("Could not abort the update", await abortUpdate(thread(ref))),
    undoUpdate: async (ref: ScopedThreadRef) =>
      reportLineageResult("Could not undo the update", await undoUpdate(thread(ref))),
    bringBack: async (ref: ScopedThreadRef) =>
      reportLineageResult("Could not bring them back", await bringBack(thread(ref))),
    startFromMain: async (ref: ScopedThreadRef) =>
      reportLineageResult("Could not start from main", await startFromMain(thread(ref))),
    settle: async (ref: ScopedThreadRef) =>
      reportLineageResult("Could not settle thread", await settle(thread(ref))),
    moveToOwnMachine: (ref: ScopedThreadRef, threadTitle: string) => {
      const copy = moveToOwnMachineConfirm(threadTitle);
      Dialog.confirm({
        title: copy.title,
        message: copy.body,
        confirmText: copy.confirm,
        onConfirm: () =>
          void moveToOwnMachine(thread(ref)).then((result) =>
            reportLineageResult("Could not move the thread", result),
          ),
      });
    },
    withdraw: async (ref: ScopedThreadRef, offerId: OfferId) =>
      reportLineageResult("Could not withdraw the offer", await withdraw(offer(ref, offerId))),
    apply: async (ref: ScopedThreadRef, offerId: OfferId) =>
      reportLineageResult("Could not apply the changes", await apply(offer(ref, offerId))),
    decline: async (ref: ScopedThreadRef, offerId: OfferId) =>
      reportLineageResult("Could not decline the offer", await decline(offer(ref, offerId))),
    revertOffer: (ref: ScopedThreadRef, offerId: OfferId, label: string) =>
      Dialog.confirm({
        title: `${label}?`,
        message: "Removes those lines from your files as one recorded step. Later turns stay.",
        confirmText: "Revert",
        destructive: true,
        onConfirm: () =>
          void revertOffer(offer(ref, offerId)).then((result) =>
            reportLineageResult("Could not revert the changes", result),
          ),
      }),
  };
}
