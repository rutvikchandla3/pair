import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MemberPushPlatform = Schema.Literals(["ios", "android"]);
export type MemberPushPlatform = typeof MemberPushPlatform.Type;

/** Registers this device's Expo push token for the signed-in member on a team server. */
export const MemberPushRegisterInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
  platform: MemberPushPlatform,
});
export type MemberPushRegisterInput = typeof MemberPushRegisterInput.Type;

export const MemberPushUnregisterInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
});
export type MemberPushUnregisterInput = typeof MemberPushUnregisterInput.Type;

export class MemberPushError extends Schema.TaggedError<MemberPushError>()("MemberPushError", {
  message: Schema.String,
}) {}
