import * as Schema from "effect/Schema";

import { ForwardCompatibleNullable, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** One move's id, chosen by the local server and reused on every retry; safe in a ref and a path. */
export const CloudStagingKey = TrimmedNonEmptyString.check(
  Schema.isPattern(/^mv_[0-9a-f]{32}$/),
).pipe(Schema.brand("CloudStagingKey"));
export type CloudStagingKey = typeof CloudStagingKey.Type;

export const CLOUD_MOVE_ROUTE_PREFIX = "/api/cloud-moves";
export const CLOUD_SEED_MAX_BYTES = 512 * 1024 * 1024;

/** A seed bundle carries exactly these refs; the mirror keeps them under the same names. */
export const cloudSeedRefs = (key: CloudStagingKey) =>
  ({
    branch: `refs/t3/staged/${key}/branch`,
    snapshot: `refs/t3/staged/${key}/snapshot`,
  }) as const;

export const CloudMoveFailureReason = Schema.Literals([
  "unauthenticated",
  "forbidden",
  "bad-request",
  "unknown-project",
  "too-large",
  "invalid-seed",
  "missing-prerequisite",
  "claimed",
  "key-in-use",
  "internal",
]);
export type CloudMoveFailureReason = typeof CloudMoveFailureReason.Type;

/** Every cloud-move route's error body. A newer server's reason reads as null. */
export const CloudMoveFailure = Schema.Struct({
  reason: ForwardCompatibleNullable(CloudMoveFailureReason),
  message: Schema.String,
});
export type CloudMoveFailure = typeof CloudMoveFailure.Type;
