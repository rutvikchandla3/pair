// @effect-diagnostics nodeBuiltinImport:off - a launch derives its sandbox id synchronously.
import * as NodeCrypto from "node:crypto";

import {
  type CommandId,
  type GitCommandError,
  type ComputeDriverId,
  type OrchestrationV2Sandbox,
  ProjectId,
  type ProviderInstanceId,
  SandboxFailure,
  SandboxId,
  type SandboxImageBuildRef,
  type SandboxSize,
  type ThreadId,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl, parseGitRemoteRepository } from "@t3tools/shared/git";
import { cloudAvailability, NOT_CLOUD_ONLY_MESSAGE } from "@t3tools/shared/sandbox";
import { sandboxCredentialSupport } from "@t3tools/shared/sandboxCredentials";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  ProviderCloudLocalOnlyError,
  ProviderCloudUnsupportedError,
} from "../../provider/Errors.ts";
import { sandboxInstanceConfig } from "../credentials/SandboxProcessEnvironment.ts";
import { TEAM_IMAGE_ROOT } from "../image/teamImageBuildProgram.ts";
import * as TeamImageStore from "../image/TeamImageStore.ts";
import * as MirrorSync from "../mirror/MirrorSync.ts";
import * as RunnerHub from "../runnerHub/RunnerHub.ts";
import { SANDBOX_ROOT, type WorkspaceHost } from "../../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";

const NETWORK_FAILURE =
  /Could not resolve host|Failed to connect|timed out|Network is unreachable/i;

export class CloudLaunchError extends Schema.TaggedError<CloudLaunchError>()("CloudLaunchError", {
  projectId: ProjectId,
  reason: Schema.Literals([
    "no-driver",
    "project-disallowed",
    "no-origin",
    "base-ref-missing",
    "branch-not-pushed",
    "repo-unreadable",
    "clone-failed",
    "no-branch",
    "sandbox-failed",
    "local-launch",
    "not-cloud-only",
    "seed-on-base",
    "seed-unavailable",
    "export-unavailable",
    "workspace",
  ]),
  baseRef: Schema.optional(Schema.String),
  /** For `base-ref-missing`: the base is a branch on the host that origin lacks. */
  baseOnHost: Schema.optional(Schema.Boolean),
  branch: Schema.optional(Schema.String),
  /** The remote that was checked, as `host/path`. */
  remote: Schema.optional(Schema.String),
  /** Git's redacted reason a clone failed. */
  detail: Schema.optional(Schema.String),
  failure: Schema.optional(SandboxFailure),
}) {
  override get message(): string {
    switch (this.reason) {
      case "no-driver":
        return "Cloud is not set up on this environment.";
      case "project-disallowed":
        return "Cloud threads are turned off for this project.";
      case "no-origin":
        return "This project has no origin remote to clone in the cloud.";
      case "base-ref-missing":
        return this.baseOnHost === true
          ? `${this.baseRef ?? "The base branch"} is not on origin. Push ${this.baseRef ?? "it"} first.`
          : `${this.baseRef ?? "The base branch"} isn't a branch of ${this.remote ?? "this repository"}. Choose another base branch.`;
      case "branch-not-pushed":
        return `${this.branch} is not on ${this.remote}. Push ${this.branch} first.`;
      case "repo-unreadable":
        return `Pair Cloud can't read ${this.remote}. Connect GitHub to clone private repos, in Settings → Team.`;
      case "clone-failed": {
        const detail = this.detail ?? "git clone failed";
        return NETWORK_FAILURE.test(detail)
          ? `Pair Cloud couldn't clone ${this.remote}: ${detail}. Run Test in Settings → Cloud to check the machine's network.`
          : `Pair Cloud couldn't clone ${this.remote}: ${detail}`;
      }
      case "no-branch":
        return "Name the existing branch to launch from.";
      case "sandbox-failed":
        return this.failure?.message ?? "The machine stopped before it was ready.";
      case "local-launch":
        return "This server runs threads only in the cloud. Launch it as a cloud thread.";
      case "not-cloud-only":
        return NOT_CLOUD_ONLY_MESSAGE;
      case "seed-on-base":
        return `${this.branch} is Pair Cloud's base branch. Create a new branch for this work, then try again.`;
      case "seed-unavailable":
        return "The work uploaded for this move is no longer on Pair Cloud. Continue in cloud again.";
      case "export-unavailable":
        return "The conversation uploaded for this move is no longer on Pair Cloud. Continue in cloud again.";
      case "workspace":
        return "Workspaces don't run in Cloud yet.";
    }
  }
}

/** A refused cloud launch says why: not set up, off for this project, or a local-only account. */
export const isCloudLaunchRefusal = Schema.is(
  Schema.Union([CloudLaunchError, ProviderCloudLocalOnlyError, ProviderCloudUnsupportedError]),
);

/**
 * Where a sandbox's checkouts live on its host (README P1). The loopback runner in tests serves
 * the local disk, so tests point it at a temp folder they register for that host.
 */
export const SandboxCheckoutRoot = Context.Reference<(sandboxId: SandboxId) => string>(
  "t3/sandbox/lifecycle/CloudPreparation/SandboxCheckoutRoot",
  { defaultValue: () => (sandboxId) => `${SANDBOX_ROOT}/${sandboxId}` },
);

/** Where a team image keeps its pre-cloned projects, in the image's own layer. */
export const TeamImageCloneRoot = Context.Reference<string>(
  "t3/sandbox/lifecycle/CloudPreparation/TeamImageCloneRoot",
  { defaultValue: () => TEAM_IMAGE_ROOT },
);

/** Deterministic, so a replayed launch provisions the same sandbox. */
export const sandboxIdForLaunch = (commandId: CommandId): SandboxId =>
  SandboxId.make(
    `sbx_${NodeCrypto.createHash("sha256").update(commandId).digest("hex").slice(0, 20)}`,
  );

/**
 * The active team build when it was built on `driverId` and its image is still there; else null,
 * and the machine boots the base. An unreadable store boots the base too.
 */
const activeImageBuild = Effect.fn("CloudPreparation.activeImageBuild")(
  function* (driverId: ComputeDriverId) {
    const store = yield* TeamImageStore.TeamImageStore;
    const { activeBuildId } = yield* store.state;
    if (activeBuildId === null) return null;
    const record = yield* store.build(activeBuildId);
    if (Option.isNone(record)) return null;
    const { build } = record.value;
    return build.driverId === driverId &&
      build.imageDeletedAt === null &&
      build.imageRef !== undefined
      ? ({ id: build.id, number: build.number } satisfies SandboxImageBuildRef)
      : null;
  },
  Effect.catch((cause) =>
    Effect.logWarning("Could not read the active team image; booting the base", { cause }).pipe(
      Effect.as(null),
    ),
  ),
);

/**
 * The driver and size a cloud launch in this project gets, checked before anything is created,
 * as is the provider account: one that cannot sign in on a machine never starts one. The machine
 * boots the active team build when it was built on that driver.
 */
export const resolveCloudLaunch = Effect.fn("CloudPreparation.resolveCloudLaunch")(function* (
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
) {
  const { cloudOnly } = yield* ServerConfig.ServerConfig;
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
  const availability = cloudAvailability(settings, projectId, cloudOnly);
  const sandbox = settings.sandbox;
  if (!availability.available || sandbox === undefined) {
    return yield* new CloudLaunchError({
      projectId,
      reason:
        availability.available || availability.reason === "not-configured"
          ? "no-driver"
          : availability.reason,
    });
  }
  const instance = sandboxInstanceConfig(settings, instanceId);
  const support = sandboxCredentialSupport({ instanceId, instance });
  if (support._tag === "LocalOnly") {
    return yield* new ProviderCloudLocalOnlyError({ instanceId, reason: support.reason });
  }
  if (support._tag === "Unsupported") {
    return yield* new ProviderCloudUnsupportedError({ threadId: "", driver: instance.driver });
  }
  const driver =
    sandbox.drivers.find((candidate) => candidate.id === sandbox.defaultDriverId) ??
    sandbox.drivers[0]!;
  return {
    driverId: driver.id,
    size: driver.size ?? "default",
    imageBuild: yield* activeImageBuild(driver.id),
  } satisfies {
    readonly driverId: ComputeDriverId;
    readonly size: SandboxSize;
    readonly imageBuild: SandboxImageBuildRef | null;
  };
});

type WaitingPhase = "sandbox-admission" | "sandbox-start";

/**
 * Resolves once the sandbox is `ready`; fails on `failed` or `destroyed`. Reads the owner's
 * stream from a sequence taken before the record read, so a `ready` in between is not missed.
 */
export const awaitSandboxReady = Effect.fn("CloudPreparation.awaitSandboxReady")(function* <
  E,
>(input: {
  readonly sandboxId: SandboxId;
  readonly onWaiting: (phase: WaitingPhase) => Effect.Effect<void, E>;
}) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const owner = (yield* projections.getSandbox(input.sandboxId))?.ownerThreadId;
  if (owner === undefined) return yield* Effect.die(`No machine ${input.sandboxId}.`);
  const afterSequence = yield* threads.getThreadEventSequence(owner);
  let phase: WaitingPhase | null = null;
  const settle = Effect.fnUntraced(function* (record: OrchestrationV2Sandbox) {
    if (record.state === "ready") return Option.some(record);
    if (record.state === "failed" || record.state === "destroyed") {
      return yield* new CloudLaunchError({
        projectId: record.projectId,
        reason: "sandbox-failed",
        ...(record.failure === null ? {} : { failure: record.failure }),
      });
    }
    const next: WaitingPhase = record.admission === null ? "sandbox-start" : "sandbox-admission";
    if (next !== phase) {
      phase = next;
      yield* input.onWaiting(next);
    }
    return Option.none<OrchestrationV2Sandbox>();
  });
  const current = yield* projections.getSandbox(input.sandboxId);
  if (current === null) return yield* Effect.die(`No machine ${input.sandboxId}.`);
  const settled = yield* settle(current);
  const ready = Option.isSome(settled)
    ? settled.value
    : yield* threads
        .streamStoredEventsFrom({ threadId: owner, afterSequence, eventType: "sandbox.updated" })
        .pipe(
          Stream.mapEffect((stored) =>
            stored.event.type === "sandbox.updated" && stored.event.payload.id === input.sandboxId
              ? settle(stored.event.payload)
              : Effect.succeed(Option.none<OrchestrationV2Sandbox>()),
          ),
          Stream.filter(Option.isSome),
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.die("The owner's stream ended."),
              onSome: (record) => Effect.succeed(record.value),
            }),
          ),
        );
  // After a server restart the record says `ready` before its runner dials back in.
  const hub = yield* Effect.serviceOption(RunnerHub.RunnerHub);
  if (Option.isSome(hub)) {
    yield* hub.value.connection(input.sandboxId).pipe(
      Effect.mapError(
        () =>
          new CloudLaunchError({
            projectId: ready.projectId,
            reason: "sandbox-failed",
            failure: {
              code: "lost",
              message: "The machine's runner did not connect.",
              retryable: true,
            },
          }),
      ),
    );
  }
  return ready;
});

/** `repos/<host>/<owner>/<name>` for a hosted remote, else one folder per project. */
export const clonePathFor = (root: string, url: string, projectId: ProjectId) => {
  const repository = parseGitRemoteRepository(url);
  const segments =
    repository === null ? [] : [repository.host, ...repository.path.split("/")].filter(Boolean);
  return segments.length > 1 && segments.every((segment) => segment !== "." && segment !== "..")
    ? `${root}/repos/${segments.join("/")}`
    : `${root}/repos/${encodeURIComponent(projectId)}`;
};

/**
 * Copies a team image's clone of the project into the sandbox's disk, which is another filesystem
 * than the image's layer. The agent user copies, so it owns the result; a copy lands under a
 * temporary name and is renamed into place, so a failed one leaves nothing at `to`.
 */
const copyImageClone = Effect.fn("CloudPreparation.copyImageClone")(function* (
  host: Pick<WorkspaceHost, "spawner" | "fileSystem">,
  from: string,
  to: string,
) {
  if (!(yield* host.fileSystem.exists(`${from}/.git`).pipe(Effect.orElseSucceed(() => false)))) {
    return false;
  }
  const staging = `${to}.image-copy`;
  const run = (command: string, args: ReadonlyArray<string>) =>
    host.spawner
      .exitCode(ChildProcess.make(command, args, { stdin: "ignore" }))
      .pipe(
        Effect.flatMap((code) =>
          code === 0 ? Effect.void : Effect.fail(`${command} exited with ${code}`),
        ),
      );
  const [elapsed, copied] = yield* Effect.gen(function* () {
    yield* host.fileSystem.remove(staging, { recursive: true, force: true });
    yield* run("mkdir", ["-p", to.slice(0, to.lastIndexOf("/"))]);
    yield* run("cp", ["-a", from, staging]);
    yield* host.fileSystem.rename(staging, to);
    return true;
  }).pipe(
    Effect.catch((cause) =>
      host.fileSystem.remove(staging, { recursive: true, force: true }).pipe(
        Effect.ignore,
        Effect.andThen(
          Effect.logWarning("Could not copy a project from the team image; cloning it", {
            from,
            cause,
          }),
        ),
        Effect.as(false),
      ),
    ),
    Effect.timed,
  );
  const copyMs = Duration.toMillis(elapsed);
  // The first-boot copy's cost: the M4 pass reads it from the trace and the log.
  yield* Effect.annotateCurrentSpan({ "team_image.copied": copied, "team_image.copy_ms": copyMs });
  if (copied) yield* Effect.logInfo("Copied a project from the team image", { to, copyMs });
  return copied;
});

/**
 * Keeps a kept disk's checkout, else copies the team image's clone (or clones origin), fetches,
 * and checks the thread out of the mirror (a `seeded` launch never falls back to origin), else adds
 * a worktree from `origin/<branch>` or `origin/<baseRef>` (an `existingBranch` must be pushed).
 */
export const checkoutInSandbox = Effect.fn("CloudPreparation.checkoutInSandbox")(function* (input: {
  readonly sandboxId: SandboxId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly projectRoot: string;
  readonly baseRef: string;
  readonly branch: string;
  readonly existingBranch: boolean;
  readonly existingWorktreePath: string | null;
  readonly seeded: boolean;
}) {
  const git = yield* GitWorkflow.GitWorkflowService;
  const root = (yield* SandboxCheckoutRoot)(input.sandboxId);
  const worktreePathFor = (checkoutRoot: string, branch: string) =>
    `${checkoutRoot}/worktrees/${branch.replaceAll("/", "-")}`;
  const isCheckout = (cwd: string) => git.isRepository(cwd).pipe(Effect.orElseSucceed(() => false));
  const url = yield* git.readRemoteUrl({ cwd: input.projectRoot, remoteName: "origin" });
  if (url === null) {
    return yield* new CloudLaunchError({ projectId: input.projectId, reason: "no-origin" });
  }
  const clonePath = clonePathFor(root, url, input.projectId);
  // A kept disk still has the thread's checkout; a new machine starts without one.
  if (input.existingWorktreePath !== null && (yield* isCheckout(input.existingWorktreePath))) {
    return {
      clonePath,
      worktreePath: input.existingWorktreePath,
      branch: input.branch,
      created: false,
      restoredFrom: "disk" as const,
      snapshotAt: null,
      cloneSource: "existing" as const,
    };
  }
  let cloneSource: "image" | "origin" | "existing" = (yield* isCheckout(clonePath))
    ? "existing"
    : "origin";
  // The server provides the hosts. `forPath` cannot route the image's path, so the copy runs on
  // the host of the sandbox's own root.
  const hosts = yield* Effect.serviceOption(WorkspaceHosts.WorkspaceHosts);
  if (cloneSource === "origin" && Option.isSome(hosts)) {
    const host = yield* hosts.value.forPath(root).pipe(Effect.option);
    const imageClone = clonePathFor(yield* TeamImageCloneRoot, url, input.projectId);
    if (Option.isSome(host) && (yield* copyImageClone(host.value, imageClone, clonePath))) {
      cloneSource = "image";
    }
  }
  yield* Effect.annotateCurrentSpan({ "checkout.clone_source": cloneSource });
  const cloning = cloneSource === "origin";
  const remote = normalizeGitRemoteUrl(url);
  // Git can't tell a missing credential from one without access; both are fixed in Settings → Team.
  const cloneOrFetchFailed = (error: GitCommandError) =>
    error.reason === "authentication_failed" || error.reason === "remote_unreachable"
      ? new CloudLaunchError({ projectId: input.projectId, reason: "repo-unreadable", remote })
      : cloning
        ? new CloudLaunchError({
            projectId: input.projectId,
            reason: "clone-failed",
            remote,
            detail: error.detail,
          })
        : error;
  yield* (
    cloning
      ? git.cloneRepository({ cwd: root, url, path: clonePath })
      : git.fetchRemote({ cwd: clonePath, remoteName: "origin" })
  ).pipe(Effect.mapError(cloneOrFetchFailed));
  const mirror = yield* Effect.serviceOption(MirrorSync.MirrorSync);
  if (Option.isSome(mirror)) {
    const rebuilt = input.existingWorktreePath !== null;
    const worktreePath = input.existingWorktreePath ?? worktreePathFor(root, input.branch);
    // An attempt that failed after `worktree add` left this path; start it again.
    if (!rebuilt && (yield* isCheckout(worktreePath))) {
      yield* git.removeWorktree({ cwd: clonePath, path: worktreePath, force: true });
    }
    const restored = yield* mirror.value.restore({
      threadId: input.threadId,
      projectId: input.projectId,
      clonePath,
      worktreePath,
      branch: input.branch,
    });
    if (restored !== null) {
      return {
        clonePath,
        worktreePath,
        branch: input.branch,
        // A rebuild never deletes the work it brought back; a failed first checkout is undone.
        created: !rebuilt,
        restoredFrom: rebuilt ? ("mirror" as const) : ("seed" as const),
        snapshotAt: restored.snapshotAt,
        cloneSource,
      };
    }
  }
  if (input.seeded) {
    return yield* new CloudLaunchError({ projectId: input.projectId, reason: "seed-unavailable" });
  }
  const hasRemoteBranch = (refName: string) =>
    git.hasCommit({ cwd: clonePath, refName: `refs/remotes/origin/${refName}` });
  const pushed = yield* hasRemoteBranch(input.branch);
  if (input.existingBranch && !pushed) {
    return yield* new CloudLaunchError({
      projectId: input.projectId,
      reason: "branch-not-pushed",
      branch: input.branch,
      remote: normalizeGitRemoteUrl(url),
    });
  }
  if (!pushed && !(yield* hasRemoteBranch(input.baseRef))) {
    const baseOnHost = yield* git
      .hasCommit({ cwd: input.projectRoot, refName: `refs/heads/${input.baseRef}` })
      .pipe(Effect.orElseSucceed(() => false));
    return yield* new CloudLaunchError({
      projectId: input.projectId,
      reason: "base-ref-missing",
      baseRef: input.baseRef,
      baseOnHost,
      remote: normalizeGitRemoteUrl(url),
    });
  }
  const created = yield* git.createWorktree({
    cwd: clonePath,
    refName: `origin/${pushed ? input.branch : input.baseRef}`,
    newRefName: input.branch,
    baseRefName: `refs/remotes/origin/${input.baseRef}`,
    path: worktreePathFor(root, input.branch),
  });
  return {
    clonePath,
    worktreePath: created.worktree.path,
    branch: created.worktree.refName,
    created: true,
    restoredFrom: "origin" as const,
    snapshotAt: null,
    cloneSource,
  };
});
