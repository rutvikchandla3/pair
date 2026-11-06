import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A device's push token belongs to the auth session that registered it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS member_push_devices (
      device_id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      token TEXT NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS member_push_devices_member ON member_push_devices(member_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS member_push_devices_session ON member_push_devices(session_id)
  `;
});
