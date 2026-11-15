import { type OrchestrationV2ThreadShellBranchLink, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { lineageNotificationKind } from "./lineageNotifications";

type Source = NonNullable<OrchestrationV2ThreadShellBranchLink["source"]>;

const asSource = (revision: number, openOffers: number): OrchestrationV2ThreadShellBranchLink => ({
  revision,
  source: null,
  openOffers,
});

const asBranch = (
  revision: number,
  offerState: Source["offerState"],
): OrchestrationV2ThreadShellBranchLink => ({
  revision,
  source: {
    threadId: ThreadId.make("thread-source"),
    ownerId: null,
    title: "Prompt builder",
    state: "open",
    toOffer: 0,
    behind: 0,
    updateInProgress: null,
    undoableUpdate: false,
    offerState,
    allApplied: false,
    shippedLabel: null,
    unshipped: 0,
  },
  openOffers: 0,
});

describe("lineageNotificationKind", () => {
  it.each([
    ["a new offer on a source", asSource(1, 0), asSource(2, 1), "offer"],
    ["a source's first offer, before it had a link", null, asSource(1, 1), "offer"],
    ["an offer replaced in place", asSource(2, 1), asSource(3, 1), null],
    ["an offer decided", asSource(3, 1), asSource(4, 0), null],
    ["the branch's offer applied", asBranch(1, "open"), asBranch(2, "applied"), "offer-applied"],
    ["the branch's offer declined", asBranch(1, "open"), asBranch(2, "declined"), "offer-declined"],
    ["the branch's offer returned", asBranch(1, "open"), asBranch(2, "returned"), "offer-returned"],
    ["the sender withdrew it", asBranch(1, "open"), asBranch(2, "withdrawn"), null],
    [
      "an older outcome on an unrelated change",
      asBranch(1, "applied"),
      asBranch(2, "applied"),
      null,
    ],
    ["the same revision seen again", asBranch(2, "open"), asBranch(2, "applied"), null],
  ] as const)("%s", (_name, prior, next, expected) => {
    expect(lineageNotificationKind(prior, next)).toBe(expected);
  });
});
