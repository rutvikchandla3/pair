import { CommandId, type TeamImageBuildFailure } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as LiveTeamImageBuild from "./LiveTeamImageBuild.ts";
import * as TeamImageService from "./TeamImageService.ts";
import * as TeamImageStore from "./TeamImageStore.ts";

const BUILD_DEADLINE_MS = 45 * 60_000;
const LAUNCH_DEADLINE_MS = 10 * 60_000;

/** One sweep per call; the layer registers it with the scheduler. */
export const makeSweep = Effect.gen(function* () {
  const liveBuild = yield* LiveTeamImageBuild.LiveTeamImageBuild;
  const store = yield* TeamImageStore.TeamImageStore;
  const service = yield* TeamImageService.TeamImageService;

  return Effect.fn("TeamImageWorker.sweep")(function* () {
    const live = yield* liveBuild.current;
    if (live === null) return;
    const record = yield* store.build(live.imageBuildId);
    if (Option.isNone(record)) return;
    const { build } = record.value;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const failure: TeamImageBuildFailure | null =
      nowMs >= DateTime.toEpochMillis(build.requestedAt) + BUILD_DEADLINE_MS
        ? { phase: "timed-out", detail: "The build ran past 45 minutes.", logTail: [] }
        : build.status === "launching" &&
            build.startedAt !== null &&
            nowMs >= DateTime.toEpochMillis(build.startedAt) + LAUNCH_DEADLINE_MS
          ? { phase: "launch", detail: "The build machine did not start.", logTail: [] }
          : null;
    if (failure === null) return;
    yield* service.dispatch({
      type: "team-image.build.fail",
      commandId: CommandId.make(`server:team-image.build.${failure.phase}:${build.id}`),
      imageBuildId: build.id,
      failure,
    });
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("team-image", sweep());
  }),
);
