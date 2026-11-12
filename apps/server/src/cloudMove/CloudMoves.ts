import {
  CheckpointRef,
  CLOUD_SEED_MAX_BYTES,
  cloudSeedRefs,
  CommandId,
  CloudStagingKey,
  type CloudMoveLaunchInput,
  type EnvironmentId,
  type MemberId,
  type OrchestrationV2CreationSource,
  type ProjectId,
  ProviderDriverKind,
  type RepositoryIdentity,
  repositoryGroupingKeyOf,
  type RunId,
  type ThreadId,
  ThreadMoveError,
  type ThreadMovePreview,
  type ThreadMovePreviewInput,
  type ThreadMoveToCloudResult,
  type ThreadMoveToLocalInput,
  type ThreadMoveToLocalResult,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ContextExports from "../orchestration-v2/ContextExports.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as CloudMoveClient from "./CloudMoveClient.ts";

/** The default branch tip, then recent local branches: a round trip then sends only new commits. */
const RECENT_BRANCH_HAVES = 31;
const MAX_BRANCH_SUFFIX = 100;
const REPORT_RETRY = Schedule.spaced("2 seconds");
const UNREPORTED_NOTICE =
  "Pair Cloud didn't record this move, so the cloud thread there stays as it was and doesn't link here.";

/** The preview lists this many changed files at most. */
const MOVE_PREVIEW_FILE_LIMIT = 2_000;
const RUN_ACTIVE_MESSAGE = "Wait for the turn to end, or stop it.";
const NO_PAIR_CLOUD_MESSAGE = "No Pair Cloud is linked here. Link one in Settings → Environments.";

export interface ContinueInCloudInput {
  readonly threadId: ThreadId;
  /** Omitted by the agent tool: the one Pair Cloud linked here. */
  readonly cloudEnvironmentId?: EnvironmentId | undefined;
  readonly cloudProjectId?: ProjectId | undefined;
  readonly excludePaths: ReadonlyArray<string>;
  readonly message: string;
  readonly createdBy: "user" | "agent";
  readonly creationSource: OrchestrationV2CreationSource;
  /** The calling agent's own run, which may move its own thread mid-turn. */
  readonly allowRunId?: RunId | undefined;
  readonly actorId?: MemberId | undefined;
}

/**
 * Moves between this server and Pair Cloud over the agent link. Continue locally pulls a cloud
 * thread's branch, uncommitted files and conversation into a new local thread; Continue in cloud
 * sends a local thread's the other way.
 */
export class CloudMoves extends Context.Service<
  CloudMoves,
  {
    readonly continueLocally: (
      input: ThreadMoveToLocalInput & { readonly actorId?: MemberId | undefined },
    ) => Effect.Effect<ThreadMoveToLocalResult, ThreadMoveError>;
    readonly preview: (
      input: ThreadMovePreviewInput,
    ) => Effect.Effect<ThreadMovePreview, ThreadMoveError>;
    /** One move per thread: a call while one runs joins it, and a closed client doesn't stop it. */
    readonly continueInCloud: (
      input: ContinueInCloudInput,
    ) => Effect.Effect<ThreadMoveToCloudResult, ThreadMoveError>;
  }
>()("t3/cloudMove/CloudMoves") {}

const failed = (message: string) => () => new ThreadMoveError({ reason: "failed", message });
const WORKSPACE_MESSAGE = "A workspace thread can't move between a Mac and Pair Cloud yet.";
const refused = (reason: ThreadMoveError["reason"], message: string) =>
  new ThreadMoveError({ reason, message });
const seedFailed = () => refused("seed-failed", CloudMoveClient.SEED_FAILED_MESSAGE);
const stripSlash = (entry: string) => entry.replace(/\/+$/, "");

const originKeyOf = (project: {
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}) =>
  project.repositoryIdentity == null ? null : repositoryGroupingKeyOf(project.repositoryIdentity);

const make = Effect.gen(function* () {
  const client = yield* CloudMoveClient.CloudMoveClient;
  const links = yield* PeerLinks.PeerLinks;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const contextExports = yield* ContextExports.ContextExports;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
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
        .getResolvedShell(input.projectId)
        .pipe(Effect.mapError(failed("Couldn't read the project here."))),
    );
    if (project === undefined) return yield* failed("This project isn't on this computer.")();
    if (project.roots !== undefined) {
      return yield* new ThreadMoveError({ reason: "unsupported", message: WORKSPACE_MESSAGE });
    }
    const root = project.workspaceRoot;
    const originKey = originKeyOf(project);
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

  // Not `cloud-moves/`: a cloud-only server stages uploads there.
  const seedDir = path.join(stateDir, "cloud-move-seeds");
  if (!cloudOnly) yield* fs.remove(seedDir, { recursive: true, force: true }).pipe(Effect.ignore);

  const hasRef = (cwd: string, ref: string) =>
    run(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], true).pipe(
      Effect.map((result) => result.exitCode === 0),
    );

  const readThread = Effect.fn("CloudMoves.readThread")(function* (threadId: ThreadId) {
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError(failed("Couldn't read this thread.")));
    if (shell === null || shell.deletedAt !== null) {
      return yield* failed("This thread no longer exists.")();
    }
    if (cloudOnly || shell.sandboxId !== undefined) {
      return yield* refused("cloud-thread", "This thread already runs in the cloud.");
    }
    const project = Option.getOrUndefined(
      yield* projects
        .getResolvedShell(shell.projectId)
        .pipe(Effect.mapError(failed("Couldn't read the project here."))),
    );
    if (project === undefined) return yield* failed("This thread's project is gone.")();
    if (project.roots !== undefined || shell.roots !== undefined) {
      return yield* new ThreadMoveError({ reason: "unsupported", message: WORKSPACE_MESSAGE });
    }
    return { shell, project, cwd: shell.worktreePath ?? project.workspaceRoot };
  });

  /** The recorded base when origin has it, else origin's default branch. Without `origin/`. */
  const resolveBase = Effect.fn("CloudMoves.resolveBase")(function* (cwd: string, branch: string) {
    const recorded = yield* gitDriver
      .readBranchBase(cwd, branch)
      .pipe(Effect.orElseSucceed(() => null));
    const named = recorded?.replace(/^origin\//, "");
    if (named && (yield* hasRef(cwd, `refs/remotes/origin/${named}`))) return named;
    const fallback = yield* gitDriver
      .resolveDefaultBranchName(cwd, "origin")
      .pipe(Effect.orElseSucceed(() => null));
    if (fallback !== null && (yield* hasRef(cwd, `refs/remotes/origin/${fallback}`))) {
      return fallback;
    }
    return yield* refused(
      "no-base",
      "Can't find origin's default branch on this computer. Fetch origin, then try again.",
    );
  });

  const readCheckout = Effect.fn("CloudMoves.readCheckout")(function* (cwd: string) {
    const status = yield* gitDriver
      .statusDetailsLocal(cwd)
      .pipe(Effect.mapError(failed("Couldn't read this thread's folder.")));
    if (!status.isRepo) {
      return yield* refused("no-repository", "This thread's folder isn't a Git repository.");
    }
    const branch = status.branch;
    if (branch === null) {
      return yield* refused(
        "no-branch",
        "This thread isn't on a branch. Check one out, then try again.",
      );
    }
    const base = yield* resolveBase(cwd, branch).pipe(
      Effect.catchTags({ GitCommandError: failed("Couldn't read this thread's branches.") }),
    );
    return {
      status,
      branch,
      base,
      pushed: status.upstreamRef === `origin/${branch}` && status.aheadCount === 0,
    };
  });

  const linkMessages = Effect.gen(function* () {
    const here = (yield* environment.getDescriptor).label;
    return {
      missing: `Link ${here} to Pair Cloud first.`,
      expired: (label: string) => `The link to ${label} expired. Link it again.`,
    };
  });

  const inflight = yield* SynchronizedRef.make(
    new Map<ThreadId, Deferred.Deferred<ThreadMoveToCloudResult, ThreadMoveError>>(),
  );

  const preview: CloudMoves["Service"]["preview"] = Effect.fn("CloudMoves.preview")(
    function* (input) {
      const { cwd } = yield* readThread(input.threadId);
      const checkout = yield* readCheckout(cwd);
      const commits = yield* gitDriver
        .getReviewBranchCommits({ cwd, baseRef: `origin/${checkout.base}` })
        .pipe(Effect.mapError(failed("Couldn't read this thread's commits.")));
      const messages = yield* linkMessages;
      const stored = yield* links
        .get(input.cloudEnvironmentId)
        .pipe(Effect.mapError(failed("Couldn't read this computer's links.")));
      const now = yield* DateTime.now;
      const link: ThreadMovePreview["link"] = Option.match(stored, {
        onNone: () => ({ status: "missing", message: messages.missing }),
        onSome: (peer) =>
          DateTime.isLessThanOrEqualTo(peer.expiresAt, now)
            ? { status: "expired", message: messages.expired(peer.label) }
            : { status: "linked" },
      });
      const files = checkout.status.workingTree.files;
      return {
        branch: checkout.branch,
        baseRef: checkout.base,
        pushed: checkout.pushed,
        commits: commits.commits.map(({ sha, subject }) => ({ sha, subject })),
        commitsTruncated: commits.truncated,
        files: files.slice(0, MOVE_PREVIEW_FILE_LIMIT),
        filesTruncated: files.length > MOVE_PREVIEW_FILE_LIMIT,
        link,
        moving: (yield* SynchronizedRef.get(inflight)).has(input.threadId),
      };
    },
  );

  /** The given Pair Cloud, or the one linked here that takes moves. */
  const resolveLink = Effect.fn("CloudMoves.resolveLink")(function* (
    environmentId: EnvironmentId | undefined,
  ) {
    const messages = yield* linkMessages;
    const resolveOne = (id: EnvironmentId) =>
      links.resolve(id).pipe(
        Effect.mapError((error) =>
          error.reason === "unknown_link"
            ? refused("not-linked", messages.missing)
            : refused("link-failed", error.message),
        ),
        Effect.filterOrFail(
          (resolved) => resolved.capabilities.cloudImport === true,
          (resolved) =>
            refused(
              "unsupported",
              `${resolved.link.label} needs an update to move threads. Ask an admin.`,
            ),
        ),
      );
    if (environmentId !== undefined) return yield* resolveOne(environmentId);
    const candidates = [...(yield* links.agentLinks)];
    if (candidates.length === 1) return yield* resolveOne(candidates[0]!);
    const usable = (yield* Effect.forEach(candidates, (id) =>
      Effect.option(resolveOne(id)),
    )).flatMap((resolved) => (Option.isSome(resolved) ? [resolved.value] : []));
    if (usable.length === 1) return usable[0]!;
    if (usable.length === 0) return yield* refused("not-linked", NO_PAIR_CLOUD_MESSAGE);
    return yield* refused(
      "not-linked",
      `More than one Pair Cloud is linked here: ${usable.map((resolved) => resolved.link.label).join(", ")}. Pass cloudEnvironmentId.`,
    );
  });

  /** The same key on every retry until the move is recorded, after a restart too. */
  const stagingKeyFor = Effect.fn("CloudMoves.stagingKeyFor")(function* (threadId: ThreadId) {
    const { turnItems } = yield* threads
      .getThreadRecords(threadId, ["turnItems"])
      .pipe(Effect.mapError(failed("Couldn't read this thread.")));
    const moves = turnItems.filter((item) => item.type === "move" && item.direction === "to");
    const { environmentId } = yield* environment.getDescriptor;
    const hash = yield* digest.digest(
      Digest.sha256,
      new TextEncoder().encode(`${environmentId}\0${threadId}\0${moves.length}`),
    );
    return CloudStagingKey.make(`mv_${Hex.encode(hash).slice(0, 32)}`);
  });

  /** The local instance's driver, as `cloudModelDisabledReason` reads it. */
  const driverOf = Effect.fn("CloudMoves.driverOf")(function* (instanceId: string) {
    const provider = (yield* providers.getProviders).find(
      (entry) => entry.instanceId === instanceId,
    );
    if (provider !== undefined) return provider.driver;
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const stored =
      settings?.providerInstances[instanceId as keyof typeof settings.providerInstances];
    return stored?.driver ?? ProviderDriverKind.make(instanceId);
  });

  interface MoveMetrics {
    key: CloudStagingKey | null;
    seeded: boolean;
    fullHistory: boolean;
    seedBytes: number;
    exportBytes: number;
    uploadMs: number;
  }

  /** Snapshot, bundle against origin's base, and upload; temp refs and file go on every exit. */
  const sendSeed = Effect.fn("CloudMoves.sendSeed")(function* (input: {
    readonly cwd: string;
    readonly key: CloudStagingKey;
    readonly base: string;
    readonly branch: string;
    readonly excludePaths: ReadonlyArray<string>;
    readonly projectId: ProjectId;
    readonly link: PeerLinks.ResolvedPeerLink;
    readonly metrics: MoveMetrics;
  }) {
    const { cwd, key, metrics } = input;
    const refs = cloudSeedRefs(key);
    const file = path.join(seedDir, `${key}.bundle`);
    const git = (args: ReadonlyArray<string>, allowNonZeroExit = false) =>
      run(cwd, args, allowNonZeroExit).pipe(Effect.mapError(seedFailed));

    return yield* Effect.gen(function* () {
      yield* fs
        .makeDirectory(seedDir, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(seedFailed));
      yield* checkpoints
        .captureCheckpoint({
          cwd,
          checkpointRef: CheckpointRef.make(refs.snapshot),
          excludePaths: input.excludePaths,
        })
        .pipe(Effect.mapError(seedFailed));
      // The snapshot's own parent, even if HEAD moved since: Pair Cloud checks that.
      yield* git(["update-ref", refs.branch, `${refs.snapshot}^`]);
      const tip = (yield* git(["rev-parse", refs.branch])).stdout.trim();
      const mergeBase = yield* git(
        ["merge-base", `refs/remotes/origin/${input.base}`, tip],
        true,
      ).pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)));
      // A prerequisite that reaches the branch tip makes git drop the branch ref from the bundle.
      const prerequisites =
        mergeBase === null
          ? []
          : mergeBase === tip
            ? (yield* git(["rev-parse", `${mergeBase}^@`])).stdout
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line !== "")
            : [mergeBase];

      const bundleAndPut = Effect.fn("CloudMoves.bundleAndPut")(function* (
        exclude: ReadonlyArray<string>,
      ) {
        yield* fs.remove(file, { force: true }).pipe(Effect.mapError(seedFailed));
        yield* git([
          "bundle",
          "create",
          "--quiet",
          file,
          refs.branch,
          refs.snapshot,
          ...exclude.map((oid) => `^${oid}`),
        ]);
        metrics.seedBytes = Number((yield* fs.stat(file).pipe(Effect.mapError(seedFailed))).size);
        if (metrics.seedBytes > CLOUD_SEED_MAX_BYTES) {
          return yield* refused(
            "seed-too-large",
            `The upload would be ${Math.ceil(metrics.seedBytes / 1024 / 1024)} MB, over Pair Cloud's 512 MB limit. Leave out large untracked files, or push ${input.branch} first.`,
          );
        }
        const started = yield* Clock.currentTimeMillis;
        const outcome = yield* client.putSeed(input.link, {
          key,
          projectId: input.projectId,
          file,
        });
        metrics.uploadMs += (yield* Clock.currentTimeMillis) - started;
        return outcome;
      });

      const first = yield* bundleAndPut(prerequisites);
      if (first !== "missing-prerequisite") return first;
      metrics.fullHistory = true;
      const second = yield* bundleAndPut([]);
      if (second !== "missing-prerequisite") return second;
      return yield* refused(
        "upload-failed",
        "Pair Cloud couldn't read the uploaded branch. Try again.",
      );
    }).pipe(
      Effect.ensuring(
        Effect.all(
          [
            deleteRefsUnder(cwd, `refs/t3/staged/${key}/`),
            fs.remove(file, { force: true }).pipe(Effect.ignore),
          ],
          { discard: true },
        ),
      ),
    );
  });

  const move = Effect.fn("CloudMoves.move")(function* (
    input: ContinueInCloudInput,
    metrics: MoveMetrics,
  ) {
    const { shell, project, cwd } = yield* readThread(input.threadId);
    if (shell.activeRunId !== null && shell.activeRunId !== input.allowRunId) {
      return yield* refused("run-active", RUN_ACTIVE_MESSAGE);
    }
    const checkout = yield* readCheckout(cwd);
    const originKey = originKeyOf(project);
    if (originKey === null || !originKey.toLowerCase().startsWith("github.com/")) {
      return yield* refused("not-on-github", "Cloud needs this project's origin on github.com.");
    }
    const link = yield* resolveLink(input.cloudEnvironmentId);
    const key = yield* stagingKeyFor(input.threadId);
    metrics.key = key;

    // Asked before anything uploads, so a refusal leaves nothing on Pair Cloud.
    const accepted = yield* client.check(link, {
      ...(input.cloudProjectId === undefined ? {} : { projectId: input.cloudProjectId }),
      originKey,
      model: {
        driver: yield* driverOf(shell.modelSelection.instanceId),
        model: shell.modelSelection.model,
      },
    });

    const excluded = input.excludePaths.map(stripSlash);
    const isExcluded = (file: string) =>
      excluded.some((entry) => file === entry || file.startsWith(`${entry}/`));
    const nothingToUpload =
      checkout.pushed &&
      checkout.status.workingTree.files.every((file) => isExcluded(stripSlash(file.path)));
    const defaultBranch = yield* gitDriver
      .resolveDefaultBranchName(cwd, "origin")
      .pipe(Effect.orElseSucceed(() => null));
    const onBase = checkout.branch === checkout.base;
    const seededBranch =
      onBase || checkout.branch === defaultBranch ? `t3/${key.slice(3, 11)}` : checkout.branch;

    const launchBody = (seeded: boolean): CloudMoveLaunchInput => ({
      projectId: accepted.projectId,
      modelSelection: accepted.modelSelection,
      title: shell.title,
      baseRef: checkout.base,
      ...(seeded
        ? { branch: seededBranch }
        : onBase
          ? {}
          : { branch: checkout.branch, existingBranch: true as const }),
      seeded,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      message: input.message,
      createdBy: input.createdBy,
      creationSource: input.creationSource,
    });

    const seed = () =>
      sendSeed({
        cwd,
        key,
        base: checkout.base,
        branch: checkout.branch,
        excludePaths: input.excludePaths,
        projectId: accepted.projectId,
        link,
        metrics,
      }).pipe(Effect.tap(() => Effect.sync(() => void (metrics.seeded = true))));

    // `claimed`: a launch already took this key, so only the launch is resent, and it replays.
    const claimed = nothingToUpload ? false : (yield* seed()) === "claimed";
    if (!claimed) {
      const value = yield* contextExports
        .build(input.threadId)
        .pipe(Effect.mapError(failed("Couldn't read this thread's conversation.")));
      const sent = yield* client.putContextExport(link, {
        key,
        projectId: accepted.projectId,
        value,
      });
      metrics.exportBytes = sent.bytes;
    }

    let launched = yield* client.launch(link, { key, body: launchBody(metrics.seeded) });
    if (launched === "branch-not-pushed" && !metrics.seeded) {
      // Origin lost the branch since the preview: send it after all, once.
      yield* seed();
      launched = yield* client.launch(link, { key, body: launchBody(true) });
    }
    if (launched === "branch-not-pushed") {
      return yield* refused("refused", `${checkout.branch} is no longer on origin. Try again.`);
    }

    const cloudThread = { environmentId: link.link.environmentId, threadId: launched.threadId };
    yield* threads
      .dispatch({
        type: "thread.move.record",
        commandId: CommandId.make(`cloud-move:${key}:local`),
        threadId: input.threadId,
        to: cloudThread,
        message: `Continued in cloud on ${link.link.label}`,
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      })
      .pipe(
        Effect.mapError(
          failed("The cloud thread started, but this thread couldn't record it. Try again."),
        ),
      );
    return { cloudThread, seeded: metrics.seeded };
  });

  const measuredMove = Effect.fn("CloudMoves.continueInCloud")(function* (
    input: ContinueInCloudInput,
  ) {
    const startedAt = yield* Clock.currentTimeMillis;
    const metrics: MoveMetrics = {
      key: null,
      seeded: false,
      fullHistory: false,
      seedBytes: 0,
      exportBytes: 0,
      uploadMs: 0,
    };
    return yield* move(input, metrics).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const fields = {
            "cloudMove.key": metrics.key,
            "cloudMove.outcome": Exit.isSuccess(exit)
              ? "launched"
              : Option.match(Exit.findErrorOption(exit), {
                  onNone: () => "interrupted",
                  onSome: (error) => error.reason,
                }),
            "cloudMove.seeded": metrics.seeded,
            "cloudMove.fullHistory": metrics.fullHistory,
            "cloudMove.seedBytes": metrics.seedBytes,
            "cloudMove.exportBytes": metrics.exportBytes,
            "cloudMove.uploadMs": metrics.uploadMs,
            "cloudMove.totalMs": (yield* Clock.currentTimeMillis) - startedAt,
          };
          yield* Effect.annotateCurrentSpan(fields);
          yield* Effect.logInfo("cloud move", fields);
        }),
      ),
    );
  });

  const scope = yield* Effect.scope;

  const continueInCloud: CloudMoves["Service"]["continueInCloud"] = (input) =>
    SynchronizedRef.modifyEffect(inflight, (running) => {
      const joined = running.get(input.threadId);
      if (joined !== undefined) return Effect.succeed([joined, running] as const);
      return Effect.gen(function* () {
        const done = yield* Deferred.make<ThreadMoveToCloudResult, ThreadMoveError>();
        // Out of the map before anyone hears the result, so a retry starts a new move.
        yield* measuredMove(input).pipe(
          Effect.onExit((exit) =>
            SynchronizedRef.update(inflight, (current) => {
              const next = new Map(current);
              next.delete(input.threadId);
              return next;
            }).pipe(Effect.andThen(Deferred.done(done, exit))),
          ),
          Effect.forkIn(scope),
        );
        return [done, new Map(running).set(input.threadId, done)] as const;
      });
    }).pipe(Effect.flatMap(Deferred.await));

  return CloudMoves.of({ continueLocally, preview, continueInCloud });
});

export const layer = Layer.effect(CloudMoves, make);
