import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Which secret holds a bound member's GitHub credential: 'app' (device flow) or 'token' (pasted).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(members)`;
  if (columns.some((column) => column.name === "github_source")) return;
  yield* sql`ALTER TABLE members ADD COLUMN github_source TEXT`;
  yield* sql`UPDATE members SET github_source = 'app' WHERE github_user_id IS NOT NULL`;
});
