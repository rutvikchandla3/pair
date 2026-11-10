import type { MemberId } from "@t3tools/contracts";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * `threadAllows` for a paged read, over `orchestration_v2_projection_threads` aliased `alias`, for
 * an active member on a cloud-only server. Callers skip it elsewhere. Keep it in step with `ThreadAccess.ts`.
 */
export const threadAllowsSql = (
  sql: SqlClient.SqlClient,
  alias: "t" | "threads",
  memberId: MemberId | string,
  serverOwnerId: MemberId | string | null,
) => {
  const t = sql.literal(alias);
  return sql`(CASE
  WHEN json_extract(${t}.payload_json, '$.sandboxId') IS NULL
    THEN COALESCE(json_extract(${t}.payload_json, '$.ownerId') = ${memberId}, 1)
  ELSE COALESCE(
    (
      SELECT access_sandbox.audience IS NULL
        OR access_sandbox.audience = 'team'
        OR COALESCE(access_sandbox.owner_member_id, ${serverOwnerId}) = ${memberId}
        OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_sandbox_members access_member
          WHERE access_member.sandbox_id = access_sandbox.sandbox_id
            AND access_member.member_id = ${memberId}
        )
      FROM orchestration_v2_projection_sandboxes access_sandbox
      WHERE access_sandbox.sandbox_id = json_extract(${t}.payload_json, '$.sandboxId')
    ),
    COALESCE(json_extract(${t}.payload_json, '$.ownerId'), ${serverOwnerId}) = ${memberId}
  )
END)`;
};
