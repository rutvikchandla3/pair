import * as Schema from "effect/Schema";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Pair Builder host mode: the Builder embeds this environment in a task's sandbox, proxies the
 * browser to it, and starts sessions (threads) for its users. Field names follow the Builder's
 * own contract, so they stay snake_case.
 */
export const PairBuilderUser = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  avatar_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type PairBuilderUser = typeof PairBuilderUser.Type;

export const PairBuilderSessionMode = Schema.Literals(["plan", "ask", "agent"]);
export type PairBuilderSessionMode = typeof PairBuilderSessionMode.Type;

export const PairBuilderHostSessionRequest = Schema.Struct({
  prompt: TrimmedNonEmptyString,
  title: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(100))),
  mode: Schema.optionalKey(PairBuilderSessionMode),
  user: PairBuilderUser,
});
export type PairBuilderHostSessionRequest = typeof PairBuilderHostSessionRequest.Type;

/** The thread exists; `prompt_accepted` is false when its first message could not be sent. */
export const PairBuilderHostSessionResult = Schema.Struct({
  session_id: ThreadId,
  prompt_accepted: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
}).pipe(HttpApiSchema.status(201));
export type PairBuilderHostSessionResult = typeof PairBuilderHostSessionResult.Type;

export class PairBuilderHostSessionError extends Schema.Error<PairBuilderHostSessionError>(
  "PairBuilderHostSessionError",
)({ error: Schema.String }, { httpApiStatus: 502 }) {
  override get message(): string {
    return this.error;
  }
}

/** One thread as the Builder lists it; `id` is the thread id. Times are epoch milliseconds. */
export const PairBuilderSnapshotSession = Schema.Struct({
  id: ThreadId,
  runtime_session_id: Schema.Null,
  name: Schema.String,
  first_message: Schema.String,
  title: Schema.String,
  created_at: NonNegativeInt,
  updated_at: NonNegativeInt,
  is_streaming: Schema.Boolean,
  archived: Schema.Boolean,
  created_by: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
export type PairBuilderSnapshotSession = typeof PairBuilderSnapshotSession.Type;

/** What the workspace POSTs to `PAIR_BUILDER_EVENTS_URL`: every session, each time. */
export const PairBuilderSessionsSnapshot = Schema.Struct({
  type: Schema.Literal("sessions.snapshot"),
  sandbox_id: Schema.NullOr(Schema.String),
  sent_at: Schema.String,
  connections: NonNegativeInt,
  sessions: Schema.Array(PairBuilderSnapshotSession),
});
export type PairBuilderSessionsSnapshot = typeof PairBuilderSessionsSnapshot.Type;
