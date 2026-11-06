import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** The drivers whose per-instance home a member can be given safely. */
export const MemberProviderAccountDriver = Schema.Literals(["claudeAgent", "codex"]);
export type MemberProviderAccountDriver = typeof MemberProviderAccountDriver.Type;

/**
 * A member's own provider account. Never a raw config: the server picks the id, the home and the
 * environment, so a member cannot point an account at the team's login or run another binary.
 */
export const MemberProviderAccountMutation = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("create"),
    driver: MemberProviderAccountDriver,
    displayName: Schema.optionalKey(TrimmedNonEmptyString),
    /** Claude only: an API key, or an OAuth token from `claude setup-token`. */
    token: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    operation: Schema.Literal("update"),
    instanceId: ProviderInstanceId,
    displayName: Schema.optionalKey(TrimmedNonEmptyString),
    /** `null` removes the saved token. */
    token: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  }),
  Schema.Struct({
    operation: Schema.Literal("remove"),
    instanceId: ProviderInstanceId,
  }),
]);
export type MemberProviderAccountMutation = typeof MemberProviderAccountMutation.Type;

export const MemberProviderAccountResult = Schema.Struct({ instanceId: ProviderInstanceId });
export type MemberProviderAccountResult = typeof MemberProviderAccountResult.Type;
