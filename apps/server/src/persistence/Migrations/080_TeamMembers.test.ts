import { assert, describe, it } from "@effect/vitest";
import { MemberId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import Migration0080 from "./080_TeamMembers.ts";

const layerMemory = NodeSqliteClient.layer({ filename: ":memory:" });
const isMemberId = Schema.is(MemberId);

describe("080_TeamMembers", () => {
  it.effect("creates a single owner and backfills sessions and links", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      yield* sql`
        INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES (
          'session-1', 'desktop-bootstrap', '["orchestration:read"]', 'bearer-access-token',
          '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO auth_pairing_links (
          id, credential, method, scopes, subject, created_at, expires_at
        )
        VALUES (
          'link-1', 'CREDENTIAL', 'one-time-token', '["orchestration:read"]', 'one-time-token',
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:05:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 80 });

      const members = yield* sql<{
        readonly id: string;
        readonly name: string;
        readonly role: string;
        readonly isOwner: number;
        readonly removedAt: string | null;
      }>`
        SELECT id, name, role, is_owner AS "isOwner", removed_at AS "removedAt" FROM members
      `;
      assert.strictEqual(members.length, 1);
      const owner = members[0]!;
      assert.deepInclude(owner, { name: "Admin", role: "admin", isOwner: 1, removedAt: null });
      assert.isTrue(isMemberId(owner.id));
      assert.deepStrictEqual(yield* sql`SELECT member_id FROM auth_sessions`, [
        { member_id: owner.id },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT member_id FROM auth_pairing_links`, [
        { member_id: owner.id },
      ]);
      const secondOwner = yield* Effect.exit(sql`
        INSERT INTO members (id, name, role, is_owner, created_at)
        VALUES ('other', 'Other', 'admin', 1, '2026-09-01T00:00:00.000Z')
      `);
      assert.isTrue(secondOwner._tag === "Failure");
    }).pipe(Effect.provide(layerMemory)),
  );

  it.effect("is idempotent when rerun", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      const [owner] = yield* sql<{ readonly id: string }>`SELECT id FROM members`;
      // An older binary writes sessions without a member after a rollback.
      yield* sql`
        INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES (
          'session-2', 'one-time-token', '["orchestration:read"]', 'bearer-access-token',
          '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
        )
      `;

      yield* Migration0080;

      assert.deepStrictEqual(yield* sql`SELECT id FROM members`, [{ id: owner!.id }]);
      assert.deepStrictEqual(
        yield* sql`SELECT member_id FROM auth_sessions WHERE session_id = 'session-2'`,
        [{ member_id: owner!.id }],
      );
    }).pipe(Effect.provide(layerMemory)),
  );
});
