import * as Schema from "effect/Schema";

import {
  ForwardCompatibleNullable,
  MemberId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceEnvironmentVariableName } from "./providerInstance.ts";
import { ComputeDriverId, TeamImageBuildId } from "./sandbox.ts";
import { SecretReference } from "./secretReference.ts";

const TEAM_IMAGE_MAX_PROJECTS = 50;
export const TEAM_IMAGE_INSTALL_MAX_CHARS = 64_000;

/** One member in M4: Pair's base for the server's version. An image base joins Later. */
export const TeamImageBase = Schema.Union([Schema.Struct({ type: Schema.Literal("pair") })]);
export type TeamImageBase = typeof TeamImageBase.Type;

export const TeamImageRequester = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("member"), memberId: MemberId }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    threadId: ThreadId,
    runId: RunId,
    /** The run's human authors when it asked, so the build's result reaches them. */
    authorIds: Schema.Array(MemberId),
  }),
]);
export type TeamImageRequester = typeof TeamImageRequester.Type;

/** One per team. Secrets are references, never values. */
export const TeamImageRecipe = Schema.Struct({
  base: TeamImageBase,
  /** Pair Cloud projects to pre-clone. */
  projectIds: Schema.Array(ProjectId).check(
    Schema.isMaxLength(TEAM_IMAGE_MAX_PROJECTS),
    Schema.isUnique(),
  ),
  buildEnv: Schema.Record(ProviderInstanceEnvironmentVariableName, Schema.String),
  buildSecrets: Schema.Record(ProviderInstanceEnvironmentVariableName, SecretReference),
  /** Bash, run as `t3` from `$HOME`. */
  install: Schema.String.check(Schema.isMaxLength(TEAM_IMAGE_INSTALL_MAX_CHARS)),
}).check(
  Schema.makeFilter(
    (recipe) => !Object.keys(recipe.buildEnv).some((name) => name in recipe.buildSecrets),
    { expected: "no name in both buildEnv and buildSecrets" },
  ),
);
export type TeamImageRecipe = typeof TeamImageRecipe.Type;

/** Immutable once saved; a build names the revision it ran. */
export const TeamImageRecipeRevision = Schema.Struct({
  revision: PositiveInt,
  recipe: TeamImageRecipe,
  savedAt: Schema.DateTimeUtc,
  savedBy: TeamImageRequester,
});
export type TeamImageRecipeRevision = typeof TeamImageRecipeRevision.Type;

export const TeamImageBuildPhase = Schema.Literals([
  "launch",
  "preflight",
  "clone",
  "install",
  "env",
  "verify",
  "clean",
  "manifest",
  "capture",
]);
export type TeamImageBuildPhase = typeof TeamImageBuildPhase.Type;

export const TeamImageBuildStatus = Schema.Literals([
  "queued",
  "launching",
  "running",
  "capturing",
  "succeeded",
  "failed",
  "cancelled",
]);
export type TeamImageBuildStatus = typeof TeamImageBuildStatus.Type;

export const TeamImageManifest = Schema.Struct({
  base: Schema.Struct({
    ref: Schema.String,
    digest: Schema.NullOr(Schema.String),
    pairVersion: Schema.String,
  }),
  providers: Schema.Array(
    Schema.Struct({ driver: ProviderDriverKind, version: Schema.NullOr(Schema.String) }),
  ),
  repos: Schema.Array(
    Schema.Struct({ projectId: ProjectId, path: Schema.String, headSha: Schema.String }),
  ),
  /** The runner is the server's own bundle, fetched or bound at each boot. */
  serverVersion: Schema.String,
  imageEnv: Schema.Record(Schema.String, Schema.String),
  sizeBytes: Schema.NullOr(NonNegativeInt),
});
export type TeamImageManifest = typeof TeamImageManifest.Type;

export const TeamImageBuildFailure = Schema.Struct({
  phase: Schema.Union([TeamImageBuildPhase, Schema.Literals(["interrupted", "timed-out", "leak"])]),
  detail: Schema.String,
  exitCode: Schema.optionalKey(Schema.Int),
  logTail: Schema.Array(Schema.String).check(Schema.isMaxLength(30)),
});
export type TeamImageBuildFailure = typeof TeamImageBuildFailure.Type;

/** It does not copy its recipe: revisions are immutable, so `recipeRevision` is the copy. */
export const TeamImageBuild = Schema.Struct({
  id: TeamImageBuildId,
  /** Per team. */
  number: PositiveInt,
  status: TeamImageBuildStatus,
  phase: Schema.NullOr(TeamImageBuildPhase),
  recipeRevision: PositiveInt,
  driverId: ComputeDriverId,
  requestedBy: TeamImageRequester,
  activateOnSuccess: Schema.Boolean,
  imageRef: Schema.optionalKey(Schema.String),
  manifest: Schema.optionalKey(TeamImageManifest),
  failure: Schema.optionalKey(TeamImageBuildFailure),
  requestedAt: Schema.DateTimeUtc,
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  finishedAt: Schema.NullOr(Schema.DateTimeUtc),
  imageDeletedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type TeamImageBuild = typeof TeamImageBuild.Type;

export const TeamImageProposalId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^tip_[0-9a-f]{20}$/),
).pipe(Schema.brand("TeamImageProposalId"));
export type TeamImageProposalId = typeof TeamImageProposalId.Type;

/** An agent's suggested install script, for an admin to accept into the editor. */
export const TeamImageProposal = Schema.Struct({
  id: TeamImageProposalId,
  threadId: ThreadId,
  projectId: ProjectId,
  baseRevision: PositiveInt,
  install: Schema.String.check(Schema.isMaxLength(TEAM_IMAGE_INSTALL_MAX_CHARS)),
  reason: Schema.String.check(Schema.isMaxLength(500)),
  status: Schema.Literals(["open", "accepted", "dismissed"]),
  createdAt: Schema.DateTimeUtc,
  closedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type TeamImageProposal = typeof TeamImageProposal.Type;

/** What a rebuild would boot from. A digest is null until the driver has resolved the image. */
export const TeamImageCurrentBase = Schema.Struct({
  ref: TrimmedNonEmptyString,
  digest: Schema.NullOr(TrimmedNonEmptyString),
  /** The image's `org.opencontainers.image.version`; null for an image without one. */
  version: Schema.NullOr(TrimmedNonEmptyString),
});
export type TeamImageCurrentBase = typeof TeamImageCurrentBase.Type;

export const TeamImageSnapshot = Schema.Struct({
  recipe: Schema.NullOr(TeamImageRecipeRevision),
  activeBuildId: Schema.NullOr(TeamImageBuildId),
  /** The newest 20, plus the active one. */
  builds: Schema.Array(TeamImageBuild),
  /** Open ones only. */
  proposals: Schema.Array(TeamImageProposal),
  keepSucceeded: PositiveInt,
  /** The base a rebuild would use now; absent until the server reports it. */
  currentBase: Schema.optionalKey(TeamImageCurrentBase),
});
export type TeamImageSnapshot = typeof TeamImageSnapshot.Type;

export const TeamImageErrorReason = Schema.Literals([
  "not-admin",
  "not-available",
  "invalid-recipe",
  "recipe-changed",
  "build-running",
  "no-capacity",
  "draining",
  "not-found",
  "wrong-state",
  "image-deleted",
  "proposal-open",
  "too-many-proposals",
]);
export type TeamImageErrorReason = typeof TeamImageErrorReason.Type;

/** `message` is written for people; clients show it as is. A newer server's reason reads as null. */
export class TeamImageError extends Schema.TaggedError<TeamImageError>()("TeamImageError", {
  reason: ForwardCompatibleNullable(TeamImageErrorReason),
  message: Schema.String,
}) {}

export const TeamImageSaveRecipeInput = Schema.Struct({
  /** The revision the editor started from; null for the first save. */
  baseRevision: Schema.NullOr(PositiveInt),
  recipe: TeamImageRecipe,
});
export type TeamImageSaveRecipeInput = typeof TeamImageSaveRecipeInput.Type;

export const TeamImageStartBuildInput = Schema.Struct({ recipeRevision: PositiveInt });
export type TeamImageStartBuildInput = typeof TeamImageStartBuildInput.Type;

export const TeamImageBuildRef = Schema.Struct({ imageBuildId: TeamImageBuildId });
export type TeamImageBuildRef = typeof TeamImageBuildRef.Type;

export const TeamImageReadRecipeInput = Schema.Struct({ revision: PositiveInt });
export type TeamImageReadRecipeInput = typeof TeamImageReadRecipeInput.Type;

export const TeamImageBuildLogChunk = Schema.Struct({
  text: Schema.String,
  done: Schema.Boolean,
});
export type TeamImageBuildLogChunk = typeof TeamImageBuildLogChunk.Type;

export const TeamImageDismissProposalInput = Schema.Struct({ proposalId: TeamImageProposalId });
export type TeamImageDismissProposalInput = typeof TeamImageDismissProposalInput.Type;
