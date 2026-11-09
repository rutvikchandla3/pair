import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Whether the peer reported `cloudLaunch` when last reached. Such a link
  // needs no Linked environments beta.
  yield* sql`
    ALTER TABLE peer_environment_links ADD COLUMN cloud_launch INTEGER NOT NULL DEFAULT 0
  `;
});
