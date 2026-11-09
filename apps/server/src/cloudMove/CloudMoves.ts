import {
  CommandId,
  CloudStagingKey,
  type MemberId,
  type ProjectId,
  repositoryGroupingKeyOf,
  ThreadMoveError,
  type ThreadMoveToLocalInput,
  type ThreadMoveToLocalResult,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as CloudMoveClient from "./CloudMoveClient.ts";

/** The default branch tip, then recent local branches: a round trip then sends only new commits. */
const RECENT_BRANCH_HAVES = 31;
const MAX_BRANCH_SUFFIX = 100;
const REPORT_RETRY = Schedule.spaced("2 seconds");
const UNREPORTED_NOTICE =
  "Pair Cloud didn't record this move, so the cloud thread there stays as it was and doesn't link here.";

/**
 * Moves between this server and Pair Cloud over the agent link. Continue locally pulls a cloud
 * thread's branch, uncommitted files and conversation into a new local thread.
 */
export class CloudMoves extends Context.Service<
  CloudMoves,
  {
    readonly continueLocally: (
      input: ThreadMoveToLocalInput & { readonly actorId?: MemberId | undefined },
    ) => Effect.Effect<ThreadMoveToLocalResult, ThreadMoveError>;
  }
>()("t3/cloudMove/CloudMoves") {}

const failed = (message: string) => () => new ThreadMoveError({ reason: "failed", message });

const make = Effect.gen(function* () {
  const client = yield* CloudMoveClient.CloudMoveClient;
  const { cloudOnly, stateDir } = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const projects = yield* ProjectService.ProjectService;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const git = yield* GitWorkflow.GitWorkflowService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const projectLocks = yield* KeyedLock.make<ProjectId>();

  const run = (cwd: string, args: ReadonlyArray<string>, allowNonZeroExit = false) =>
    gitDriver.execute({ operation: "CloudMoves.git", cwd, args, allowNonZeroExit });

  /** Stable across the method's own retries, so Pair Cloud records each move once. */
  const moveIdFor = (commandId: CommandId) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(commandId))
      .pipe(Effect.map((hash) => CloudStagingKey.make(`mv_${Hex.encode(hash).slice(0, 32)}`)));

  const readHaves = Effect.fn("CloudMoves.readHaves")(function* (root: string) {
    const [originHead, branches] = yield* Effect.all([
      run(root, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD^{commit}"], true),
      run(root, [
        "for-each-ref",
        "--sort=-committerdate",
        `--count=${RECENT_BRANCH_HAVES}`,
        "--format=%(objectname)",
        "refs/heads",
      ]),
    ]);
    const oids = [
      ...(originHead.exitCode === 0 ? [originHead.stdout.trim()] : []),
      ...branches.stdout.split("\n").map((line) => line.trim()),
    ];
    return [...new Set(oids.filter((oid) => oid !== ""))];
  });

  /** The first free name: a local branch, or for a copy also origin's, makes the next suffix. */
  const freeBranchName = Effect.fn("CloudMoves.freeBranchName")(function* (
    root: string,
    base: string,
    copy: boolean,
  ) {
    for (let suffix = 1; suffix <= MAX_BRANCH_SUFFIX; suffix++) {
      const name = suffix === 1 ? base : `${base}-${suffix}`;
      const local = yield* run(
        root,
        ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`],
        true,
      );
      if (local.exitCode === 0) continue;
      // A move's own branch is usually on origin already: it is the same branch.
      if (
        copy &&
        (yield* git.remoteBranchExists({ cwd: root, remoteName: "origin", refName: name }))
      ) {
        continue;
      }
      return name;
    }
    return yield* failed(
      `Every branch name from ${base} to ${base}-${MAX_BRANCH_SUFFIX} is taken.`,
    )();
  });

  const deleteRefsUnder = (root: string, prefix: string) =>
    run(root, ["for-each-ref", "--format=delete %(refname)", prefix]).pipe(
      Effect.flatMap(({ stdout }) =>
        stdout.trim() === ""
          ? Effect.void
          : gitDriver
              .execute({
                operation: "CloudMoves.deleteRefs",
                cwd: root,
                args: ["update-ref", "--stdin"],
                stdin: stdout,
              })
              .pipe(Effect.asVoid),
      ),
      Effect.ignore,
    );

  const continueLocally: CloudMoves["Service"]["continueLocally"] = Effect.fn(
    "CloudMoves.continueLocally",
  )(function* (input) {
    if (cloudOnly) {
      return yield* new ThreadMoveError({
        reason: "unsupported",
        message: "Continue locally from Pair on your own computer.",
      });
    }
    const project = Option.getOrUndefined(
      yield* projects
        .getShell(input.projectId)
        .pipe(Effect.mapError(failed("Couldn't read the project here."))),
    );
    if (project === undefined) return yield* failed("This project isn't on this computer.")();
    const root = project.workspaceRoot;
    const originKey =
      project.repositoryIdentity == null
        ? null
        : repositoryGroupingKeyOf(project.repositoryIdentity);
    const moveId = yield* moveIdFor(input.commandId);
    const { environmentId: cloudEnvironmentId, threadId: cloudThreadId } = input.source;

    // Small, and refuses a busy thread before any bundle is made.
    const contextExport = yield* client.contextExport({
      environmentId: cloudEnvironmentId,
      threadId: cloudThreadId,
    });
    const haves = yield* readHaves(root).pipe(
      Effect.mapError(failed("Couldn't read this project's branches.")),
    );

    const dir = path.join(stateDir, "cloud-moves");
    yield* fs
      .makeDirectory(dir, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(failed("Couldn't prepare the download.")));
    const file = path.join(dir, `${moveId}.bundle`);
    const tempPrefix = `refs/t3/moves/${moveId}/`;

    const { facts, written } = yield* client.downloadSeed({
      environmentId: cloudEnvironmentId,
      threadId: cloudThreadId,
      haves,
      file,
      check: (facts) =>
        originKey !== null && facts.origin.toLowerCase() === originKey.toLowerCase()
          ? Effect.void
          : Effect.fail(
              new ThreadMoveError({
                reason: "project-mismatch",
                message: `The cloud thread's origin, ${facts.origin}, doesn't match this project's.`,
              }),
            ),
    });
    const copy = facts.mode === "copy";

    const local = yield* projectLocks
      .withLock(
        input.projectId,
        Effect.gen(function* () {
          if (written) {
            yield* run(root, [
              "fetch",
              "--quiet",
              "--no-tags",
              "--no-write-fetch-head",
              file,
              `+refs/*:${tempPrefix}*`,
            ]).pipe(Effect.mapError(failed("Couldn't read the cloud thread's branch.")));
          }
          for (const oid of [facts.head, ...(facts.snapshot === null ? [] : [facts.snapshot])]) {
            const present = yield* run(root, ["cat-file", "-e", `${oid}^{commit}`], true).pipe(
              Effect.mapError(failed("Couldn't read the cloud thread's branch.")),
            );
            if (present.exitCode !== 0) {
              return yield* failed("The download is missing the thread's commits. Try again.")();
            }
          }
          const branch = yield* freeBranchName(
            root,
            copy ? `${facts.branch}-copy` : facts.branch,
            copy,
          ).pipe(
            Effect.catchTags({
              GitCommandError: failed("Couldn't check this project's branches."),
            }),
          );
          // From an oid, so the branch tracks nothing: a copy never pushes to the session's branch.
          const { worktree } = yield* git
            .createWorktree({
              cwd: root,
              refName: facts.head,
              newRefName: branch,
              ...(facts.baseRef === null ? {} : { baseRefName: facts.baseRef }),
              path: null,
            })
            .pipe(
              Effect.mapError((error) => failed(`Couldn't create a worktree: ${error.message}`)()),
            );
          const undo = Effect.all(
            [
              git.removeWorktree({ cwd: root, path: worktree.path, force: true }),
              git.deleteLocalBranch({ cwd: root, refName: branch, force: true }),
            ],
            { discard: true },
          ).pipe(Effect.ignore);

          return yield* Effect.gen(function* () {
            if (facts.snapshot !== null) {
              // Uncommitted files land unstaged and untracked ones untracked (2.13).
              yield* run(worktree.path, ["read-tree", "--reset", "-u", facts.snapshot]);
              yield* run(worktree.path, ["reset", "--quiet"]);
            }
            const launched = yield* launches.launch({
              commandId: CommandId.make(`move:${moveId}`),
              projectId: input.projectId,
              title: contextExport.source.title,
              modelSelection: input.modelSelection,
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              workspaceStrategy: { type: "existing_worktree", worktreePath: worktree.path, branch },
              contextExport: { value: contextExport, ...(copy ? { copy: true as const } : {}) },
              createdBy: "user",
              creationSource: "web",
              ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
            });
            return { threadId: launched.threadId, branch };
          }).pipe(
            Effect.mapError((error) =>
              failed(
                error._tag === "GitCommandError"
                  ? "Couldn't put the machine's uncommitted changes in the worktree."
                  : `Couldn't start the local thread: ${error.message}`,
              )(),
            ),
            Effect.onError(() => undo),
          );
        }).pipe(Effect.ensuring(deleteRefsUnder(root, tempPrefix))),
      )
      .pipe(Effect.ensuring(fs.remove(file, { force: true }).pipe(Effect.ignore)));

    const descriptor = yield* environment.getDescriptor;
    const reported = yield* client
      .reportContinued({
        environmentId: cloudEnvironmentId,
        threadId: cloudThreadId,
        body: {
          moveId,
          thread: { environmentId: descriptor.environmentId, threadId: local.threadId },
          environmentLabel: descriptor.label.trim().slice(0, 120),
          copy,
        },
      })
      .pipe(
        Effect.retry({ times: 2, schedule: REPORT_RETRY }),
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Pair Cloud didn't record a move", {
            moveId,
            error: error.message,
          }).pipe(
            Effect.andThen(
              threads.dispatch({
                type: "thread.notice.record",
                commandId: CommandId.make(`move:${moveId}:unreported`),
                threadId: local.threadId,
                message: UNREPORTED_NOTICE,
              }),
            ),
            Effect.ignore,
            Effect.as(false),
          ),
        ),
      );
    return { threadId: local.threadId, branch: local.branch, copy, reported };
  });

  return CloudMoves.of({ continueLocally });
});

export const layer = Layer.effect(CloudMoves, make);
