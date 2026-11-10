import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Who can open each run's machine. NULL reads as `team`, so a task from before keeps its runs visible.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (!columns.some((column) => column.name === "access_json")) {
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN access_json TEXT`;
  }
});
