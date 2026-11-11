import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A workspace's repositories. Null means the project is a single repository.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN roots_json TEXT`;
});
