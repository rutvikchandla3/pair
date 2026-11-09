import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0095 from "./095_TeamImages.ts";

const layerMemory = NodeSqliteClient.layer({ filename: ":memory:" });

describe("095_TeamImages", () => {
  it.effect("keeps one state row when it runs twice", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 95 });
      yield* sql`UPDATE team_image_state SET next_build_number = 4`;
      yield* Migration0095;

      assert.deepStrictEqual(yield* sql`SELECT * FROM team_image_state`, [
        { id: 1, active_build_id: null, next_build_number: 4 },
      ]);
      yield* sql`INSERT INTO team_image_state (id, next_build_number) VALUES (2, 1)`.pipe(
        Effect.flip,
      );
    }).pipe(Effect.provide(layerMemory)),
  );
});
