import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A cloud task's run may discard its machine on settle; the last run's thread carries its wait.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (!columns.some((column) => column.name === "discard_on_settle")) {
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN discard_on_settle INTEGER NOT NULL DEFAULT 0`;
  }
  if (!columns.some((column) => column.name === "last_run_thread_id")) {
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_run_thread_id TEXT`;
  }
});
