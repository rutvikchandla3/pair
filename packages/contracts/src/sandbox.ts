import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Path-safe: the server addresses a sandbox's files under `/t3-sandbox/<id>/`. */
export const SandboxId = TrimmedNonEmptyString.check(Schema.isPattern(/^sbx_[0-9a-f]{20}$/)).pipe(
  Schema.brand("SandboxId"),
);
export type SandboxId = typeof SandboxId.Type;

export const ComputeDriverId = TrimmedNonEmptyString.pipe(Schema.brand("ComputeDriverId"));
export type ComputeDriverId = typeof ComputeDriverId.Type;

export const ComputeDriverKind = Schema.Literals(["docker"]);
export type ComputeDriverKind = typeof ComputeDriverKind.Type;

export const SandboxState = Schema.Literals([
  "provisioning",
  "ready",
  "sleeping",
  "waking",
  "failed",
  "destroyed",
]);
export type SandboxState = typeof SandboxState.Type;

export const SandboxSize = Schema.Literals(["small", "default", "large"]);
export type SandboxSize = typeof SandboxSize.Type;

export const SandboxAdmissionReason = Schema.Literals(["team-cap", "member-cap", "rate-limit"]);
export type SandboxAdmissionReason = typeof SandboxAdmissionReason.Type;

export const SandboxSleepReason = Schema.Literals([
  "idle",
  "manual",
  "settled",
  "archived",
  "cap-pressure",
]);
export type SandboxSleepReason = typeof SandboxSleepReason.Type;

export const SandboxFailure = Schema.Struct({
  /** Open set: create-failed, start-failed, boot-timeout, lost, driver-removed, workspace-failed. */
  code: TrimmedNonEmptyString,
  message: Schema.String,
  retryable: Schema.Boolean,
});
export type SandboxFailure = typeof SandboxFailure.Type;
