import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0087 from "./087_MemberPushDevices.ts";

const layerMemory = NodeSqliteClient.layer({ filename: ":memory:" });

describe("087_MemberPushDevices", () => {
  it.effect("keys a device by id, refuses an unknown platform, and reruns cleanly", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 87 });
      yield* Migration0087;

      yield* sql`
        INSERT INTO member_push_devices (device_id, member_id, session_id, token, platform, updated_at)
        VALUES ('device-1', 'member-1', 'session-1', 'ExponentPushToken[a]', 'ios', '2026-11-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO member_push_devices (device_id, member_id, session_id, token, platform, updated_at)
        VALUES ('device-1', 'member-2', 'session-2', 'ExponentPushToken[b]', 'android', '2026-11-01T00:00:00.000Z')
      `.pipe(Effect.flip);
      yield* sql`
        INSERT INTO member_push_devices (device_id, member_id, session_id, token, platform, updated_at)
        VALUES ('device-2', 'member-1', 'session-1', 'ExponentPushToken[c]', 'web', '2026-11-01T00:00:00.000Z')
      `.pipe(Effect.flip);

      assert.deepStrictEqual(yield* sql`SELECT device_id, session_id FROM member_push_devices`, [
        { device_id: "device-1", session_id: "session-1" },
      ]);
    }).pipe(Effect.provide(layerMemory)),
  );
});
