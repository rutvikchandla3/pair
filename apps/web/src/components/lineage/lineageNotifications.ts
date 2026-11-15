import type { OrchestrationV2ThreadShellBranchLink } from "@t3tools/contracts";

export type LineageNotificationKind =
  | "offer"
  | "offer-applied"
  | "offer-declined"
  | "offer-returned";

/**
 * What a shell's lineage change tells its holder: a new offer on a source, or how the owner
 * answered the branch's offer. Null when nothing new happened. A thread without a link yet
 * (`prior` null) is a source with no offers.
 */
export function lineageNotificationKind(
  prior: OrchestrationV2ThreadShellBranchLink | null | undefined,
  next: OrchestrationV2ThreadShellBranchLink | null | undefined,
): LineageNotificationKind | null {
  if (next == null || prior?.revision === next.revision) return null;
  if (next.openOffers > (prior?.openOffers ?? 0)) return "offer";
  if (prior?.source?.offerState !== "open") return null;
  switch (next.source?.offerState) {
    case "applied":
      return "offer-applied";
    case "declined":
      return "offer-declined";
    case "returned":
      return "offer-returned";
    default:
      return null;
  }
}
