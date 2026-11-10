import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layerMemory = NodeSqliteClient.layer({ filename: ":memory:" });

describe("096_TeamImageProposals", () => {
  it.effect("refuses a second open proposal for a thread but not a closed one", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 96 });
      const insert = (id: string, threadId: string, status: string) => sql`
        INSERT INTO team_image_proposals (proposal_id, thread_id, status, payload_json, created_at)
        VALUES (${id}, ${threadId}, ${status}, '{}', '2026-01-01T00:00:00.000Z')
      `;
      yield* insert("tip_1", "thread-a", "dismissed");
      yield* insert("tip_2", "thread-a", "open");
      yield* insert("tip_3", "thread-b", "open");
      yield* insert("tip_4", "thread-a", "open").pipe(Effect.flip);
      yield* sql`UPDATE team_image_proposals SET status = 'accepted' WHERE proposal_id = 'tip_2'`;
      yield* insert("tip_5", "thread-a", "open");

      assert.deepStrictEqual(
        (yield* sql`SELECT proposal_id FROM team_image_proposals ORDER BY proposal_id`).map(
          (row) => row.proposal_id,
        ),
        ["tip_1", "tip_2", "tip_3", "tip_5"],
      );
    }).pipe(Effect.provide(layerMemory)),
  );
});
