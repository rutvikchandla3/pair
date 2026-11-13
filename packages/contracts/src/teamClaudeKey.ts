import * as Schema from "effect/Schema";

import { ForwardCompatibleNullable, IsoDateTime, MemberId, NonNegativeInt } from "./baseSchemas.ts";

/** Settings → Team anchor for the key's card; links and the composer hint point here. */
export const TEAM_CLAUDE_KEY_SETTINGS_ANCHOR = "team-claude-key";

/**
 * The key `@pair` replies with. The value never leaves the server. `activeSpaceCount` is the
 * server's non-archived space count, which a member can't compute from the spaces they're in.
 */
export const TeamClaudeKeyStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("unset"), activeSpaceCount: NonNegativeInt }),
  Schema.Struct({
    state: Schema.Literal("set"),
    last4: Schema.String.check(Schema.isBetweenLength(4, 4)),
    addedBy: MemberId,
    addedAt: IsoDateTime,
    /** In memory only: null after a server restart. */
    lastUsedAt: Schema.NullOr(IsoDateTime),
    activeSpaceCount: NonNegativeInt,
  }),
]);
export type TeamClaudeKeyStatus = typeof TeamClaudeKeyStatus.Type;

/** No checks on `value`: a failed check would print it. The server validates it. */
export const TeamClaudeKeySetInput = Schema.Struct({ value: Schema.Redacted(Schema.String) });
export type TeamClaudeKeySetInput = typeof TeamClaudeKeySetInput.Type;

export const TeamClaudeKeyErrorReason = Schema.Literals([
  "not-admin",
  "rejected",
  "unreachable",
  "invalid",
]);
export type TeamClaudeKeyErrorReason = typeof TeamClaudeKeyErrorReason.Type;

export class TeamClaudeKeyError extends Schema.TaggedError<TeamClaudeKeyError>()(
  "TeamClaudeKeyError",
  {
    reason: ForwardCompatibleNullable(TeamClaudeKeyErrorReason),
    message: Schema.String,
  },
) {}
