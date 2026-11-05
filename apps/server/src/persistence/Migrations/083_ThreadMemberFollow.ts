import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Null means not following. The holder follows implicitly and has no member row.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_member_state)
  `;
  if (!columns.some((column) => column.name === "followed_at")) {
    yield* sql`ALTER TABLE projection_thread_member_state ADD COLUMN followed_at TEXT`;
  }
});
