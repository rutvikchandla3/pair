import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Removed members keep their binding, so a Builder user an admin removed stays out.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(members)`;
  if (!columns.some((column) => column.name === "pair_builder_user_id")) {
    yield* sql`ALTER TABLE members ADD COLUMN pair_builder_user_id TEXT`;
  }
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS members_pair_builder_user_id ON members(pair_builder_user_id)
    WHERE pair_builder_user_id IS NOT NULL
  `;
});
