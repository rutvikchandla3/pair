import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  ForwardCompatibleNullable,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ScopedThreadRef } from "./environment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2CreationSource } from "./orchestrationV2.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

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
  "invalid-export",
  "missing-prerequisite",
  "claimed",
  "key-in-use",
  "internal",
  "not-found",
  "not-movable",
  "run-active",
  "snapshot-missing",
  "snapshot-failed",
  /** Pair Cloud won't take this launch; `message` says why. */
  "refused",
  /** A seedless launch's branch is gone from origin. */
  "branch-not-pushed",
]);
export type CloudMoveFailureReason = typeof CloudMoveFailureReason.Type;

/** Every cloud-move route's error body. A newer server's reason reads as null. */
export const CloudMoveFailure = Schema.Struct({
  reason: ForwardCompatibleNullable(CloudMoveFailureReason),
  message: Schema.String,
});
export type CloudMoveFailure = typeof CloudMoveFailure.Type;

/** How many commits the laptop may name as already there when it asks for a seed. */
export const CLOUD_MOVE_MAX_HAVES = 32;

/** A full SHA-1 or SHA-256 object id. */
export const CloudMoveGitOid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
);

export const CLOUD_MOVE_SEED_HEADERS = {
  mode: "t3-move-mode",
  branch: "t3-move-branch",
  base: "t3-move-base",
  origin: "t3-move-origin",
  head: "t3-move-head",
  snapshot: "t3-move-snapshot",
  snapshotAt: "t3-move-snapshot-at",
} as const;

/**
 * `GET …/threads/<id>/seed` answers with these; the bundle keeps the mirror's ref names. Branch,
 * base and origin are URI-encoded, since a header carries only Latin-1.
 */
export const CloudMoveSeedHeaders = Schema.Struct({
  [CLOUD_MOVE_SEED_HEADERS.mode]: Schema.Literals(["move", "copy"]),
  [CLOUD_MOVE_SEED_HEADERS.branch]: TrimmedNonEmptyString,
  [CLOUD_MOVE_SEED_HEADERS.base]: Schema.optional(TrimmedNonEmptyString),
  [CLOUD_MOVE_SEED_HEADERS.origin]: TrimmedNonEmptyString,
  [CLOUD_MOVE_SEED_HEADERS.head]: CloudMoveGitOid,
  [CLOUD_MOVE_SEED_HEADERS.snapshot]: Schema.optional(CloudMoveGitOid),
  [CLOUD_MOVE_SEED_HEADERS.snapshotAt]: Schema.optional(Schema.DateTimeUtcFromString),
});
export type CloudMoveSeedHeaders = typeof CloudMoveSeedHeaders.Type;

/** The laptop's report that a move landed there, so the cloud thread can link and settle. */
export const CloudMoveContinuedInput = Schema.Struct({
  moveId: CloudStagingKey,
  thread: ScopedThreadRef,
  environmentLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  copy: Schema.Boolean,
});
export type CloudMoveContinuedInput = typeof CloudMoveContinuedInput.Type;

export const CloudMoveContinuedResult = Schema.Struct({ settled: Schema.Boolean });
export type CloudMoveContinuedResult = typeof CloudMoveContinuedResult.Type;

export const ThreadMoveToLocalInput = Schema.Struct({
  commandId: CommandId,
  /** A cloud thread on an environment this server links to. */
  source: ScopedThreadRef,
  /** The local project whose origin matches the cloud thread's. */
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type ThreadMoveToLocalInput = typeof ThreadMoveToLocalInput.Type;

export const ThreadMoveToLocalResult = Schema.Struct({
  threadId: ThreadId,
  branch: TrimmedNonEmptyString,
  copy: Schema.Boolean,
  /** False when Pair Cloud didn't hear about the move; the local thread says so. */
  reported: Schema.Boolean,
});
export type ThreadMoveToLocalResult = typeof ThreadMoveToLocalResult.Type;

/** The first message a moved thread gets when nobody writes one. */
export const CLOUD_MOVE_DEFAULT_MESSAGE = "Continue from where the conversation left off.";

const CLOUD_MOVE_MESSAGE = TrimmedNonEmptyString.check(Schema.isMaxLength(120_000));
/** As git prints it, relative to the repository root; not trimmed, since a name may end in a space. */
const MovePath = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096));

export const ThreadMovePreviewInput = Schema.Struct({
  threadId: ThreadId,
  cloudEnvironmentId: EnvironmentId,
});
export type ThreadMovePreviewInput = typeof ThreadMovePreviewInput.Type;

/** What Continue in cloud would send. Lists only what git doesn't ignore. */
export const ThreadMovePreview = Schema.Struct({
  branch: TrimmedNonEmptyString,
  /** Without `origin/`. */
  baseRef: TrimmedNonEmptyString,
  /** origin/<branch> is at the local tip. */
  pushed: Schema.Boolean,
  commits: Schema.Array(Schema.Struct({ sha: Schema.String, subject: Schema.String })),
  commitsTruncated: Schema.Boolean,
  files: Schema.Array(
    Schema.Struct({
      path: MovePath,
      insertions: NonNegativeInt,
      deletions: NonNegativeInt,
    }),
  ),
  filesTruncated: Schema.Boolean,
  link: Schema.Union([
    Schema.Struct({ status: Schema.Literal("linked") }),
    Schema.Struct({ status: Schema.Literals(["missing", "expired"]), message: Schema.String }),
  ]),
  /** This thread's move is running. */
  moving: Schema.Boolean,
});
export type ThreadMovePreview = typeof ThreadMovePreview.Type;

export const ThreadMoveToCloudInput = Schema.Struct({
  threadId: ThreadId,
  cloudEnvironmentId: EnvironmentId,
  cloudProjectId: ProjectId,
  /** Left at HEAD's version, or out if untracked. */
  excludePaths: Schema.Array(MovePath).check(Schema.isMaxLength(1_000)),
  message: CLOUD_MOVE_MESSAGE,
  creationSource: Schema.optionalKey(Schema.Literals(["web", "mobile"])),
});
export type ThreadMoveToCloudInput = typeof ThreadMoveToCloudInput.Type;

export const ThreadMoveToCloudResult = Schema.Struct({
  cloudThread: ScopedThreadRef,
  seeded: Schema.Boolean,
});
export type ThreadMoveToCloudResult = typeof ThreadMoveToCloudResult.Type;

/** Asked before anything uploads: Pair Cloud names the project and the account it would use. */
export const CloudMoveCheckInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  originKey: TrimmedNonEmptyString,
  /** The local thread's; Pair Cloud picks its own instance (its ids differ from the laptop's). */
  model: Schema.Struct({ driver: ProviderDriverKind, model: TrimmedNonEmptyString }),
});
export type CloudMoveCheckInput = typeof CloudMoveCheckInput.Type;

export const CloudMoveCheckResult = Schema.Struct({
  projectId: ProjectId,
  modelSelection: ModelSelection,
});
export type CloudMoveCheckResult = typeof CloudMoveCheckResult.Type;

/** `POST staged/<key>/launch`. The key names the seed and export, so neither ref is on the wire. */
export const CloudMoveLaunchInput = Schema.Struct({
  projectId: ProjectId,
  modelSelection: ModelSelection,
  title: Schema.String,
  baseRef: TrimmedNonEmptyString,
  branch: Schema.optionalKey(TrimmedNonEmptyString),
  existingBranch: Schema.optionalKey(Schema.Literal(true)),
  seeded: Schema.Boolean,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  message: CLOUD_MOVE_MESSAGE,
  createdBy: Schema.Literals(["user", "agent"]),
  creationSource: OrchestrationV2CreationSource,
});
export type CloudMoveLaunchInput = typeof CloudMoveLaunchInput.Type;

export const CloudMoveLaunchResult = Schema.Struct({ threadId: ThreadId });
export type CloudMoveLaunchResult = typeof CloudMoveLaunchResult.Type;

/**
 * Reaches only a client built with this server (08 §4), so its reasons stay strict. Clients show
 * `message` and never branch on `reason`.
 */
export class ThreadMoveError extends Schema.TaggedError<ThreadMoveError>()("ThreadMoveError", {
  reason: Schema.Literals([
    "not-linked",
    "unsupported",
    "project-mismatch",
    "refused",
    "failed",
    "run-active",
    "cloud-thread",
    "no-repository",
    "no-branch",
    "no-base",
    "not-on-github",
    "link-failed",
    "seed-too-large",
    "seed-failed",
    "upload-failed",
  ]),
  message: Schema.String,
}) {}
