import type { OrchestrationV2ThreadShell, ProjectRoot } from "@t3tools/contracts";
import {
  flattenTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  WORKTREE_BRANCH_PREFIX,
} from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { resolveWorktreesDirectory, worktreeDirectoryName } from "../worktreePaths.ts";
import * as ProjectService from "./ProjectService.ts";
import { WORKSPACE_GUIDANCE_FILES, workspaceGuidanceText } from "./workspaceGuidance.ts";

export class WorkspaceCheckoutError extends Schema.TaggedError<WorkspaceCheckoutError>()(
  "WorkspaceCheckoutError",
  {
    operation: Schema.Literals(["create", "remove", "rename-branch", "write-guidance"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** The root whose checkout `cwd` is in a workspace thread's folder. */
export function workspaceRootAt(
  thread: Pick<OrchestrationV2ThreadShell, "roots" | "worktreePath">,
  cwd: string,
  path: Path.Path,
): ProjectRoot | undefined {
  const { roots, worktreePath } = thread;
  if (roots === undefined || worktreePath === null) return undefined;
  const target = path.resolve(cwd);
  return roots.find((root) => path.resolve(worktreePath, root.name) === target);
}

export interface WorkspaceCheckout {
  readonly folder: string;
  readonly roots: ReadonlyArray<ProjectRoot>;
  readonly branch: string | null;
}

/**
 * A workspace thread's folder: one worktree per root at `<folder>/<name>`, all on one branch.
 * The folder itself is not a repository.
 */
export class WorkspaceCheckouts extends Context.Service<
  WorkspaceCheckouts,
  {
    /** Removes everything it made when it fails or is interrupted. */
    readonly create: (input: {
      readonly workspaceRoot: string;
      readonly roots: ReadonlyArray<ProjectRoot>;
      readonly branch: string;
      readonly startFromOrigin: boolean;
      readonly onCheckoutProgress?: (percent: number) => Effect.Effect<void>;
    }) => Effect.Effect<
      { readonly folder: string; readonly branch: string },
      WorkspaceCheckoutError
    >;
    /**
     * `git worktree remove` per root through that root's repository, its branch, then the folder.
     * Forced unless `force` is false, when git refuses a checkout with changes.
     */
    readonly remove: (
      checkout: WorkspaceCheckout,
      options?: { readonly force?: boolean },
    ) => Effect.Effect<void, WorkspaceCheckoutError>;
    /**
     * Removes a thread folder a client names by its project's folder, keeping branches as a
     * single-repository worktree removal does. Uses the roots of the threads that own the folder,
     * else the project's. False when that project is not a workspace.
     */
    readonly removeFolder: (input: {
      readonly workspaceRoot: string;
      readonly folder: string;
    }) => Effect.Effect<boolean, WorkspaceCheckoutError>;
    /** Writes the folder's AGENTS.md and CLAUDE.md, keeping any that already exist. */
    readonly writeGuidance: (input: {
      readonly folder: string;
      readonly roots: ReadonlyArray<ProjectRoot>;
    }) => Effect.Effect<void, WorkspaceCheckoutError>;
    /** Renames the branch in every root; a name taken in one root renames none. */
    readonly renameBranch: (input: {
      readonly folder: string;
      readonly roots: ReadonlyArray<ProjectRoot>;
      readonly oldBranch: string;
      readonly newBranch: string;
      readonly exactName?: boolean;
    }) => Effect.Effect<{ readonly branch: string }, WorkspaceCheckoutError>;
  }
>()("t3/project/WorkspaceCheckouts") {}

const make = Effect.gen(function* () {
  const git = yield* GitWorkflow.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const digest = yield* Digest.Digest;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

  const failure =
    (operation: WorkspaceCheckoutError["operation"], detail: string) => (cause: unknown) =>
      new WorkspaceCheckoutError({ operation, detail, cause });

  // Deleted root projects still own their repositories' worktree records.
  const rootRepositories = Effect.fn("WorkspaceCheckouts.rootRepositories")(function* (
    roots: ReadonlyArray<ProjectRoot>,
  ) {
    return yield* Effect.forEach(roots, (root) =>
      projects.getById(root.projectId, { includeDeleted: true }).pipe(
        Effect.map((project) => ({
          root,
          project: Option.getOrUndefined(project),
        })),
      ),
    );
  });

  const resolveBase = Effect.fn("WorkspaceCheckouts.resolveBase")(function* (
    repository: string,
    startFromOrigin: boolean,
  ) {
    const name =
      (yield* git.defaultBranch(repository).pipe(Effect.orElseSucceed(() => null))) ??
      (yield* git.currentBranch(repository).pipe(Effect.orElseSucceed(() => null)));
    if (name === null) return { refName: "HEAD" };
    if (startFromOrigin) {
      const remote = yield* git.resolveWorktreeBaseRemote({ cwd: repository, refName: name });
      if (remote !== null) {
        const fetched = yield* git.fetchWorktreeBaseCommit({
          cwd: repository,
          refName: name,
          remote,
        });
        if (fetched !== null) {
          return {
            refName: fetched.commitSha,
            baseRefName: `refs/remotes/${fetched.remoteRefName}`,
          };
        }
      }
    }
    if (yield* git.hasCommit({ cwd: repository, refName: `refs/heads/${name}` })) {
      return { refName: name, baseRefName: name };
    }
    const tracking = `refs/remotes/origin/${name}`;
    if (yield* git.hasCommit({ cwd: repository, refName: tracking })) {
      return { refName: tracking, baseRefName: tracking };
    }
    return { refName: "HEAD" };
  });

  const writeGuidanceFiles = Effect.fn("WorkspaceCheckouts.writeGuidanceFiles")(function* (
    folder: string,
    roots: ReadonlyArray<{ readonly name: string; readonly title: string }>,
  ) {
    const text = workspaceGuidanceText({ roots });
    for (const file of WORKSPACE_GUIDANCE_FILES) {
      yield* fileSystem.writeFileString(path.join(folder, file), text, { flag: "wx" }).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.void,
        ),
      );
    }
  });

  const removeRoot = Effect.fn("WorkspaceCheckouts.removeRoot")(function* (
    repository: string | undefined,
    worktreePath: string,
    branch: string | null,
    force: boolean,
  ) {
    if (repository === undefined) {
      yield* fileSystem.remove(worktreePath, { recursive: true, force: true });
      return;
    }
    if (yield* fileSystem.exists(worktreePath)) {
      yield* git.removeWorktree({ cwd: repository, path: worktreePath, force });
    } else {
      yield* git.pruneWorktrees({ cwd: repository });
    }
    if (branch !== null) {
      yield* git
        .deleteLocalBranch({ cwd: repository, refName: branch, force: true })
        .pipe(Effect.ignoreCause({ log: true }));
    }
  });

  const remove: WorkspaceCheckouts["Service"]["remove"] = Effect.fn("WorkspaceCheckouts.remove")(
    function* (checkout, options) {
      const repositories = yield* rootRepositories(checkout.roots).pipe(
        Effect.mapError(failure("remove", "Failed to read the workspace's repositories.")),
      );
      const failed: Array<string> = [];
      for (const { root, project } of repositories) {
        yield* removeRoot(
          project?.workspaceRoot,
          path.join(checkout.folder, root.name),
          checkout.branch,
          options?.force ?? true,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to remove a workspace repository checkout", {
              folder: checkout.folder,
              root: root.name,
              cause,
            }).pipe(Effect.andThen(Effect.sync(() => failed.push(root.name)))),
          ),
        );
      }
      // A checkout git could not remove keeps its folder, so no work is deleted behind git's back.
      if (failed.length > 0) {
        return yield* new WorkspaceCheckoutError({
          operation: "remove",
          detail: `Failed to remove ${failed.map((name) => `${name}/`).join(", ")} from ${checkout.folder}.`,
        });
      }
      yield* fileSystem
        .remove(checkout.folder, { recursive: true, force: true })
        .pipe(Effect.mapError(failure("remove", `Failed to remove ${checkout.folder}.`)));
    },
  );

  const removeFolder: WorkspaceCheckouts["Service"]["removeFolder"] = Effect.fn(
    "WorkspaceCheckouts.removeFolder",
  )(function* (input) {
    const project = yield* projects
      .getByWorkspaceRoot(input.workspaceRoot, { includeDeleted: true })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(project) || project.value.roots === undefined) return false;
    if (!(yield* isManagedWorktreePath(input.folder))) {
      return yield* new WorkspaceCheckoutError({
        operation: "remove",
        detail: `${input.folder} is not a workspace thread's folder.`,
      });
    }
    // Roots edited after the thread started name repositories its folder does not hold.
    const roots =
      (yield* projections.getWorktreeRoots(input.folder).pipe(Effect.orElseSucceed(() => null))) ??
      project.value.roots;
    yield* remove({ folder: input.folder, roots, branch: null });
    return true;
  });

  const create: WorkspaceCheckouts["Service"]["create"] = Effect.fn("WorkspaceCheckouts.create")(
    function* (input) {
      const createError = (detail: string) => failure("create", detail);
      const repositories = yield* rootRepositories(input.roots).pipe(
        Effect.mapError(createError("Failed to read the workspace's repositories.")),
      );
      const resolved: Array<{
        readonly root: ProjectRoot;
        readonly repository: string;
        readonly title: string;
      }> = [];
      for (const { root, project } of repositories) {
        if (project === undefined || project.deletedAt !== null) {
          return yield* new WorkspaceCheckoutError({
            operation: "create",
            detail: `Repository ${root.name}/ belongs to a project that no longer exists. Edit the workspace's repositories.`,
          });
        }
        resolved.push({ root, repository: project.workspaceRoot, title: project.title });
      }
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(createError("Failed to read the worktree location setting.")),
      );
      const parent = resolveWorktreesDirectory(
        settings.worktreesDirectory,
        config.worktreesDir,
        path,
        yield* HostProcess.HomeDirectory,
      );
      if (parent === null) {
        return yield* new WorkspaceCheckoutError({
          operation: "create",
          detail: `The worktree location "${settings.worktreesDirectory}" must be an absolute folder on this machine, not a drive root. Change it in Settings → Worktrees.`,
        });
      }
      let branch = input.branch;
      // One name across roots: flatten when any root already has a branch named like the prefix.
      if (isTemporaryWorktreeBranch(branch)) {
        for (const { repository } of resolved) {
          const blocked = yield* git
            .hasCommit({ cwd: repository, refName: `refs/heads/${WORKTREE_BRANCH_PREFIX}` })
            .pipe(Effect.orElseSucceed(() => false));
          if (blocked) {
            branch = flattenTemporaryWorktreeBranchName(branch);
            break;
          }
        }
      }
      const workspaceFolder = path.join(parent, path.basename(input.workspaceRoot));
      const folder = path.join(
        workspaceFolder,
        yield* worktreeDirectoryName(branch).pipe(Effect.provideService(Digest.Digest, digest)),
      );
      yield* fileSystem
        .makeDirectory(workspaceFolder, { recursive: true })
        .pipe(Effect.mapError(createError(`Failed to create ${workspaceFolder}.`)));
      yield* fileSystem
        .makeDirectory(folder)
        .pipe(
          Effect.mapError(
            createError(`Failed to create ${folder}. A folder for this branch may already exist.`),
          ),
        );

      const created: Array<ProjectRoot> = [];
      let createdBranch: string | null = null;
      return yield* Effect.gen(function* () {
        for (const { root, repository } of resolved) {
          const base = yield* resolveBase(repository, input.startFromOrigin).pipe(
            Effect.mapError(
              createError(`Failed to find the default branch of ${root.name}/ (${repository}).`),
            ),
          );
          yield* git
            .createWorktree(
              {
                cwd: repository,
                refName: base.refName,
                newRefName: branch,
                ...(base.baseRefName === undefined ? {} : { baseRefName: base.baseRefName }),
                path: path.join(folder, root.name),
              },
              {
                progress: {
                  onWorktreeClaimed: () =>
                    Effect.sync(() => {
                      created.push(root);
                      createdBranch = branch;
                    }),
                  ...(input.onCheckoutProgress === undefined
                    ? {}
                    : {
                        onCheckoutProgress: (progress) =>
                          input.onCheckoutProgress!(progress.percent),
                      }),
                },
              },
            )
            .pipe(
              Effect.mapError(
                createError(`Failed to create the ${root.name}/ worktree from ${repository}.`),
              ),
            );
          if (!created.includes(root)) created.push(root);
        }
        yield* writeGuidanceFiles(
          folder,
          resolved.map(({ root, title }) => ({ name: root.name, title })),
        ).pipe(Effect.mapError(createError(`Failed to write the agent guidance in ${folder}.`)));
        return { folder, branch };
      }).pipe(
        Effect.onError(() =>
          remove({ folder, roots: created, branch: createdBranch }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to remove a partly created workspace checkout", {
                folder,
                cause,
              }),
            ),
          ),
        ),
      );
    },
  );

  const writeGuidance: WorkspaceCheckouts["Service"]["writeGuidance"] = Effect.fn(
    "WorkspaceCheckouts.writeGuidance",
  )(function* (input) {
    const guidanceError = failure(
      "write-guidance",
      `Failed to write the agent guidance in ${input.folder}.`,
    );
    const repositories = yield* rootRepositories(input.roots).pipe(Effect.mapError(guidanceError));
    yield* writeGuidanceFiles(
      input.folder,
      repositories.map(({ root, project }) => ({
        name: root.name,
        title: project?.title ?? root.name,
      })),
    ).pipe(Effect.mapError(guidanceError));
  });

  const renameBranch: WorkspaceCheckouts["Service"]["renameBranch"] = Effect.fn(
    "WorkspaceCheckouts.renameBranch",
  )(function* (input) {
    const renameError = (detail: string) => failure("rename-branch", detail);
    const [first, ...rest] = input.roots;
    if (first === undefined) return { branch: input.oldBranch };
    const cwdFor = (root: ProjectRoot) => path.join(input.folder, root.name);
    const renamed = yield* git
      .renameBranch({
        cwd: cwdFor(first),
        oldBranch: input.oldBranch,
        newBranch: input.newBranch,
        ...(input.exactName === true ? { exactName: true } : {}),
      })
      .pipe(Effect.mapError(renameError(`Failed to rename the branch in ${first.name}/.`)));
    const done: Array<ProjectRoot> = [first];
    for (const root of rest) {
      const result = yield* Effect.result(
        git.renameBranch({
          cwd: cwdFor(root),
          oldBranch: input.oldBranch,
          newBranch: renamed.branch,
          exactName: true,
        }),
      );
      if (result._tag === "Success") {
        done.push(root);
        continue;
      }
      for (const undo of done) {
        yield* git
          .renameBranch({
            cwd: cwdFor(undo),
            oldBranch: renamed.branch,
            newBranch: input.oldBranch,
            exactName: true,
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }
      return yield* renameError(
        `Branch ${renamed.branch} is already taken in ${root.name}/, so no repository was renamed.`,
      )(result.failure);
    }
    return renamed;
  });

  return WorkspaceCheckouts.of({ create, remove, removeFolder, writeGuidance, renameBranch });
});

export const layer = Layer.effect(WorkspaceCheckouts, make);
