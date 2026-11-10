import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import type { OrchestrationV2Sandbox } from "./orchestrationV2.ts";

/** Path-safe: the server addresses a sandbox's files under `/t3-sandbox/<id>/`. */
export const SandboxId = TrimmedNonEmptyString.check(Schema.isPattern(/^sbx_[0-9a-f]{20}$/)).pipe(
  Schema.brand("SandboxId"),
);
export type SandboxId = typeof SandboxId.Type;

/** A team image build's id; the sandbox record carries it so machine details can name the build. */
export const TeamImageBuildId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^tib_[0-9a-f]{20}$/),
).pipe(Schema.brand("TeamImageBuildId"));
export type TeamImageBuildId = typeof TeamImageBuildId.Type;

/** The team build a sandbox booted from; `number` is the per-team build number clients show. */
export const SandboxImageBuildRef = Schema.Struct({
  id: TeamImageBuildId,
  number: PositiveInt,
});
export type SandboxImageBuildRef = typeof SandboxImageBuildRef.Type;

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

export const ComputeDriverKind = Schema.Literals(["docker", "gce"]);
export type ComputeDriverKind = typeof ComputeDriverKind.Type;

/** Kinds whose machines are cloud VMs: they never share the server's disk or Docker network. */
export const SANDBOX_VM_DRIVER_KINDS: ReadonlySet<ComputeDriverKind> = new Set(["gce"]);

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

export const SandboxAdmissionReason = Schema.Literals([
  "team-cap",
  "member-cap",
  "rate-limit",
  /** The server is draining for an upgrade (`t3 drain`); the restart or a cancel admits it. */
  "draining",
]);
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
  /**
   * Open set: create-failed, start-failed, boot-timeout, boot-stopped, lost, missing,
   * driver-removed, workspace-failed.
   */
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

/** What clients show as the machine's image: its team build, else the base it booted from. */
export const sandboxImageLabel = (
  sandbox: Pick<OrchestrationV2Sandbox, "baseImage" | "imageBuild">,
): string =>
  sandbox.imageBuild !== undefined
    ? `Build ${sandbox.imageBuild.number}`
    : sandbox.baseImage === undefined
      ? "Pair base"
      : sandbox.baseImage.version !== null
        ? `Pair base ${sandbox.baseImage.version}`
        : `Base image ${sandbox.baseImage.ref}`;

/** What Settings → Cloud shows of a driver's isolation; `runc` is not a security boundary (01 J1). */
export const SandboxDriverIsolation = Schema.Literals(["rootless", "gvisor", "runc", "unknown"]);
export type SandboxDriverIsolation = typeof SandboxDriverIsolation.Type;

export const SandboxDriverHealth = Schema.Struct({
  driverId: ComputeDriverId,
  reachable: Schema.Boolean,
  isolation: SandboxDriverIsolation,
  /** How many of its machines run at once before new ones wait; read only in M1 (D5). */
  runningCap: NonNegativeInt,
  /** Why it is unreachable, or what is wrong with its base image. Never names the host. */
  message: Schema.optionalKey(Schema.String),
});
export type SandboxDriverHealth = typeof SandboxDriverHealth.Type;

/** A machine restore mode stopped instead of destroying: no record, or a discarded one (04 §5). */
export const SandboxRestoreModeMachine = Schema.Struct({
  sandboxId: SandboxId,
  driverId: ComputeDriverId,
  createdAt: Schema.DateTimeUtc,
  hasRecord: Schema.Boolean,
});
export type SandboxRestoreModeMachine = typeof SandboxRestoreModeMachine.Type;

/** Settings → Cloud's Overview; members may read it, so it carries no host or env value. */
export const SandboxOverview = Schema.Struct({
  drivers: Schema.Array(SandboxDriverHealth),
  machines: Schema.Struct({
    ready: NonNegativeInt,
    sleeping: NonNegativeInt,
    failed: NonNegativeInt,
    waiting: NonNegativeInt,
  }),
  /** Server-wide; there is no member cap in M1 (D5). */
  startsPerMinute: NonNegativeInt,
  baseImage: Schema.Struct({ ref: Schema.String, label: Schema.String }),
  mirrorBytes: NonNegativeInt,
  restoreMode: Schema.optionalKey(
    Schema.Struct({ since: Schema.DateTimeUtc, machines: Schema.Array(SandboxRestoreModeMachine) }),
  ),
});
export type SandboxOverview = typeof SandboxOverview.Type;

export class SandboxOverviewError extends Schema.TaggedError<SandboxOverviewError>()(
  "SandboxOverviewError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Could not read the Cloud status.";
  }
}

/** The thread view's viewer lease, renewed while a cloud thread is visible and focused. */
export const SandboxViewingInput = Schema.Struct({ threadId: ThreadId });
export type SandboxViewingInput = typeof SandboxViewingInput.Type;

export const SandboxDriverCheckInput = Schema.Struct({ driverId: ComputeDriverId });
export type SandboxDriverCheckInput = typeof SandboxDriverCheckInput.Type;

/** Closed: a new step fails older clients' whole decode, so `git` also runs sudo and reaches github.com. */
export const SandboxDriverCheckStep = Schema.Literals([
  "image",
  "create",
  "runner",
  "git",
  "discard",
]);
export type SandboxDriverCheckStep = typeof SandboxDriverCheckStep.Type;

/** The steps that ran, in order; a failed step ends the check, and `discard` follows any create. */
export const SandboxDriverCheckResult = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({
      step: SandboxDriverCheckStep,
      ok: Schema.Boolean,
      durationMs: NonNegativeInt,
      message: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type SandboxDriverCheckResult = typeof SandboxDriverCheckResult.Type;

export class SandboxDriverCheckError extends Schema.TaggedError<SandboxDriverCheckError>()(
  "SandboxDriverCheckError",
  {
    driverId: ComputeDriverId,
    reason: Schema.Literals(["not-configured", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "not-configured"
      ? `Compute driver ${this.driverId} is not configured.`
      : "Could not start the check.";
  }
}
