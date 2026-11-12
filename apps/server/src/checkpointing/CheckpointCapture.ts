import type { CheckpointRef, OrchestrationV2CheckpointFileSummary } from "@t3tools/contracts";
import type { RunnerOpsCheckpointCaptureResult } from "@t3tools/contracts/runner";
import * as Effect from "effect/Effect";

import * as CheckpointStore from "./CheckpointStore.ts";
import type { CheckpointStoreError } from "./Errors.ts";
import { isGitImport, parseTurnDiffFilesFromNumstat } from "./Diffs.ts";

// The git half of a checkpoint capture. The server runs it for local workspaces and the runner
// runs it inside a sandbox, so a turn's capture and file summary cost one call there.

export interface CheckpointCaptureWarning {
  readonly kind: RunnerOpsCheckpointCaptureResult["warnings"][number];
  readonly checkpointRef: CheckpointRef;
  readonly cause: string;
}

export interface TurnCapture {
  readonly status: RunnerOpsCheckpointCaptureResult["status"];
  readonly commitOid: string | null;
  readonly roots?: CheckpointStore.RootCommits;
  readonly files: ReadonlyArray<OrchestrationV2CheckpointFileSummary>;
  readonly warnings: ReadonlyArray<CheckpointCaptureWarning>;
}

/** With roots, every root's commit too; `commitOid` is the first captured one. */
const capture = Effect.fn("CheckpointCapture.capture")(function* (
  store: CheckpointStore.CheckpointStore["Service"],
  input: CheckpointStore.CaptureCheckpointInput,
): Effect.fn.Return<
  { readonly commitOid: string | null; readonly roots?: CheckpointStore.RootCommits },
  CheckpointStoreError
> {
  const { roots } = input;
  if (roots === undefined) {
    return { commitOid: yield* store.captureCheckpoint(input) };
  }
  const commits = yield* store.captureRoots({ ...input, roots });
  return {
    commitOid: commits.find((root) => root.commitOid !== null)?.commitOid ?? null,
    roots: commits,
  };
});

export const isGitCheckpointable = (cwd: string, roots?: ReadonlyArray<string>) =>
  CheckpointStore.CheckpointStore.use((store) => store.isGitRepository(cwd, roots)).pipe(
    Effect.orElseSucceed(() => false),
  );

/** `commitOid` is null when nothing was captured, including when the ref already existed. */
export const captureBaseline = Effect.fn("CheckpointCapture.captureBaseline")(function* (input: {
  readonly cwd: string;
  readonly roots?: ReadonlyArray<string> | undefined;
  readonly checkpointRef: CheckpointRef;
}) {
  const store = yield* CheckpointStore.CheckpointStore;
  if (!(yield* isGitCheckpointable(input.cwd, input.roots))) {
    return { status: "missing" as const, commitOid: null };
  }
  if (yield* store.hasCheckpointRef(input)) {
    return { status: "ready" as const, commitOid: null };
  }
  return yield* capture(store, { ...input, keepExisting: true }).pipe(
    Effect.map((captured) => ({ status: "ready" as const, ...captured })),
    Effect.catchTags({
      VcsUnsupportedOperationError: () =>
        Effect.succeed({ status: "missing" as const, commitOid: null }),
    }),
  );
});

export const captureTurn = Effect.fn("CheckpointCapture.captureTurn")(function* (input: {
  readonly cwd: string;
  readonly roots?: ReadonlyArray<string> | undefined;
  readonly checkpointRef: CheckpointRef;
  readonly previousCheckpointRef: CheckpointRef;
}) {
  const store = yield* CheckpointStore.CheckpointStore;
  const warnings: Array<CheckpointCaptureWarning> = [];
  const warn =
    <A>(kind: CheckpointCaptureWarning["kind"], checkpointRef: CheckpointRef, fallback: A) =>
    (cause: unknown) =>
      Effect.sync(() => {
        warnings.push({ kind, checkpointRef, cause: String(cause) });
        return fallback;
      });
  const finish = (capture: Omit<TurnCapture, "warnings">): TurnCapture => ({
    ...capture,
    warnings,
  });

  if (!(yield* isGitCheckpointable(input.cwd, input.roots))) {
    return finish({ status: "missing", commitOid: null, files: [] });
  }

  const captured = yield* capture(store, {
    cwd: input.cwd,
    roots: input.roots,
    checkpointRef: input.checkpointRef,
  }).pipe(
    Effect.map((result) => ({ status: "ready" as const, ...result })),
    Effect.catchTags({
      VcsUnsupportedOperationError: () =>
        Effect.succeed({ status: "missing" as const, commitOid: null }),
    }),
    Effect.catch(
      warn("capture-failed", input.checkpointRef, { status: "error" as const, commitOid: null }),
    ),
  );
  if (captured.status !== "ready") {
    return finish({ ...captured, files: [] });
  }

  const previousExists = yield* store
    .hasCheckpointRef({
      cwd: input.cwd,
      roots: input.roots,
      checkpointRef: input.previousCheckpointRef,
    })
    .pipe(Effect.catch(warn("previous-ref-lookup-failed", input.previousCheckpointRef, false)));
  const refs = {
    cwd: input.cwd,
    roots: input.roots,
    fromCheckpointRef: input.previousCheckpointRef,
    toCheckpointRef: input.checkpointRef,
  };
  // A pull or rebase can change thousands of files the turn did not write.
  const files = previousExists
    ? yield* Effect.all([
        store.diffCheckpoints({
          ...refs,
          fallbackFromToHead: false,
          ignoreWhitespace: false,
          format: "numstat",
        }),
        store
          .listAuthoredPaths(refs)
          .pipe(Effect.catch(warn("authored-paths-failed", input.checkpointRef, null))),
      ]).pipe(
        Effect.map(([diff, authoredPaths]) =>
          parseTurnDiffFilesFromNumstat(diff)
            .filter((file) => !isGitImport(file, authoredPaths))
            .map((file) => ({
              path: file.path,
              kind: "modified",
              additions: file.additions,
              deletions: file.deletions,
            })),
        ),
        Effect.catch(
          warn(
            "diff-summary-failed",
            input.checkpointRef,
            [] as ReadonlyArray<OrchestrationV2CheckpointFileSummary>,
          ),
        ),
      )
    : [];

  return finish({ ...captured, files });
});
