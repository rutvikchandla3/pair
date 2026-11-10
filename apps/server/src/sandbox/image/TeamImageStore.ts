import {
  ComputeDriverId,
  PositiveInt,
  SandboxId,
  TeamImageBuild,
  TeamImageBuildId,
  TeamImageBuildStatus,
  TeamImageRecipe,
  type TeamImageRecipeRevision,
  TeamImageRequester,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";
import type { TeamImageBuildRecord, TeamImageEvent } from "./TeamImageCommands.ts";

export type TeamImageStoreError = PersistenceSqlError | PersistenceDecodeError;

/** A build whose machine is not destroyed yet: the reconciler's list of backends that are no session's. */
export interface TeamImageBuildMachineRow {
  readonly imageBuildId: TeamImageBuildId;
  readonly status: TeamImageBuildStatus;
  readonly sandboxId: SandboxId;
  readonly driverRef: string | null;
  readonly driverId: ComputeDriverId;
}

/** The three 095 tables. Writes run inside the caller's transaction (`apply`). */
export class TeamImageStore extends Context.Service<
  TeamImageStore,
  {
    readonly state: Effect.Effect<
      { readonly activeBuildId: TeamImageBuildId | null; readonly nextBuildNumber: number },
      TeamImageStoreError
    >;
    readonly latestRevision: Effect.Effect<TeamImageRecipeRevision | null, TeamImageStoreError>;
    readonly readRevision: (
      revision: number,
    ) => Effect.Effect<Option.Option<TeamImageRecipeRevision>, TeamImageStoreError>;
    readonly build: (
      imageBuildId: TeamImageBuildId,
    ) => Effect.Effect<Option.Option<TeamImageBuildRecord>, TeamImageStoreError>;
    readonly buildByNumber: (
      number: number,
    ) => Effect.Effect<Option.Option<TeamImageBuild>, TeamImageStoreError>;
    /** Newest first. */
    readonly recentBuilds: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<TeamImageBuild>, TeamImageStoreError>;
    readonly liveBuild: Effect.Effect<TeamImageBuildRecord | null, TeamImageStoreError>;
    readonly machines: Effect.Effect<ReadonlyArray<TeamImageBuildMachineRow>, TeamImageStoreError>;
    /** Finished builds whose log is not deleted yet: every build garbage collection may touch. */
    readonly collectable: Effect.Effect<ReadonlyArray<TeamImageBuild>, TeamImageStoreError>;
    readonly apply: (
      events: ReadonlyArray<TeamImageEvent>,
    ) => Effect.Effect<void, TeamImageStoreError>;
  }
>()("t3/sandbox/image/TeamImageStore") {}

const toStoreError =
  (operation: string) =>
  (cause: unknown): TeamImageStoreError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : new PersistenceSqlError({ operation, cause });

const RevisionRow = Schema.Struct({
  revision: PositiveInt,
  recipe: Schema.fromJsonString(Schema.toCodecJson(TeamImageRecipe)),
  savedAt: Schema.DateTimeUtcFromString,
  savedBy: Schema.fromJsonString(Schema.toCodecJson(TeamImageRequester)),
});

const BuildJson = Schema.fromJsonString(Schema.toCodecJson(TeamImageBuild));

const BuildRow = Schema.Struct({
  build: BuildJson,
  sandboxId: SandboxId,
  driverRef: Schema.NullOr(Schema.String),
  destroyedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const toRecord = ({ build, ...machine }: typeof BuildRow.Type): TeamImageBuildRecord => ({
  build,
  machine,
});

const LIVE_STATUSES = ["queued", "launching", "running", "capturing"] as const;
const FINISHED_STATUSES = ["succeeded", "failed", "cancelled"] as const;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readState = SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({
      activeBuildId: Schema.NullOr(TeamImageBuildId),
      nextBuildNumber: PositiveInt,
    }),
    execute: () => sql`
      SELECT active_build_id AS "activeBuildId", next_build_number AS "nextBuildNumber"
      FROM team_image_state
      WHERE id = 1
    `,
  });

  const findLatestRevision = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: RevisionRow,
    execute: () => sql`
      SELECT revision, recipe_json AS "recipe", saved_at AS "savedAt", saved_by_json AS "savedBy"
      FROM team_image_recipe_revisions
      ORDER BY revision DESC
      LIMIT 1
    `,
  });

  const findRevision = SqlSchema.findOneOption({
    Request: Schema.Number,
    Result: RevisionRow,
    execute: (revision) => sql`
      SELECT revision, recipe_json AS "recipe", saved_at AS "savedAt", saved_by_json AS "savedBy"
      FROM team_image_recipe_revisions
      WHERE revision = ${revision}
    `,
  });

  const findBuild = SqlSchema.findOneOption({
    Request: TeamImageBuildId,
    Result: BuildRow,
    execute: (imageBuildId) => sql`
      SELECT
        payload_json AS "build", machine_sandbox_id AS "sandboxId",
        machine_driver_ref AS "driverRef", machine_destroyed_at AS "destroyedAt"
      FROM team_image_builds
      WHERE image_build_id = ${imageBuildId}
    `,
  });

  const findBuildByNumber = SqlSchema.findOneOption({
    Request: Schema.Number,
    Result: Schema.Struct({ build: BuildJson }),
    execute: (number) => sql`
      SELECT payload_json AS "build" FROM team_image_builds WHERE number = ${number}
    `,
  });

  const findRecentBuilds = SqlSchema.findAll({
    Request: Schema.Number,
    Result: Schema.Struct({ build: BuildJson }),
    execute: (limit) => sql`
      SELECT payload_json AS "build" FROM team_image_builds ORDER BY number DESC LIMIT ${limit}
    `,
  });

  const findLiveBuild = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: BuildRow,
    execute: () => sql`
      SELECT
        payload_json AS "build", machine_sandbox_id AS "sandboxId",
        machine_driver_ref AS "driverRef", machine_destroyed_at AS "destroyedAt"
      FROM team_image_builds
      WHERE ${sql.in("status", LIVE_STATUSES)}
      ORDER BY number DESC
      LIMIT 1
    `,
  });

  const findMachines = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BuildRow,
    execute: () => sql`
      SELECT
        payload_json AS "build", machine_sandbox_id AS "sandboxId",
        machine_driver_ref AS "driverRef", machine_destroyed_at AS "destroyedAt"
      FROM team_image_builds
      WHERE machine_destroyed_at IS NULL
      ORDER BY number
    `,
  });

  const findCollectable = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ build: BuildJson }),
    execute: () => sql`
      SELECT payload_json AS "build" FROM team_image_builds
      WHERE log_deleted_at IS NULL AND ${sql.in("status", FINISHED_STATUSES)}
      ORDER BY number DESC
    `,
  });

  const insertRevision = SqlSchema.void({
    Request: RevisionRow,
    execute: ({ revision, recipe, savedAt, savedBy }) => sql`
      INSERT INTO team_image_recipe_revisions (revision, recipe_json, saved_at, saved_by_json)
      VALUES (${revision}, ${recipe}, ${savedAt}, ${savedBy})
    `,
  });

  const upsertBuild = SqlSchema.void({
    Request: Schema.Struct({
      ...BuildRow.fields,
      imageBuildId: TeamImageBuildId,
      number: PositiveInt,
      status: TeamImageBuildStatus,
    }),
    execute: (row) => sql`
      INSERT INTO team_image_builds (
        image_build_id, number, status, payload_json,
        machine_sandbox_id, machine_driver_ref, machine_destroyed_at
      )
      VALUES (
        ${row.imageBuildId}, ${row.number}, ${row.status}, ${row.build},
        ${row.sandboxId}, ${row.driverRef}, ${row.destroyedAt}
      )
      ON CONFLICT (image_build_id) DO UPDATE SET
        status = excluded.status,
        payload_json = excluded.payload_json,
        machine_sandbox_id = excluded.machine_sandbox_id,
        machine_driver_ref = excluded.machine_driver_ref,
        machine_destroyed_at = excluded.machine_destroyed_at
    `,
  });

  const advanceBuildNumber = (number: number) => sql`
    UPDATE team_image_state
    SET next_build_number = MAX(next_build_number, ${number + 1})
    WHERE id = 1
  `;

  const setActiveBuild = SqlSchema.void({
    Request: TeamImageBuildId,
    execute: (imageBuildId) => sql`
      UPDATE team_image_state SET active_build_id = ${imageBuildId} WHERE id = 1
    `,
  });

  const markLogDeleted = SqlSchema.void({
    Request: Schema.Struct({ imageBuildId: TeamImageBuildId, at: Schema.DateTimeUtcFromString }),
    execute: ({ imageBuildId, at }) => sql`
      UPDATE team_image_builds
      SET log_deleted_at = COALESCE(log_deleted_at, ${at})
      WHERE image_build_id = ${imageBuildId}
    `,
  });

  const applyEvent = (event: TeamImageEvent) => {
    switch (event.type) {
      case "team-image.recipe-saved":
        return insertRevision(event.revision);
      case "team-image.build-updated":
        return upsertBuild({
          ...event.machine,
          build: event.build,
          imageBuildId: event.build.id,
          number: event.build.number,
          status: event.build.status,
        }).pipe(Effect.andThen(advanceBuildNumber(event.build.number)));
      case "team-image.active-changed":
        return setActiveBuild(event.activeBuildId);
      case "team-image.log-deleted":
        return markLogDeleted(event);
    }
  };

  return TeamImageStore.of({
    state: readState(undefined).pipe(
      Effect.mapError(toStoreError("TeamImageStore.state")),
      Effect.withSpan("TeamImageStore.state"),
    ),
    latestRevision: findLatestRevision(undefined).pipe(
      Effect.map(Option.getOrNull),
      Effect.mapError(toStoreError("TeamImageStore.latestRevision")),
      Effect.withSpan("TeamImageStore.latestRevision"),
    ),
    readRevision: Effect.fn("TeamImageStore.readRevision")((revision: number) =>
      findRevision(revision).pipe(Effect.mapError(toStoreError("TeamImageStore.readRevision"))),
    ),
    build: Effect.fn("TeamImageStore.build")((imageBuildId: TeamImageBuildId) =>
      findBuild(imageBuildId).pipe(
        Effect.map(Option.map(toRecord)),
        Effect.mapError(toStoreError("TeamImageStore.build")),
      ),
    ),
    buildByNumber: Effect.fn("TeamImageStore.buildByNumber")((number: number) =>
      findBuildByNumber(number).pipe(
        Effect.map(Option.map((row) => row.build)),
        Effect.mapError(toStoreError("TeamImageStore.buildByNumber")),
      ),
    ),
    recentBuilds: Effect.fn("TeamImageStore.recentBuilds")((limit: number) =>
      findRecentBuilds(limit).pipe(
        Effect.map((rows) => rows.map((row) => row.build)),
        Effect.mapError(toStoreError("TeamImageStore.recentBuilds")),
      ),
    ),
    liveBuild: findLiveBuild(undefined).pipe(
      Effect.map((row) => (Option.isNone(row) ? null : toRecord(row.value))),
      Effect.mapError(toStoreError("TeamImageStore.liveBuild")),
      Effect.withSpan("TeamImageStore.liveBuild"),
    ),
    machines: findMachines(undefined).pipe(
      Effect.map((rows) =>
        rows.map(({ build, sandboxId, driverRef }): TeamImageBuildMachineRow => ({
          imageBuildId: build.id,
          status: build.status,
          sandboxId,
          driverRef,
          driverId: build.driverId,
        })),
      ),
      Effect.mapError(toStoreError("TeamImageStore.machines")),
      Effect.withSpan("TeamImageStore.machines"),
    ),
    collectable: findCollectable(undefined).pipe(
      Effect.map((rows) => rows.map((row) => row.build)),
      Effect.mapError(toStoreError("TeamImageStore.collectable")),
      Effect.withSpan("TeamImageStore.collectable"),
    ),
    apply: Effect.fn("TeamImageStore.apply")((events: ReadonlyArray<TeamImageEvent>) =>
      Effect.forEach(events, applyEvent, { discard: true }).pipe(
        Effect.mapError(toStoreError("TeamImageStore.apply")),
      ),
    ),
  });
});

export const layer = Layer.effect(TeamImageStore, make);
