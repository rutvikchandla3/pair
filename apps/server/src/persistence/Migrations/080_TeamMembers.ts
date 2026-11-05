import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      git_name TEXT,
      git_email TEXT,
      is_owner INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      removed_at TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS members_single_owner ON members(is_owner) WHERE is_owner = 1
  `;

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;
  if (!sessionColumns.some((column) => column.name === "member_id")) {
    yield* sql`ALTER TABLE auth_sessions ADD COLUMN member_id TEXT`;
  }
  const pairingLinkColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_pairing_links)
  `;
  if (!pairingLinkColumns.some((column) => column.name === "member_id")) {
    yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN member_id TEXT`;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS auth_sessions_member_active ON auth_sessions(member_id, revoked_at)
  `;

  // Startup renames this placeholder from git user.name or the OS user.
  yield* sql`
    INSERT INTO members (id, name, role, is_owner, created_at)
    SELECT lower(hex(randomblob(16))), 'Admin', 'admin', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE NOT EXISTS (SELECT 1 FROM members WHERE is_owner = 1)
  `;
  yield* sql`
    UPDATE auth_sessions SET member_id = (SELECT id FROM members WHERE is_owner = 1)
    WHERE member_id IS NULL
  `;
  yield* sql`
    UPDATE auth_pairing_links SET member_id = (SELECT id FROM members WHERE is_owner = 1)
    WHERE member_id IS NULL
  `;
});
