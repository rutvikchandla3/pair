import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AuthMcpClientAccess } from "./auth.ts";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

/** Empty strings mean unset: the default Codex instance, its default voice and model, no base URL override. */
export const ChiefOfStaffSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  providerInstanceId: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  voice: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  model: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  toolAccess: AuthMcpClientAccess.pipe(
    Schema.withDecodingDefault(Effect.succeed("read-only" as const)),
  ),
  realtimeBaseUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type ChiefOfStaffSettings = typeof ChiefOfStaffSettings.Type;

export const ChiefOfStaffSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  providerInstanceId: Schema.optionalKey(TrimmedString),
  voice: Schema.optionalKey(TrimmedString),
  model: Schema.optionalKey(TrimmedString),
  toolAccess: Schema.optionalKey(AuthMcpClientAccess),
  realtimeBaseUrl: Schema.optionalKey(TrimmedString),
});

export const ChiefOfStaffAvatarStyle = Schema.Literals(["pet", "orb", "bot", "dots", "wave"]);
export type ChiefOfStaffAvatarStyle = typeof ChiefOfStaffAvatarStyle.Type;

export const ChiefOfStaffAvatarSize = Schema.Literals(["small", "medium", "large"]);
export type ChiefOfStaffAvatarSize = typeof ChiefOfStaffAvatarSize.Type;

/** A CSS colour; empty follows the app theme. */
export const ChiefOfStaffAvatarAccentColor = TrimmedString.check(Schema.isMaxLength(64));

/** Client settings fields. Missing or unknown values, such as a style a newer client added, decode to the default. */
export const ChiefOfStaffAvatarClientSettings = {
  chiefOfStaffAvatarStyle: ChiefOfStaffAvatarStyle.pipe(
    Schema.catchDecoding(() => Effect.succeedSome("pet" as const)),
    Schema.withDecodingDefault(Effect.succeed("pet" as const)),
  ),
  chiefOfStaffAvatarAccentColor: ChiefOfStaffAvatarAccentColor.pipe(
    Schema.catchDecoding(() => Effect.succeedSome("")),
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
  chiefOfStaffAvatarSize: ChiefOfStaffAvatarSize.pipe(
    Schema.catchDecoding(() => Effect.succeedSome("medium" as const)),
    Schema.withDecodingDefault(Effect.succeed("medium" as const)),
  ),
};

/** Only Codex's app-server speaks realtime voice; every other driver is refused with `unsupported-provider`. */
export const supportsChiefOfStaffVoice = (driver: string): boolean => driver === "codex";

export const ChiefOfStaffSessionId = TrimmedNonEmptyString.pipe(
  Schema.brand("ChiefOfStaffSessionId"),
);
export type ChiefOfStaffSessionId = typeof ChiefOfStaffSessionId.Type;

export const ChiefOfStaffStartInput = Schema.Struct({
  sdpOffer: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64 * 1024)),
});
export type ChiefOfStaffStartInput = typeof ChiefOfStaffStartInput.Type;

export const ChiefOfStaffStartResult = Schema.Struct({
  sessionId: ChiefOfStaffSessionId,
  sdpAnswer: Schema.String,
  /** Epoch milliseconds, when the provider reports one. */
  expiresAt: Schema.optionalKey(Schema.Number),
});
export type ChiefOfStaffStartResult = typeof ChiefOfStaffStartResult.Type;

export const ChiefOfStaffSessionInput = Schema.Struct({ sessionId: ChiefOfStaffSessionId });
export type ChiefOfStaffSessionInput = typeof ChiefOfStaffSessionInput.Type;

export const ChiefOfStaffVoiceList = Schema.Struct({
  voices: Schema.Array(Schema.String),
  defaultVoice: Schema.optionalKey(Schema.String),
});
export type ChiefOfStaffVoiceList = typeof ChiefOfStaffVoiceList.Type;

export const ChiefOfStaffState = Schema.Literals([
  "connecting",
  "listening",
  "thinking",
  "speaking",
  "closed",
]);
export type ChiefOfStaffState = typeof ChiefOfStaffState.Type;

/** `replaced`: the same member started another session. `ended`: the provider closed it. */
export const ChiefOfStaffCloseReason = Schema.Literals(["stopped", "replaced", "ended", "failed"]);
export type ChiefOfStaffCloseReason = typeof ChiefOfStaffCloseReason.Type;

export const ChiefOfStaffSpeaker = Schema.Literals(["user", "assistant"]);
export type ChiefOfStaffSpeaker = typeof ChiefOfStaffSpeaker.Type;

export const ChiefOfStaffEvent = Schema.Union([
  Schema.TaggedStruct("state", {
    state: ChiefOfStaffState,
    /** Set only with `closed`. */
    closeReason: Schema.optionalKey(ChiefOfStaffCloseReason),
    /** User-readable, set when the session failed. */
    message: Schema.optionalKey(Schema.String),
  }),
  /** `final` replaces the deltas of the same role's current utterance. */
  Schema.TaggedStruct("transcript", {
    role: ChiefOfStaffSpeaker,
    text: Schema.String,
    final: Schema.Boolean,
  }),
  Schema.TaggedStruct("working", {
    id: Schema.String,
    tool: Schema.String,
    label: Schema.String,
    status: Schema.Literals(["started", "completed", "failed"]),
  }),
]);
export type ChiefOfStaffEvent = typeof ChiefOfStaffEvent.Type;

/** Clients show `message` and never branch on `reason`. */
export class ChiefOfStaffError extends Schema.TaggedError<ChiefOfStaffError>()(
  "ChiefOfStaffError",
  {
    reason: Schema.Literals([
      "disabled",
      "provider-not-found",
      "unsupported-provider",
      "signed-out",
      "requires-api-key",
      "realtime-endpoint-not-found",
      "start-failed",
      "session-not-found",
      "app-server-failed",
    ]),
    message: Schema.String,
  },
) {}
