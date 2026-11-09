import { CommandId, type TeamImageBuild, type TeamImageBuildFailure } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as LiveTeamImageBuild from "./LiveTeamImageBuild.ts";
import * as TeamImageBuildLog from "./TeamImageBuildLog.ts";
import { DEFAULT_KEEP_SUCCEEDED, planTeamImageCollection } from "./TeamImageCollection.ts";
import * as TeamImageService from "./TeamImageService.ts";
import * as TeamImageStore from "./TeamImageStore.ts";

const BUILD_DEADLINE_MS = 45 * 60_000;
const LAUNCH_DEADLINE_MS = 10 * 60_000;
const COLLECT_EVERY_MS = 24 * 60 * 60_000;

/** One sweep per call; the layer registers it with the scheduler. */
export const makeSweep = Effect.gen(function* () {
  const liveBuild = yield* LiveTeamImageBuild.LiveTeamImageBuild;
  const store = yield* TeamImageStore.TeamImageStore;
  const service = yield* TeamImageService.TeamImageService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const buildLog = yield* TeamImageBuildLog.TeamImageBuildLog;
  const settings = yield* ServerSettings.ServerSettingsService;
  // In memory: a restart collects once at start, and each success asks for a run on the next tick.
  const collectedAtMs = yield* Ref.make<number | null>(null);
  yield* service.buildFinished.pipe(
    Stream.filter(({ build }) => build.status === "succeeded"),
    Stream.runForEach(() => Ref.set(collectedAtMs, null)),
    Effect.forkScoped,
  );

  const failOverdue = Effect.fnUntraced(function* (nowMs: number) {
    const live = yield* liveBuild.current;
    if (live === null) return;
    const record = yield* store.build(live.imageBuildId);
    if (Option.isNone(record)) return;
    const { build } = record.value;
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

  const deleteLog = Effect.fnUntraced(function* (build: TeamImageBuild) {
    yield* buildLog.delete(build.number);
    yield* service.dispatch({
      type: "team-image.build.log-deleted",
      commandId: CommandId.make(`server:team-image.build.log-deleted:${build.id}`),
      imageBuildId: build.id,
    });
  });

  const collect = Effect.fn("TeamImageWorker.collect")(function* (now: DateTime.Utc) {
    const { activeBuildId } = yield* store.state;
    const plan = planTeamImageCollection({
      builds: yield* store.collectable,
      activeBuildId,
      referenced: yield* projections.listSandboxImageBuildIds(),
      keepSucceeded:
        (yield* settings.getSettings).sandbox?.teamImage?.keepSucceeded ?? DEFAULT_KEEP_SUCCEEDED,
      now,
    });
    for (const build of plan.images) {
      // The decider refuses the active build, so an activation since the plan wins.
      const collected = yield* service
        .dispatch({
          type: "team-image.build.collect",
          commandId: CommandId.make(`server:team-image.build.collect:${build.id}`),
          imageBuildId: build.id,
        })
        .pipe(Effect.catchTags({ TeamImageError: () => Effect.succeed([]) }));
      if (collected.length > 0) yield* deleteLog(build);
    }
    yield* Effect.forEach(plan.logs, deleteLog, { discard: true });
  });

  return Effect.fn("TeamImageWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    yield* failOverdue(nowMs);
    const last = yield* Ref.get(collectedAtMs);
    if (last !== null && nowMs < last + COLLECT_EVERY_MS) return;
    yield* Ref.set(collectedAtMs, nowMs);
    yield* collect(now);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("team-image", sweep());
  }),
);
