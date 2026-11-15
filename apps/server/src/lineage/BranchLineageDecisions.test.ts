import { type BranchLineage, MemberId, type Offer, OfferId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decideLineageRecord,
  decideOfferApplied,
  decideOfferArm,
  decideOfferCreate,
  decideOfferDecline,
  decideOfferRevertArm,
  decideOfferReverted,
  decideOfferWithdraw,
  isRefusal,
} from "./BranchLineageDecisions.ts";

const kousik = MemberId.make("member:kousik");
const hanad = MemberId.make("member:hanad");
const admin = MemberId.make("member:admin");
const source = ThreadId.make("thread:prompt-builder");
const branch = ThreadId.make("thread:rationale");
const now = "2026-11-15T10:00:00.000Z";

const lineage: BranchLineage = {
  branchThreadId: branch,
  sourceThreadId: source,
  sourceOwnerId: kousik,
  createdAt: now,
  createdBy: hanad,
  runsOn: "source-machine",
  startFrom: { type: "latest" },
  snapshots: [],
  update: null,
  undoableUpdate: null,
  toOffer: { count: 2, commits: ["a1", "b2"] },
  behind: 0,
  sourceState: "open",
  shipped: null,
  unshipped: 0,
  reverted: null,
  revision: 1,
};

const offer = (id: string, overrides: Partial<Offer> = {}): Offer => ({
  id: OfferId.make(id),
  sourceThreadId: source,
  branchThreadId: branch,
  senderId: hanad,
  senderKind: "person",
  note: null,
  state: "open",
  commits: [],
  files: [],
  additions: 0,
  deletions: 0,
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
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const first = offer("ofr_00000000000000000001");
const reason = (decision: unknown) => (isRefusal(decision) ? decision.reason : "accepted");

describe("offer transitions", () => {
  it("replaces the branch's open offer, which reads as withdrawn", () => {
    const next = offer("ofr_00000000000000000002");
    const decided = decideOfferCreate({
      offer: next,
      lineage,
      openOffers: [first],
      exists: false,
      now,
    });
    expect(isRefusal(decided) ? decided : decided.map((o) => [o.id, o.state, o.replaced])).toEqual([
      [first.id, "withdrawn", false],
      [next.id, "open", true],
    ]);
  });

  it.each([
    [
      "withdraw after Apply",
      () => decideOfferWithdraw({ offer: offer(first.id, { armedAt: now }), actorId: hanad, now }),
      "busy",
    ],
    [
      "withdraw after applied",
      () =>
        decideOfferWithdraw({ offer: offer(first.id, { state: "applied" }), actorId: hanad, now }),
      "not-allowed",
    ],
    [
      "withdraw by someone else",
      () => decideOfferWithdraw({ offer: first, actorId: kousik, now }),
      "not-allowed",
    ],
    [
      "withdraw by the sender",
      () => decideOfferWithdraw({ offer: first, actorId: hanad, now }),
      "accepted",
    ],
    [
      "withdraw by the server",
      () => decideOfferWithdraw({ offer: first, actorId: undefined, now }),
      "accepted",
    ],
    [
      "Apply after withdraw",
      () =>
        decideOfferArm({
          offer: offer(first.id, { state: "withdrawn" }),
          actorId: kousik,
          holderId: kousik,
          stepPending: false,
          sourceArchived: false,
          now,
        }),
      "not-allowed",
    ],
    [
      "Apply twice",
      () =>
        decideOfferArm({
          offer: offer(first.id, { armedAt: now }),
          actorId: kousik,
          holderId: kousik,
          stepPending: false,
          sourceArchived: false,
          now,
        }),
      "busy",
    ],
    [
      "Apply by a non-holder",
      () =>
        decideOfferArm({
          offer: first,
          actorId: hanad,
          holderId: kousik,
          stepPending: false,
          sourceArchived: false,
          now,
        }),
      "not-source-owner",
    ],
    [
      "Apply by an admin",
      () =>
        decideOfferArm({
          offer: first,
          actorId: admin,
          holderId: kousik,
          stepPending: false,
          sourceArchived: false,
          now,
        }),
      "not-source-owner",
    ],
    [
      "Apply on an archived source",
      () =>
        decideOfferArm({
          offer: first,
          actorId: kousik,
          holderId: kousik,
          stepPending: false,
          sourceArchived: true,
          now,
        }),
      "source-unavailable",
    ],
    [
      "Apply by the holder",
      () =>
        decideOfferArm({
          offer: first,
          actorId: kousik,
          holderId: kousik,
          stepPending: false,
          sourceArchived: false,
          now,
        }),
      "accepted",
    ],
    [
      "Decline by a non-holder",
      () => decideOfferDecline({ offer: first, actorId: admin, holderId: kousik, now }),
      "not-source-owner",
    ],
    [
      "Decline by the holder",
      () => decideOfferDecline({ offer: first, actorId: kousik, holderId: kousik, now }),
      "accepted",
    ],
    [
      "applied without Apply",
      () => decideOfferApplied({ offer: first, actorId: kousik, now }),
      "not-allowed",
    ],
    [
      "revert an open offer",
      () => decideOfferRevertArm({ offer: first, actorId: kousik, holderId: kousik }),
      "not-allowed",
    ],
    [
      "revert by a non-holder",
      () =>
        decideOfferRevertArm({
          offer: offer(first.id, { state: "applied" }),
          actorId: hanad,
          holderId: kousik,
        }),
      "not-source-owner",
    ],
    [
      "revert twice",
      () =>
        decideOfferReverted({
          offer: offer(first.id, { state: "applied", revertedAt: now }),
          actorId: kousik,
          now,
        }),
      "not-allowed",
    ],
    [
      "revert once",
      () =>
        decideOfferReverted({ offer: offer(first.id, { state: "applied" }), actorId: kousik, now }),
      "accepted",
    ],
  ])("%s", (_name, decide, expected) => {
    expect(reason(decide())).toBe(expected === "accepted" ? "accepted" : expected);
  });

  it("decides the first of a racing Apply and Withdraw", () => {
    const armed = decideOfferArm({
      offer: first,
      actorId: kousik,
      holderId: kousik,
      stepPending: false,
      sourceArchived: false,
      now,
    });
    if (isRefusal(armed)) throw armed;
    expect(reason(decideOfferWithdraw({ offer: armed, actorId: hanad, now }))).toBe("busy");
    const withdrawn = decideOfferWithdraw({ offer: first, actorId: hanad, now });
    if (isRefusal(withdrawn)) throw withdrawn;
    expect(
      reason(
        decideOfferArm({
          offer: withdrawn,
          actorId: kousik,
          holderId: kousik,
          stepPending: false,
          sourceArchived: false,
          now,
        }),
      ),
    ).toBe("not-allowed");
  });

  it("records a declined or applied offer's decider", () => {
    const declined = decideOfferDecline({ offer: first, actorId: kousik, holderId: kousik, now });
    const applied = decideOfferApplied({
      offer: offer(first.id, { armedAt: now }),
      actorId: kousik,
      now,
    });
    expect([declined, applied].map((o) => (isRefusal(o) ? o : [o.state, o.decidedBy]))).toEqual([
      ["declined", kousik],
      ["applied", kousik],
    ]);
  });
});

describe("lineage records", () => {
  it.each([
    ["moves forward", { ...lineage, revision: 2 }, null],
    ["repeats a revision", { ...lineage, revision: 1 }, "busy"],
    [
      "changes source",
      { ...lineage, revision: 2, sourceThreadId: ThreadId.make("thread:other") },
      "failed",
    ],
  ] as const)("refuses a record that %s unless it moves forward", (_name, next, expected) => {
    expect(decideLineageRecord({ threadId: branch, existing: lineage, next })?.reason ?? null).toBe(
      expected,
    );
  });
});
