import type { TeamImageBuild, TeamImageBuildId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const DEFAULT_KEEP_SUCCEEDED = 5;
const LOG_RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * Pure. `builds` are the finished builds whose log is not deleted yet. The active build and every
 * build a live sandbox uses keep their image, and so do the newest `keepSucceeded` others, so a
 * rollback target survives. A removed image's log goes with it; that happens after its collect.
 */
export function planTeamImageCollection(input: {
  readonly builds: ReadonlyArray<TeamImageBuild>;
  readonly activeBuildId: TeamImageBuildId | null;
  readonly referenced: ReadonlySet<TeamImageBuildId>;
  readonly keepSucceeded: number;
  readonly now: DateTime.Utc;
}): {
  readonly images: ReadonlyArray<TeamImageBuild>;
  readonly logs: ReadonlyArray<TeamImageBuild>;
} {
  const nowMs = DateTime.toEpochMillis(input.now);
  const images = input.builds
    .filter(
      (build) =>
        build.status === "succeeded" &&
        build.imageDeletedAt === null &&
        build.id !== input.activeBuildId &&
        !input.referenced.has(build.id),
    )
    .toSorted((a, b) => b.number - a.number)
    .slice(input.keepSucceeded);
  const logs = input.builds.filter((build) =>
    build.status === "succeeded"
      ? build.imageDeletedAt !== null
      : build.finishedAt !== null &&
        nowMs - DateTime.toEpochMillis(build.finishedAt) >= LOG_RETENTION_MS,
  );
  return { images, logs };
}
