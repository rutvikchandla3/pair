import {
  type CheckpointRef,
  VcsProcessOutputLimitError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { CheckpointStoreError } from "./Errors.ts";
import { parseTurnDiffFilesFromNumstat } from "./Diffs.ts";
import {
  CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
  type VcsCheckpointOps,
  type VcsDriver,
} from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

/**
 * A workspace thread's folder is not a repository; it holds one repository per root at
 * `<cwd>/<root>`. With `roots`, every operation runs in each of them under the same ref name
 * (each has its own object store) and reports paths as `<root>/<path in that repository>`.
 */
interface WorkspaceRoots {
  readonly roots?: ReadonlyArray<string> | undefined;
}

export interface CaptureCheckpointInput extends WorkspaceRoots {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** Left at HEAD's version: an excluded change or untracked file is not captured. */
  readonly excludePaths?: ReadonlyArray<string>;
  /** With roots: a repository that already holds the ref keeps it. Callers without roots check first. */
  readonly keepExisting?: boolean;
}

export interface RestoreCheckpointInput extends WorkspaceRoots {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput extends WorkspaceRoots {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** Maximum bytes collected from the diff command, across every root. */
  readonly maxOutputBytes?: number;
  /** Limits the diff to these exact paths. An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
}

export interface ListAuthoredPathsInput extends WorkspaceRoots {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface DeleteCheckpointRefsInput extends WorkspaceRoots {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    /** With roots: whether any root is a repository of its own. */
    readonly isGitRepository: (
      cwd: string,
      roots?: ReadonlyArray<string>,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Succeeds with the captured commit oid. With roots, a missing root is skipped, and the oid is
     * the first root's (in root order) that holds the ref afterwards: it names one repository's
     * commit, not the workspace, so only that repository can use it.
     */
    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /** The workspace repositories at `<cwd>/<root>` that are on disk, each read where it is. */
    readonly presentRoots: (
      cwd: string,
      roots: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<PresentRoot>>;

    /** `captureCheckpoint` with roots, reporting each present root's commit (null: not captured). */
    readonly captureRoots: (
      input: CaptureCheckpointInput & { readonly roots: ReadonlyArray<string> },
    ) => Effect.Effect<RootCommits, CheckpointStoreError>;

    /**
     * With roots: every root on disk holds the ref, and at least one root is on disk. A root
     * whose folder is gone holds nothing and is not counted; restore still refuses it.
     */
    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /** With roots, every root must be on disk and hold the ref; false touches nothing. */
    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /** With roots, a root that is missing or lacks either ref contributes nothing. */
    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /**
     * Null means HEAD is unchanged or unrecorded; all changed paths then belong to the turn. With
     * roots, null only when that holds in every root; otherwise a root whose HEAD did not move
     * contributes all of its changed paths.
     */
    readonly listAuthoredPaths: (
      input: ListAuthoredPathsInput,
    ) => Effect.Effect<ReadonlySet<string> | null, CheckpointStoreError>;

    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;
  }
>()("t3/checkpointing/CheckpointStore") {}

export type RootCommits = ReadonlyArray<{
  readonly name: string;
  readonly commitOid: string | null;
}>;

interface RootCheckout {
  readonly name: string;
  readonly cwd: string;
  /** Null when the root's folder is missing or is not its own repository. */
  readonly driver: VcsDriver["Service"] | null;
}

const lastPathSegment = (value: string) => value.split(/[\\/]+/).findLast((part) => part !== "");

/** Paths under `<name>/`, without that prefix; a path under no root matches nothing. */
const pathsUnderRoot = (paths: ReadonlyArray<string>, name: string) =>
  paths.flatMap((entry) => (entry.startsWith(`${name}/`) ? [entry.slice(name.length + 1)] : []));

/** One repository of a workspace thread, where its checkpoint refs live. */
export interface PresentRoot {
  readonly name: string;
  readonly cwd: string;
  readonly checkpoints: VcsCheckpointOps;
}

// A root missing either ref, such as one whose checkout was gone at capture, is left out.
const unlessRefMissing = <A>(
  root: PresentRoot,
  refs: { readonly fromCheckpointRef: CheckpointRef; readonly toCheckpointRef: CheckpointRef },
  operation: Effect.Effect<A, CheckpointStoreError>,
) =>
  operation.pipe(
    Effect.catchTags({
      VcsProcessExitError: Effect.fn("CheckpointStore.unlessRefMissing")(function* (error) {
        const held = yield* Effect.forEach(
          [refs.fromCheckpointRef, refs.toCheckpointRef],
          (checkpointRef) => root.checkpoints.hasCheckpointRef({ cwd: root.cwd, checkpointRef }),
        );
        if (held.every(Boolean)) return yield* error;
        yield* Effect.logWarning("A workspace repository lacks a checkpoint; leaving it out", {
          cwd: root.cwd,
        });
        return null;
      }),
    }),
  );

/** `diffCheckpoints` over a workspace's repositories, wherever their refs are read. */
export const diffRoots = Effect.fn("CheckpointStore.diffRoots")(function* (
  present: ReadonlyArray<PresentRoot>,
  input: DiffCheckpointsInput,
) {
  if (input.filePaths?.length === 0) return "";
  const maxOutputBytes = input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES;
  let output = "";
  let outputBytes = 0;
  for (const root of present) {
    if (outputBytes >= maxOutputBytes) break;
    const filePaths =
      input.filePaths === undefined ? undefined : pathsUnderRoot(input.filePaths, root.name);
    if (filePaths?.length === 0) continue;
    const { roots: _roots, ...rest } = input;
    const diff = yield* unlessRefMissing(
      root,
      input,
      root.checkpoints.diffCheckpoints({
        ...rest,
        cwd: root.cwd,
        pathPrefix: root.name,
        maxOutputBytes: maxOutputBytes - outputBytes,
        ...(filePaths === undefined ? {} : { filePaths }),
      }),
    );
    if (diff === null) continue;
    output += diff;
    outputBytes += Buffer.byteLength(diff);
  }
  if (outputBytes <= maxOutputBytes) return output;
  if (input.format === "numstat") {
    return yield* new VcsProcessOutputLimitError({
      operation: "CheckpointStore.diffCheckpoints",
      command: "git diff",
      cwd: input.cwd,
      stream: "stdout",
      maxBytes: maxOutputBytes,
      observedBytes: outputBytes,
    });
  }
  // Prefixed rename lines can overrun the bytes git was given; drop a split final character.
  return new TextDecoder().decode(Buffer.from(output).subarray(0, maxOutputBytes), {
    stream: true,
  });
});

/** `listAuthoredPaths` over a workspace's repositories, wherever their refs are read. */
export const listAuthoredPathsInRoots = Effect.fn("CheckpointStore.listAuthoredPathsInRoots")(
  function* (present: ReadonlyArray<PresentRoot>, input: ListAuthoredPathsInput) {
    const perRoot = yield* Effect.forEach(
      present,
      (root) =>
        unlessRefMissing(
          root,
          input,
          root.checkpoints
            .listAuthoredPaths({ ...input, cwd: root.cwd })
            .pipe(Effect.map((authored) => ({ root, authored }))),
        ),
      { concurrency: "unbounded" },
    );
    const compared = perRoot.filter((entry) => entry !== null);
    if (compared.every((entry) => entry.authored === null)) return null;
    const authored = new Set<string>();
    for (const entry of compared) {
      if (entry.authored !== null) {
        for (const path of entry.authored) authored.add(`${entry.root.name}/${path}`);
        continue;
      }
      // HEAD did not move in this root, so every change in it is the turn's.
      const numstat = yield* entry.root.checkpoints.diffCheckpoints({
        cwd: entry.root.cwd,
        fromCheckpointRef: input.fromCheckpointRef,
        toCheckpointRef: input.toCheckpointRef,
        ignoreWhitespace: false,
        format: "numstat",
        pathPrefix: entry.root.name,
      });
      for (const file of parseTurnDiffFilesFromNumstat(numstat)) {
        authored.add(file.path);
        if (file.previousPath !== undefined) authored.add(file.previousPath);
      }
    }
    return authored;
  },
);

const resolveRootsWith = Effect.fn("CheckpointStore.resolveRoots")(function* (
  vcsRegistry: VcsDriverRegistry.VcsDriverRegistry["Service"],
  cwd: string,
  roots: ReadonlyArray<string>,
) {
  return yield* Effect.forEach(
    roots,
    (name) => {
      // Root names are single folder names; git and spawn accept "/" on every platform.
      const rootCwd = `${cwd.replace(/[\\/]+$/, "")}/${name}`;
      return vcsRegistry.detect({ cwd: rootCwd, requestedKind: "git" }).pipe(
        // A folder that is not a repository of its own would resolve to any repository enclosing it.
        Effect.map((handle) =>
          handle !== null && lastPathSegment(handle.repository.rootPath) === name
            ? handle.driver
            : null,
        ),
        Effect.orElseSucceed(() => null),
        Effect.tap((driver) =>
          driver === null
            ? Effect.logWarning("A workspace repository is missing; it has no checkpoint", {
                cwd: rootCwd,
              })
            : Effect.void,
        ),
        Effect.map((driver): RootCheckout => ({ name, cwd: rootCwd, driver })),
      );
    },
    { concurrency: "unbounded" },
  );
});

const presentRootsWith = (
  vcsRegistry: VcsDriverRegistry.VcsDriverRegistry["Service"],
  cwd: string,
  roots: ReadonlyArray<string>,
) =>
  resolveRootsWith(vcsRegistry, cwd, roots).pipe(
    Effect.map((checkouts) =>
      checkouts.flatMap(({ name, cwd: rootCwd, driver }) =>
        driver === null ? [] : [{ name, cwd: rootCwd, driver, checkpoints: driver.checkpoints }],
      ),
    ),
  );

/** @public */
export const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const resolveCheckpoints = Effect.fn("CheckpointStore.resolveCheckpoints")(function* (
    cwd: string,
  ) {
    const handle = yield* vcsRegistry.resolve({ cwd });
    return handle.driver.checkpoints satisfies VcsCheckpointOps;
  });

  const resolveRoots = (cwd: string, roots: ReadonlyArray<string>) =>
    resolveRootsWith(vcsRegistry, cwd, roots);
  const presentRoots = (cwd: string, roots: ReadonlyArray<string>) =>
    presentRootsWith(vcsRegistry, cwd, roots);

  const isGitRepository: CheckpointStore["Service"]["isGitRepository"] = (cwd, roots) =>
    roots === undefined
      ? vcsRegistry
          .detect({ cwd, requestedKind: "git" })
          .pipe(Effect.map((repository) => repository !== null))
      : presentRoots(cwd, roots).pipe(Effect.map((present) => present.length > 0));

  const captureRoots: CheckpointStore["Service"]["captureRoots"] = Effect.fn("captureRoots")(
    function* (input) {
      const present = yield* presentRoots(input.cwd, input.roots);
      const commits = yield* Effect.forEach(
        present,
        Effect.fnUntraced(function* (root) {
          if (input.keepExisting === true) {
            const existing = yield* root.driver.execute({
              operation: "CheckpointStore.captureCheckpoint",
              cwd: root.cwd,
              args: ["rev-parse", "--verify", "--quiet", `${input.checkpointRef}^{commit}`],
              allowNonZeroExit: true,
            });
            if (existing.exitCode === 0 && existing.stdout.trim() !== "") {
              return existing.stdout.trim();
            }
          }
          return yield* root.checkpoints
            .captureCheckpoint({
              cwd: root.cwd,
              checkpointRef: input.checkpointRef,
              ...(input.excludePaths === undefined
                ? {}
                : { excludePaths: pathsUnderRoot(input.excludePaths, root.name) }),
            })
            .pipe(
              Effect.catchTags({
                VcsUnsupportedOperationError: (error) =>
                  Effect.logWarning("A workspace repository cannot be checkpointed", {
                    cwd: root.cwd,
                    detail: error.detail,
                  }).pipe(Effect.as(null)),
              }),
            );
        }),
        { concurrency: "unbounded" },
      );
      if (commits.every((commit) => commit === null)) {
        return yield* new VcsUnsupportedOperationError({
          operation: "CheckpointStore.captureCheckpoint",
          kind: "git",
          detail: "No repository in the workspace folder can be checkpointed.",
        });
      }
      return present.map((root, index) => ({ name: root.name, commitOid: commits[index] ?? null }));
    },
  );

  const captureCheckpoint: CheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    const { roots } = input;
    if (roots === undefined) {
      const checkpoints = yield* resolveCheckpoints(input.cwd);
      return yield* checkpoints.captureCheckpoint(input);
    }
    const first = (yield* captureRoots({ ...input, roots })).find(
      (root) => root.commitOid !== null,
    );
    return first?.commitOid ?? (yield* Effect.die("captureRoots captured no repository."));
  });

  const hasCheckpointRef: CheckpointStore["Service"]["hasCheckpointRef"] = Effect.fn(
    "hasCheckpointRef",
  )(function* (input) {
    if (input.roots === undefined) {
      const checkpoints = yield* resolveCheckpoints(input.cwd);
      return yield* checkpoints.hasCheckpointRef(input);
    }
    const present = yield* presentRoots(input.cwd, input.roots);
    if (present.length === 0) return false;
    const held = yield* Effect.forEach(
      present,
      (root) =>
        root.checkpoints.hasCheckpointRef({ cwd: root.cwd, checkpointRef: input.checkpointRef }),
      { concurrency: "unbounded" },
    );
    return held.every(Boolean);
  });

  const restoreCheckpoint: CheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    if (input.roots === undefined) {
      const checkpoints = yield* resolveCheckpoints(input.cwd);
      return yield* checkpoints.restoreCheckpoint(input);
    }
    const checkouts = yield* resolveRoots(input.cwd, input.roots);
    const roots: Array<{ readonly cwd: string; readonly checkpoints: VcsCheckpointOps }> = [];
    for (const { name, cwd, driver } of checkouts) {
      if (driver === null) {
        return yield* new VcsRepositoryDetectionError({
          operation: "CheckpointStore.restoreCheckpoint",
          cwd,
          detail: `Repository ${name}/ is missing from the workspace folder, so no repository was restored.`,
        });
      }
      roots.push({ cwd, checkpoints: driver.checkpoints });
    }
    if (input.fallbackToHead !== true) {
      const held = yield* Effect.forEach(
        roots,
        (root) =>
          root.checkpoints.hasCheckpointRef({ cwd: root.cwd, checkpointRef: input.checkpointRef }),
        { concurrency: "unbounded" },
      );
      const lacking = roots.filter((_root, index) => !held[index]);
      if (lacking.length > 0) {
        yield* Effect.logWarning("Workspace repositories lack the checkpoint to restore", {
          cwds: lacking.map((root) => root.cwd),
        });
        return false;
      }
    }
    // In root order, so a failure's cwd names the repository it stopped at.
    for (const root of roots) {
      if (!(yield* root.checkpoints.restoreCheckpoint({ ...input, cwd: root.cwd }))) return false;
    }
    return true;
  });

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )(function* (input) {
    if (input.roots === undefined) {
      const checkpoints = yield* resolveCheckpoints(input.cwd);
      return yield* checkpoints.diffCheckpoints(input);
    }
    return yield* diffRoots(yield* presentRoots(input.cwd, input.roots), input);
  });

  const listAuthoredPaths: CheckpointStore["Service"]["listAuthoredPaths"] = Effect.fn(
    "listAuthoredPaths",
  )(function* (input) {
    if (input.roots === undefined) {
      const checkpoints = yield* resolveCheckpoints(input.cwd);
      return yield* checkpoints.listAuthoredPaths(input);
    }
    return yield* listAuthoredPathsInRoots(yield* presentRoots(input.cwd, input.roots), input);
  });

  const deleteCheckpointRefs: CheckpointStore["Service"]["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    if (input.roots === undefined) {
      const checkpoints = yield* resolveCheckpoints(input.cwd);
      return yield* checkpoints.deleteCheckpointRefs(input);
    }
    yield* Effect.forEach(
      yield* presentRoots(input.cwd, input.roots),
      (root) =>
        root.checkpoints.deleteCheckpointRefs({
          cwd: root.cwd,
          checkpointRefs: input.checkpointRefs,
        }),
      { concurrency: "unbounded", discard: true },
    );
  });

  return CheckpointStore.of({
    isGitRepository,
    presentRoots,
    captureCheckpoint,
    captureRoots,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    listAuthoredPaths,
    deleteCheckpointRefs,
  });
});

export const layer = Layer.effect(CheckpointStore, make);
