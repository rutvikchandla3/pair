import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The token itself lives in the secret store, never here.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(members)`;
  const has = (name: string) => columns.some((column) => column.name === name);
  if (!has("github_user_id")) yield* sql`ALTER TABLE members ADD COLUMN github_user_id INTEGER`;
  if (!has("github_login")) yield* sql`ALTER TABLE members ADD COLUMN github_login TEXT`;
  if (!has("github_connected_at")) {
    yield* sql`ALTER TABLE members ADD COLUMN github_connected_at TEXT`;
  }
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS members_github_user_id ON members(github_user_id)
    WHERE removed_at IS NULL AND github_user_id IS NOT NULL
  `;
});
