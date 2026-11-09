import {
  type CommandId,
  type ComputeDriverId,
  type MemberId,
  SandboxId,
  TeamImageBuild,
  type TeamImageBuildFailure,
  type TeamImageBuildId,
  TeamImageBuildPhase,
  type TeamImageBuildStatus,
  TeamImageError,
  type TeamImageManifest,
  type TeamImageRecipe,
  TeamImageRecipeRevision,
  type TeamImageRequester,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { TeamImageEffectRequestV2 } from "../../orchestration-v2/EffectOutbox.ts";

/** The build machine is never a sandbox record; its id only names the backend and runner grant. */
export const TeamImageBuildMachine = Schema.Struct({
  sandboxId: SandboxId,
  driverRef: Schema.NullOr(Schema.String),
  destroyedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type TeamImageBuildMachine = typeof TeamImageBuildMachine.Type;

/** Each event carries the whole row, so the store writes it and the service publishes it as is. */
export const TeamImageEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("team-image.recipe-saved"),
    revision: TeamImageRecipeRevision,
  }),
  Schema.Struct({
    type: Schema.Literal("team-image.build-updated"),
    build: TeamImageBuild,
    machine: TeamImageBuildMachine,
  }),
]);
export type TeamImageEvent = typeof TeamImageEvent.Type;

/** Server-internal: clients reach these through `TeamImageService`, never on the wire. */
export type TeamImageCommand = { readonly commandId: CommandId } & (
  | {
      readonly type: "team-image.recipe.save";
      readonly baseRevision: number | null;
      readonly recipe: TeamImageRecipe;
      readonly savedBy: TeamImageRequester;
    }
  | {
      readonly type: "team-image.build.request";
      readonly imageBuildId: TeamImageBuildId;
      readonly machineSandboxId: SandboxId;
      readonly recipeRevision: number;
      readonly driverId: ComputeDriverId;
      readonly requestedBy: TeamImageRequester;
      readonly activateOnSuccess: boolean;
    }
  | {
      readonly type: "team-image.build.launched";
      readonly imageBuildId: TeamImageBuildId;
      readonly driverRef: string;
    }
  | { readonly type: "team-image.build.attached"; readonly imageBuildId: TeamImageBuildId }
  | {
      readonly type: "team-image.build.phase";
      readonly imageBuildId: TeamImageBuildId;
      readonly phase: TeamImageBuildPhase;
    }
  | {
      readonly type: "team-image.build.program-finished";
      readonly imageBuildId: TeamImageBuildId;
      readonly manifest: TeamImageManifest;
    }
  | {
      readonly type: "team-image.build.captured";
      readonly imageBuildId: TeamImageBuildId;
      readonly imageRef: string;
      readonly sizeBytes: number | null;
    }
  | {
      readonly type: "team-image.build.fail";
      readonly imageBuildId: TeamImageBuildId;
      readonly failure: TeamImageBuildFailure;
    }
  | {
      readonly type: "team-image.build.cancel";
      readonly imageBuildId: TeamImageBuildId;
      readonly by: MemberId | null;
    }
  | { readonly type: "team-image.build.machine-destroyed"; readonly imageBuildId: TeamImageBuildId }
);

export interface TeamImageBuildRecord {
  readonly build: TeamImageBuild;
  readonly machine: TeamImageBuildMachine;
}

export interface TeamImageState {
  readonly latestRevision: number | null;
  readonly nextBuildNumber: number;
  /** At most one build is queued, launching, running or capturing. */
  readonly liveBuild: TeamImageBuildRecord | null;
  /** The build the command names; null when it names none or the build does not exist. */
  readonly build: TeamImageBuildRecord | null;
}

export interface TeamImageDecision {
  readonly events: ReadonlyArray<TeamImageEvent>;
  readonly effects: ReadonlyArray<TeamImageEffectRequestV2>;
  readonly cancelUnsettledEffects?: {
    readonly effectTypes: ReadonlyArray<TeamImageEffectRequestV2["type"]>;
    readonly reason: string;
  };
}

export const isLiveTeamImageBuild = (status: TeamImageBuildStatus) =>
  status === "queued" || status === "launching" || status === "running" || status === "capturing";

const NOTHING: TeamImageDecision = { events: [], effects: [] };

const refuse = (reason: TeamImageError["reason"], message: string) =>
  Result.fail(new TeamImageError({ reason, message }));

const updated = (
  record: TeamImageBuildRecord,
  build: Partial<TeamImageBuild>,
  machine?: Partial<TeamImageBuildMachine>,
): TeamImageEvent => ({
  type: "team-image.build-updated",
  build: { ...record.build, ...build },
  machine: { ...record.machine, ...machine },
});

const effect = (
  type: Exclude<TeamImageEffectRequestV2["type"], "team-image.build.delete-image">,
  imageBuildId: TeamImageBuildId,
): TeamImageEffectRequestV2 => ({ type, imageBuildId });

const PHASES = TeamImageBuildPhase.literals;

/** Pure: the service reads the state and draws every id, so a decision does no I/O. */
export function decideTeamImageCommand(
  state: TeamImageState,
  command: TeamImageCommand,
  now: DateTime.Utc,
): Result.Result<TeamImageDecision, TeamImageError> {
  if (command.type === "team-image.recipe.save") {
    if (command.baseRevision !== state.latestRevision) {
      return refuse(
        "recipe-changed",
        "Someone saved the recipe since you opened it. Reload to see their change.",
      );
    }
    return Result.succeed({
      events: [
        {
          type: "team-image.recipe-saved",
          revision: {
            revision: (state.latestRevision ?? 0) + 1,
            recipe: command.recipe,
            savedAt: now,
            savedBy: command.savedBy,
          },
        },
      ],
      effects: [],
    });
  }

  if (command.type === "team-image.build.request") {
    if (state.latestRevision === null || command.recipeRevision > state.latestRevision) {
      return refuse("not-found", `Recipe revision ${command.recipeRevision} does not exist.`);
    }
    if (state.liveBuild !== null) {
      return refuse(
        "build-running",
        `Build ${state.liveBuild.build.number} is still running. Cancel it or wait for it to finish.`,
      );
    }
    const record: TeamImageBuildRecord = {
      build: {
        id: command.imageBuildId,
        number: state.nextBuildNumber,
        status: "queued",
        phase: null,
        recipeRevision: command.recipeRevision,
        driverId: command.driverId,
        requestedBy: command.requestedBy,
        activateOnSuccess: command.activateOnSuccess,
        requestedAt: now,
        startedAt: null,
        finishedAt: null,
        imageDeletedAt: null,
      },
      machine: { sandboxId: command.machineSandboxId, driverRef: null, destroyedAt: null },
    };
    return Result.succeed({
      events: [updated(record, {})],
      effects: [effect("team-image.build.launch", command.imageBuildId)],
    });
  }

  const record = state.build;
  if (record === null) return refuse("not-found", "That build does not exist.");
  const { build } = record;
  const started = { startedAt: build.startedAt ?? now, phase: build.phase ?? "launch" };

  switch (command.type) {
    case "team-image.build.launched":
      if (build.status === "queued") {
        return Result.succeed({
          events: [
            updated(record, { status: "launching", ...started }, { driverRef: command.driverRef }),
          ],
          effects: [],
        });
      }
      // A fast runner can say hello before `create` returns.
      if (build.status === "running" && record.machine.driverRef === null) {
        return Result.succeed({
          events: [updated(record, {}, { driverRef: command.driverRef })],
          effects: [],
        });
      }
      return Result.succeed(NOTHING);
    case "team-image.build.attached":
      if (build.status !== "queued" && build.status !== "launching") return Result.succeed(NOTHING);
      return Result.succeed({
        events: [updated(record, { status: "running", ...started })],
        effects: [effect("team-image.build.run-program", build.id)],
      });
    case "team-image.build.phase":
      if (
        build.status !== "running" ||
        PHASES.indexOf(command.phase) <= (build.phase === null ? -1 : PHASES.indexOf(build.phase))
      ) {
        return Result.succeed(NOTHING);
      }
      return Result.succeed({ events: [updated(record, { phase: command.phase })], effects: [] });
    case "team-image.build.program-finished":
      if (build.status !== "running") return Result.succeed(NOTHING);
      return Result.succeed({
        events: [
          updated(record, { status: "capturing", phase: "capture", manifest: command.manifest }),
        ],
        effects: [effect("team-image.build.capture", build.id)],
      });
    case "team-image.build.captured":
      if (build.status !== "capturing") return Result.succeed(NOTHING);
      return Result.succeed({
        events: [
          updated(record, {
            status: "succeeded",
            imageRef: command.imageRef,
            ...(build.manifest === undefined
              ? {}
              : { manifest: { ...build.manifest, sizeBytes: command.sizeBytes } }),
            finishedAt: now,
          }),
        ],
        effects: [effect("team-image.build.destroy-machine", build.id)],
      });
    case "team-image.build.fail":
    case "team-image.build.cancel": {
      if (!isLiveTeamImageBuild(build.status)) {
        return command.type === "team-image.build.cancel"
          ? refuse("wrong-state", `Build ${build.number} already finished.`)
          : Result.succeed(NOTHING);
      }
      const ended: Partial<TeamImageBuild> =
        command.type === "team-image.build.fail"
          ? { status: "failed", failure: command.failure, finishedAt: now }
          : { status: "cancelled", finishedAt: now };
      return Result.succeed({
        events: [updated(record, ended)],
        effects: [effect("team-image.build.destroy-machine", build.id)],
        cancelUnsettledEffects: {
          effectTypes: [
            "team-image.build.launch",
            "team-image.build.run-program",
            "team-image.build.capture",
          ],
          reason: `Build ${build.number} ended.`,
        },
      });
    }
    case "team-image.build.machine-destroyed":
      if (record.machine.destroyedAt !== null) return Result.succeed(NOTHING);
      return Result.succeed({
        events: [updated(record, {}, { destroyedAt: now })],
        effects: [],
      });
  }
}
