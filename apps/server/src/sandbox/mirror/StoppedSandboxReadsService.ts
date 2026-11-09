import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
  SandboxAsleep,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import type * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import type * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";

// Only the tag, apart from its layer: workspace code inside the runner resolves it, and the layer
// pulls in ProjectionStore, which the runner bundle must never carry (03 §2.1).

export interface StoppedView {
  readonly sandboxId: SandboxId;
  /** The sleep's working-tree snapshot, or a turn's checkpoint. */
  readonly source: "snapshot" | "checkpoint";
  /** Whose snapshot or checkpoint backs the view. */
  readonly threadId: ThreadId;
  /** The checkpoint's appRunOrdinal, for "As of turn N" (0 for a snapshot or none). */
  readonly turn: number;
  /** The checkpoint's oid in the mirror. */
  readonly commit: string;
  /** The mirror. */
  readonly gitDir: string;
  /** cwd relative to the checkpoint's tree root ("" for the root). */
  readonly prefix: string;
  /** The cwd the client asked about. */
  readonly cwd: string;
}

export class StoppedSandboxReads extends Context.Service<
  StoppedSandboxReads,
  {
    /** The view for a cwd under /t3-sandbox/<id>/; fails with SandboxAsleep when none exists. */
    readonly viewFor: (
      cwd: string,
      sandboxId: SandboxId,
    ) => Effect.Effect<StoppedView, SandboxAsleep>;
    /** The refusal a write to a stopped machine gets; nothing is queued. */
    readonly refuseWrite: (sandboxId: SandboxId) => Effect.Effect<never, SandboxAsleep>;
    readonly list: (
      view: StoppedView,
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntries.WorkspaceEntriesError>;
    readonly search: (
      view: StoppedView,
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntries.WorkspaceEntriesError>;
    readonly searchContents: (
      view: StoppedView,
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceEntries.WorkspaceEntriesError>;
    readonly browse: (
      view: StoppedView,
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntries.WorkspaceEntriesBrowseError>;
    readonly readFile: (
      view: StoppedView,
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystem.WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /** The view's uncommitted changes as one `working-tree` source; the mirror has no base branch. */
    readonly diffPreview: (
      view: StoppedView,
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
  }
>()("t3/sandbox/mirror/StoppedSandboxReadsService/StoppedSandboxReads") {}
