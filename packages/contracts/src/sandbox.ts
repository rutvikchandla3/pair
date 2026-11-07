import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import type { OrchestrationV2Sandbox } from "./orchestrationV2.ts";

/** Path-safe: the server addresses a sandbox's files under `/t3-sandbox/<id>/`. */
export const SandboxId = TrimmedNonEmptyString.check(Schema.isPattern(/^sbx_[0-9a-f]{20}$/)).pipe(
  Schema.brand("SandboxId"),
);
export type SandboxId = typeof SandboxId.Type;

/**
 * Names a team or project cannot set on sandbox processes (06 §6): the agent's identity, Pair's
 * own names, and the provider and git credentials the server hands out per process.
 */
const SANDBOX_RESERVED_ENV_NAMES: ReadonlyArray<string> = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_HOME",
  "CURSOR_API_KEY",
  "XAI_API_KEY",
  "KIRO_API_KEY",
  "GIT_ASKPASS",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "SSH_AUTH_SOCK",
];

const SANDBOX_RESERVED_ENV_PREFIXES: ReadonlyArray<string> = [
  "T3CODE_",
  "T3_",
  "PAIR_",
  "GIT_AUTHOR_",
  "GIT_COMMITTER_",
  "GIT_CONFIG_",
];

const reservedSandboxEnvNames = new Set(SANDBOX_RESERVED_ENV_NAMES);

export const isReservedSandboxEnvName = (name: string): boolean =>
  reservedSandboxEnvNames.has(name) ||
  SANDBOX_RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));

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

/** A write to a stopped machine's files; on the wire it rides `ProjectWriteFileError` (P15). */
export class SandboxAsleep extends Schema.TaggedError<SandboxAsleep>()("SandboxAsleep", {
  sandboxId: SandboxId,
  state: SandboxState,
}) {
  override get message() {
    return "This machine is stopped. Wake it to make changes.";
  }
}

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

/** The image a sandbox booted from, as the driver resolved it. */
export const SandboxBaseImageInfo = Schema.Struct({
  ref: TrimmedNonEmptyString,
  digest: TrimmedNonEmptyString,
  /** The image's `org.opencontainers.image.version` label; null for an image without one. */
  version: Schema.NullOr(TrimmedNonEmptyString),
});
export type SandboxBaseImageInfo = typeof SandboxBaseImageInfo.Type;

/** What clients show as the machine's image; null once a team build replaces the base (M3). */
export const sandboxImageLabel = (sandbox: Pick<OrchestrationV2Sandbox, "baseImage">): string =>
  sandbox.baseImage === undefined
    ? "Pair base"
    : sandbox.baseImage.version !== null
      ? `Pair base ${sandbox.baseImage.version}`
      : `Base image ${sandbox.baseImage.ref}`;
