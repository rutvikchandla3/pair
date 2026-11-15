import {
  BranchLineage,
  BranchLineageStep,
  MemberId,
  Offer,
  type OfferId,
  type OfferState,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShellBranchLink,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const LineagePayload = Schema.fromJsonString(BranchLineage);
const encodeLineage = Schema.encodeEffect(LineagePayload);
const decodeLineage = Schema.decodeUnknownEffect(LineagePayload);
const OfferPayload = Schema.fromJsonString(Offer);
const encodeOffer = Schema.encodeEffect(OfferPayload);
const decodeOffer = Schema.decodeUnknownEffect(OfferPayload);
const StepPayload = Schema.fromJsonString(BranchLineageStep);
const encodeStep = Schema.encodeEffect(StepPayload);
const decodeStep = Schema.decodeUnknownEffect(StepPayload);
const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const bumpRevisions = Effect.fnUntraced(function* (threadIds: ReadonlyArray<ThreadId>) {
  const sql = yield* SqlClient.SqlClient;
  for (const threadId of new Set(threadIds)) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_lineage_threads (thread_id, revision)
      VALUES (${threadId}, 1)
      ON CONFLICT(thread_id) DO UPDATE SET revision = revision + 1
    `;
  }
});

/** Runs once per event; the projection apply that calls it owns the span. */
export const applyBranchLineageUpdated = Effect.fnUntraced(function* (
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "thread.branch-lineage.updated" }>,
) {
  const sql = yield* SqlClient.SqlClient;
  const lineage = event.payload;
  yield* sql`
    INSERT INTO orchestration_v2_projection_branch_lineage (
      branch_thread_id, source_thread_id, payload_json, updated_at
    )
    VALUES (
      ${lineage.branchThreadId}, ${lineage.sourceThreadId}, ${yield* encodeLineage(lineage)},
      ${DateTime.formatIso(event.occurredAt)}
    )
    ON CONFLICT(branch_thread_id) DO UPDATE SET
      source_thread_id = excluded.source_thread_id,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `;
  yield* bumpRevisions([lineage.branchThreadId, lineage.sourceThreadId]);
});

export const applyOfferUpdated = Effect.fnUntraced(function* (
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "thread.offer.updated" }>,
) {
  const sql = yield* SqlClient.SqlClient;
  const offer = event.payload;
  yield* sql`
    INSERT INTO orchestration_v2_projection_offers (
      offer_id, source_thread_id, branch_thread_id, state, payload_json, created_at, updated_at
    )
    VALUES (
      ${offer.id}, ${offer.sourceThreadId}, ${offer.branchThreadId}, ${offer.state},
      ${yield* encodeOffer(offer)}, ${offer.createdAt}, ${offer.updatedAt}
    )
    ON CONFLICT(offer_id) DO UPDATE SET
      state = excluded.state,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `;
  yield* bumpRevisions([offer.sourceThreadId, offer.branchThreadId]);
});

export const applyLineageStepUpdated = Effect.fnUntraced(function* (
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "thread.lineage-step.updated" }>,
) {
  const sql = yield* SqlClient.SqlClient;
  const step = event.payload.step;
  const stepJson = step === null ? null : yield* encodeStep(step);
  yield* sql`
    INSERT INTO orchestration_v2_projection_lineage_threads (thread_id, revision, step_json)
    VALUES (${event.threadId}, 0, ${stepJson})
    ON CONFLICT(thread_id) DO UPDATE SET step_json = excluded.step_json
  `;
});

export const getBranchLineage = Effect.fn("BranchLineageProjection.getBranchLineage")(function* (
  branchThreadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_branch_lineage
    WHERE branch_thread_id = ${branchThreadId}
  `;
  const row = rows[0];
  return row === undefined ? null : yield* decodeLineage(row.payload_json);
});

/** Oldest first. */
export const listBranchesOf = Effect.fn("BranchLineageProjection.listBranchesOf")(function* (
  sourceThreadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_branch_lineage
    WHERE source_thread_id = ${sourceThreadId}
    ORDER BY json_extract(payload_json, '$.createdAt') ASC, branch_thread_id ASC
  `;
  return yield* Effect.forEach(rows, (row) => decodeLineage(row.payload_json));
});

export const getOffer = Effect.fn("BranchLineageProjection.getOffer")(function* (offerId: OfferId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_offers WHERE offer_id = ${offerId}
  `;
  const row = rows[0];
  return row === undefined ? null : yield* decodeOffer(row.payload_json);
});

/** Open offers first, then the most recent of the rest, `limit` in all. */
export const listOffersForSource = Effect.fn("BranchLineageProjection.listOffersForSource")(
  function* (sourceThreadId: ThreadId, limit: number) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_offers
      WHERE source_thread_id = ${sourceThreadId}
      ORDER BY CASE WHEN state = 'open' THEN 0 ELSE 1 END, created_at DESC, offer_id DESC
      LIMIT ${limit}
    `;
    return yield* Effect.forEach(rows, (row) => decodeOffer(row.payload_json));
  },
);

/** Most recent first. */
export const listOffersForBranch = Effect.fn("BranchLineageProjection.listOffersForBranch")(
  function* (branchThreadId: ThreadId, limit: number) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_offers
      WHERE branch_thread_id = ${branchThreadId}
      ORDER BY created_at DESC, offer_id DESC
      LIMIT ${limit}
    `;
    return yield* Effect.forEach(rows, (row) => decodeOffer(row.payload_json));
  },
);

/** Open offers to live sources this member holds; a source without an owner is the server owner's. */
export const listOpenOffersForHolder = Effect.fn("BranchLineageProjection.listOpenOffersForHolder")(
  function* (memberId: MemberId, serverOwnerId: MemberId | null) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT offer.payload_json FROM orchestration_v2_projection_offers AS offer
      JOIN orchestration_v2_projection_threads AS source
        ON source.thread_id = offer.source_thread_id
      WHERE offer.state = 'open' AND source.deleted_at IS NULL
        AND COALESCE(json_extract(source.payload_json, '$.ownerId'), ${serverOwnerId}) = ${memberId}
      ORDER BY offer.created_at DESC, offer.offer_id DESC
    `;
    return yield* Effect.forEach(rows, (row) => decodeOffer(row.payload_json));
  },
);

/** The thread's armed or running lineage step. */
export const getLineageStep = Effect.fn("BranchLineageProjection.getLineageStep")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly step_json: string | null }>`
    SELECT step_json FROM orchestration_v2_projection_lineage_threads WHERE thread_id = ${threadId}
  `;
  const json = rows[0]?.step_json ?? null;
  return json === null ? null : yield* decodeStep(json);
});

/** Threads with an armed step, for recovery after a restart. */
export const listArmedStepThreadIds = Effect.fn("BranchLineageProjection.listArmedStepThreadIds")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_lineage_threads
      WHERE step_json IS NOT NULL AND json_extract(step_json, '$.state') = 'armed'
    `;
    return rows.map((row) => ThreadId.make(row.thread_id));
  },
);

interface BranchLinkSource {
  readonly title: string;
  readonly ownerId: MemberId | null;
  readonly archived: boolean;
  readonly deleted: boolean;
  readonly settled: boolean;
}

/** One shared rule, so the SQL and in-memory shell builders agree. */
function branchLinkFromRecords(input: {
  readonly revision: number;
  readonly lineage: BranchLineage | null;
  /** Null when the source's row is gone. */
  readonly source: BranchLinkSource | null;
  readonly latestOfferState: OfferState | null;
  readonly openOffers: number;
}): OrchestrationV2ThreadShellBranchLink {
  const { lineage, source } = input;
  return {
    revision: input.revision,
    // Start from main detached it: a thread of its own, its record kept for history.
    source:
      lineage === null || lineage.detachedAt !== undefined
        ? null
        : {
            threadId: lineage.sourceThreadId,
            ownerId: source?.ownerId ?? lineage.sourceOwnerId,
            title: source?.title ?? null,
            state:
              source === null || source.deleted
                ? "deleted"
                : source.archived
                  ? "archived"
                  : lineage.sourceState === "shipped"
                    ? "shipped"
                    : source.settled
                      ? "settled"
                      : "open",
            toOffer: lineage.toOffer.count,
            behind: lineage.behind,
            updateInProgress:
              lineage.update === null
                ? null
                : {
                    conflictedPaths: lineage.update.conflictedPaths,
                    resolver: lineage.update.resolver,
                  },
            undoableUpdate: lineage.undoableUpdate !== null,
            offerState: input.latestOfferState,
            allApplied: lineage.toOffer.count === 0 && input.latestOfferState === "applied",
            shippedLabel: lineage.shipped?.label ?? null,
            unshipped: lineage.unshipped,
          },
    openOffers: input.openOffers,
  };
}

/**
 * The shell's `branchLink` for each thread that is a branch or has branches. One indexed read when
 * no listed thread has a lineage, which is every thread on most servers.
 */
export const readBranchLinks = Effect.fn("BranchLineageProjection.readBranchLinks")(function* (
  threadIds: ReadonlyArray<ThreadId>,
) {
  const links = new Map<ThreadId, OrchestrationV2ThreadShellBranchLink>();
  if (threadIds.length === 0) return links;
  const sql = yield* SqlClient.SqlClient;
  const ids = yield* encodeIds(threadIds);
  const lineageRows = yield* sql<{
    readonly branch_thread_id: string;
    readonly source_thread_id: string;
    readonly payload_json: string;
    readonly source_title: string | null;
    readonly source_owner_id: string | null;
    readonly source_archived: number | null;
    readonly source_deleted: number | null;
    readonly source_settled: number | null;
  }>`
    SELECT
      lineage.branch_thread_id, lineage.source_thread_id, lineage.payload_json,
      source.title AS source_title,
      json_extract(source.payload_json, '$.ownerId') AS source_owner_id,
      source.archived_at IS NOT NULL AS source_archived,
      source.deleted_at IS NOT NULL AS source_deleted,
      (json_extract(source.payload_json, '$.settledAt') IS NOT NULL
        OR json_extract(source.payload_json, '$.settledOverride') IS 'settled') AS source_settled
    FROM orchestration_v2_projection_branch_lineage AS lineage
    LEFT JOIN orchestration_v2_projection_threads AS source
      ON source.thread_id = lineage.source_thread_id
    WHERE lineage.branch_thread_id IN (SELECT value FROM json_each(${ids}))
      OR lineage.source_thread_id IN (SELECT value FROM json_each(${ids}))
  `;
  if (lineageRows.length === 0) return links;
  const wanted = new Set<string>(threadIds);
  const branchIds = lineageRows.flatMap((row) =>
    wanted.has(row.branch_thread_id) ? [row.branch_thread_id] : [],
  );
  const sourceIds = [
    ...new Set(
      lineageRows.flatMap((row) =>
        wanted.has(row.source_thread_id) ? [row.source_thread_id] : [],
      ),
    ),
  ];
  const linkIds = [...new Set([...branchIds, ...sourceIds])];
  const [revisionRows, latestOfferRows, openOfferRows] = yield* Effect.all([
    sql<{ readonly thread_id: string; readonly revision: number }>`
      SELECT thread_id, revision FROM orchestration_v2_projection_lineage_threads
      WHERE thread_id IN (SELECT value FROM json_each(${yield* encodeIds(linkIds)}))
    `,
    branchIds.length === 0
      ? Effect.succeed([])
      : sql<{ readonly branch_thread_id: string; readonly state: OfferState }>`
          SELECT offer.branch_thread_id, offer.state
          FROM orchestration_v2_projection_offers AS offer
          WHERE offer.branch_thread_id IN (SELECT value FROM json_each(${yield* encodeIds(branchIds)}))
            AND offer.offer_id = (
              SELECT latest.offer_id FROM orchestration_v2_projection_offers AS latest
              WHERE latest.branch_thread_id = offer.branch_thread_id
              ORDER BY latest.created_at DESC, latest.offer_id DESC
              LIMIT 1
            )
        `,
    sourceIds.length === 0
      ? Effect.succeed([])
      : sql<{ readonly source_thread_id: string; readonly open: number }>`
          SELECT source_thread_id, COUNT(*) AS open
          FROM orchestration_v2_projection_offers
          WHERE state = 'open'
            AND source_thread_id IN (SELECT value FROM json_each(${yield* encodeIds(sourceIds)}))
          GROUP BY source_thread_id
        `,
  ]);
  const revisions = new Map(revisionRows.map((row) => [row.thread_id, row.revision]));
  const latestOffer = new Map(latestOfferRows.map((row) => [row.branch_thread_id, row.state]));
  const openOffers = new Map(openOfferRows.map((row) => [row.source_thread_id, row.open]));
  for (const row of lineageRows) {
    if (!wanted.has(row.branch_thread_id)) continue;
    const threadId = ThreadId.make(row.branch_thread_id);
    links.set(
      threadId,
      branchLinkFromRecords({
        revision: revisions.get(threadId) ?? 0,
        lineage: yield* decodeLineage(row.payload_json),
        source:
          row.source_title === null
            ? null
            : {
                title: row.source_title,
                ownerId: row.source_owner_id === null ? null : MemberId.make(row.source_owner_id),
                archived: row.source_archived === 1,
                deleted: row.source_deleted === 1,
                settled: row.source_settled === 1,
              },
        latestOfferState: latestOffer.get(threadId) ?? null,
        openOffers: openOffers.get(threadId) ?? 0,
      }),
    );
  }
  for (const sourceId of sourceIds) {
    const threadId = ThreadId.make(sourceId);
    // One level in v1, so a source is never also a branch; a branch row above would win anyway.
    if (links.has(threadId)) continue;
    links.set(
      threadId,
      branchLinkFromRecords({
        revision: revisions.get(threadId) ?? 0,
        lineage: null,
        source: null,
        latestOfferState: null,
        openOffers: openOffers.get(threadId) ?? 0,
      }),
    );
  }
  return links;
});
