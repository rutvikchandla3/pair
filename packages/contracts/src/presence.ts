import * as Schema from "effect/Schema";

import { MemberId, ThreadId } from "./baseSchemas.ts";

export const PRESENCE_FLUSH_MS = 1_000;
export const PRESENCE_TYPING_TTL_MS = 8_000;
/** How often a client repeats `typing: true` while its user keeps typing. */
export const PRESENCE_TYPING_REFRESH_MS = 5_000;
/** A client reports `idle: true` after this long without input. */
export const PRESENCE_IDLE_AFTER_MS = 600_000;

export const PresenceStatus = Schema.Literals(["online", "away"]);
export type PresenceStatus = typeof PresenceStatus.Type;

export const PresenceMember = Schema.Struct({ memberId: MemberId, status: PresenceStatus });
export type PresenceMember = typeof PresenceMember.Type;

export const PresenceThreadMembers = Schema.Struct({
  threadId: ThreadId,
  memberIds: Schema.Array(MemberId),
});
export type PresenceThreadMembers = typeof PresenceThreadMembers.Type;

/** Each key replaces what the client holds for it. Never includes the recipient's own member. */
export const PresenceUpdate = Schema.Struct({
  /** Every other connected member. */
  members: Schema.optionalKey(Schema.Array(PresenceMember)),
  /** Per thread; `[]` means nobody. */
  viewers: Schema.optionalKey(Schema.Array(PresenceThreadMembers)),
  /** Who is typing in the thread this connection views. */
  typing: Schema.optionalKey(PresenceThreadMembers),
});
export type PresenceUpdate = typeof PresenceUpdate.Type;

/** Omitted keys are unchanged. Typing applies to the viewed thread. */
export const PresenceReportInput = Schema.Struct({
  viewingThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  typing: Schema.optionalKey(Schema.Boolean),
  idle: Schema.optionalKey(Schema.Boolean),
});
export type PresenceReportInput = typeof PresenceReportInput.Type;
