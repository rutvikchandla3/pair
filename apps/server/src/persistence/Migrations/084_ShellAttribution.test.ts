import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0084 from "./084_ShellAttribution.ts";

const layerMemory = NodeSqliteClient.layer({ filename: ":memory:" });

describe("084_ShellAttribution", () => {
  it.effect("backfills run and message authors on shared threads only, and reruns cleanly", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 83 });
      const at = "2026-10-01T00:00:00.000Z";
      for (const [threadId, authors] of [
        ["shared", ["alice", "bob"]],
        ["solo", ["alice"]],
      ] as const) {
        const author = authors.at(-1)!;
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json
          ) VALUES (
            ${threadId}, 'project', 'Thread', 'codex', 'full-access', 'default', ${at}, ${at},
            ${JSON.stringify({ humanAuthorIds: authors })}
          )
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_messages (
            message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json
          ) VALUES (
            ${`${threadId}:message`}, ${threadId}, ${`${threadId}:run`}, 'user', 0, ${at}, ${at},
            ${JSON.stringify({ authorId: author, createdBy: "user" })}
          )
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, status, requested_at, payload_json
          ) VALUES (
            ${`${threadId}:run`}, ${threadId}, 1, 'codex', 'completed', ${at},
            ${JSON.stringify({ userMessageId: `${threadId}:message` })}
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 84 });
      yield* Migration0084;

      assert.deepStrictEqual(
        yield* sql`
          SELECT t.thread_id, t.latest_user_message_author_id, r.author_id
          FROM orchestration_v2_projection_threads t
          JOIN orchestration_v2_projection_runs r ON r.thread_id = t.thread_id
          ORDER BY t.thread_id
        `,
        [
          { thread_id: "shared", latest_user_message_author_id: "bob", author_id: "bob" },
          { thread_id: "solo", latest_user_message_author_id: null, author_id: null },
        ],
      );
    }).pipe(Effect.provide(layerMemory)),
  );
});
