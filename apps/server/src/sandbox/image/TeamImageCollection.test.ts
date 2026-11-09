import { assert, describe, it } from "@effect/vitest";
import {
  ComputeDriverId,
  MemberId,
  type TeamImageBuild,
  TeamImageBuildId,
  type TeamImageBuildStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { planTeamImageCollection } from "./TeamImageCollection.ts";

const now = DateTime.makeUnsafe("2026-11-10T00:00:00.000Z");
const daysAgo = (days: number) => DateTime.subtract(now, { days });
const id = (number: number) => TeamImageBuildId.make(`tib_${number.toString().padStart(20, "0")}`);

const build = (
  number: number,
  status: TeamImageBuildStatus,
  finished: DateTime.Utc = daysAgo(1),
  imageDeletedAt: DateTime.Utc | null = null,
): TeamImageBuild => ({
  id: id(number),
  number,
  status,
  phase: null,
  recipeRevision: 1,
  driverId: ComputeDriverId.make("docker"),
  requestedBy: { kind: "member", memberId: MemberId.make("member-admin") },
  activateOnSuccess: true,
  ...(status === "succeeded" ? { imageRef: `sha256:${number}` } : {}),
  requestedAt: finished,
  startedAt: finished,
  finishedAt: finished,
  imageDeletedAt,
});

const cases: ReadonlyArray<{
  readonly name: string;
  readonly builds: ReadonlyArray<TeamImageBuild>;
  readonly active: number | null;
  readonly referenced: ReadonlyArray<number>;
  readonly keep: number;
  readonly images: ReadonlyArray<number>;
  readonly logs: ReadonlyArray<number>;
}> = [
  {
    name: "keep 1: the old active build, a referenced build and the newest succeeded survive",
    builds: [1, 2, 3, 4, 5].map((number) => build(number, "succeeded")),
    active: 1,
    referenced: [3],
    keep: 1,
    images: [4, 2],
    logs: [],
  },
  {
    name: "the newest succeeded is active: the next newest stays as the rollback",
    builds: [1, 2, 3].map((number) => build(number, "succeeded")),
    active: 3,
    referenced: [],
    keep: 1,
    images: [1],
    logs: [],
  },
  {
    name: "failed and cancelled logs go at day 31, not day 29; a removed image's log goes",
    builds: [
      build(1, "failed", daysAgo(31)),
      build(2, "cancelled", daysAgo(31)),
      build(3, "failed", daysAgo(29)),
      build(4, "succeeded", daysAgo(90), daysAgo(2)),
      build(5, "succeeded", daysAgo(90)),
    ],
    active: 5,
    referenced: [],
    keep: 5,
    images: [],
    logs: [1, 2, 4],
  },
];

describe("planTeamImageCollection", () => {
  it.each(cases)("$name", (testCase) => {
    const plan = planTeamImageCollection({
      builds: testCase.builds,
      activeBuildId: testCase.active === null ? null : id(testCase.active),
      referenced: new Set(testCase.referenced.map(id)),
      keepSucceeded: testCase.keep,
      now,
    });
    assert.deepStrictEqual(
      plan.images.map((entry) => entry.number),
      testCase.images,
    );
    assert.deepStrictEqual(
      plan.logs.map((entry) => entry.number),
      testCase.logs,
    );
  });
});
