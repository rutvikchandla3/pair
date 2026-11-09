// @effect-diagnostics nodeBuiltinImport:off - a launch derives its sandbox id synchronously.
import * as NodeCrypto from "node:crypto";

import {
  type CommandId,
  type ComputeDriverId,
  type OrchestrationV2Sandbox,
  ProjectId,
  type ProviderInstanceId,
  SandboxFailure,
  SandboxId,
  type SandboxSize,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl, parseGitRemoteRepository } from "@t3tools/shared/git";
import { cloudAvailability } from "@t3tools/shared/sandbox";
import { sandboxCredentialSupport } from "@t3tools/shared/sandboxCredentials";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  ProviderCloudLocalOnlyError,
  ProviderCloudUnsupportedError,
} from "../../provider/Errors.ts";
import { sandboxInstanceConfig } from "../credentials/SandboxProcessEnvironment.ts";
import * as RunnerHub from "../runnerHub/RunnerHub.ts";
import { SANDBOX_ROOT } from "../../workspaceHost/WorkspaceHost.ts";

export class CloudLaunchError extends Schema.TaggedError<CloudLaunchError>()("CloudLaunchError", {
  projectId: ProjectId,
  reason: Schema.Literals([
    "no-driver",
    "project-disallowed",
    "no-origin",
    "base-ref-missing",
    "branch-not-pushed",
    "no-branch",
    "sandbox-failed",
    "local-launch",
  ]),
  baseRef: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  /** The remote that was checked, as `host/path`. */
  remote: Schema.optional(Schema.String),
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
        return `${this.baseRef ?? "The base branch"} is not on origin. Push ${this.baseRef ?? "it"} first.`;
      case "branch-not-pushed":
        return `${this.branch} is not on ${this.remote}. Push ${this.branch} first.`;
      case "no-branch":
        return "Name the existing branch to launch from.";
      case "sandbox-failed":
        return this.failure?.message ?? "The machine stopped before it was ready.";
      case "local-launch":
        return "This server runs threads only in the cloud. Launch it as a cloud thread.";
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

/** Deterministic, so a replayed launch provisions the same sandbox. */
export const sandboxIdForLaunch = (commandId: CommandId): SandboxId =>
  SandboxId.make(
    `sbx_${NodeCrypto.createHash("sha256").update(commandId).digest("hex").slice(0, 20)}`,
  );

/**
 * The driver and size a cloud launch in this project gets, checked before anything is created,
 * as is the provider account: one that cannot sign in on a machine never starts one.
 */
export const resolveCloudLaunch = Effect.fn("CloudPreparation.resolveCloudLaunch")(function* (
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
) {
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
  const availability = cloudAvailability(settings, projectId);
  const sandbox = settings.sandbox;
  if (!availability.available || sandbox === undefined) {
    return yield* new CloudLaunchError({
      projectId,
      reason:
        !availability.available && availability.reason === "project-disallowed"
          ? "project-disallowed"
          : "no-driver",
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
  } satisfies { readonly driverId: ComputeDriverId; readonly size: SandboxSize };
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
const clonePathFor = (root: string, url: string, projectId: ProjectId) => {
  const repository = parseGitRemoteRepository(url);
  const segments =
    repository === null ? [] : [repository.host, ...repository.path.split("/")].filter(Boolean);
  return segments.length > 1 && segments.every((segment) => segment !== "." && segment !== "..")
    ? `${root}/repos/${segments.join("/")}`
    : `${root}/repos/${encodeURIComponent(projectId)}`;
};

/**
 * Clones the project's origin into the sandbox (or fetches the clone already there), then adds a
 * worktree from `origin/<branch>` when that was pushed, else `origin/<baseRef>` (README P4); an
 * `existingBranch` must have been pushed. Git runs through the sandbox host as its agent user, so
 * the agent owns the checkout.
 */
export const checkoutInSandbox = Effect.fn("CloudPreparation.checkoutInSandbox")(function* (input: {
  readonly sandboxId: SandboxId;
  readonly projectId: ProjectId;
  readonly projectRoot: string;
  readonly baseRef: string;
  readonly branch: string;
  readonly existingBranch: boolean;
  readonly existingWorktreePath: string | null;
}) {
  const git = yield* GitWorkflow.GitWorkflowService;
  const root = (yield* SandboxCheckoutRoot)(input.sandboxId);
  const isCheckout = (cwd: string) => git.isRepository(cwd).pipe(Effect.orElseSucceed(() => false));
  const url = yield* git.readRemoteUrl({ cwd: input.projectRoot, remoteName: "origin" });
  if (url === null) {
    return yield* new CloudLaunchError({ projectId: input.projectId, reason: "no-origin" });
  }
  const clonePath = clonePathFor(root, url, input.projectId);
  if (yield* isCheckout(clonePath)) {
    yield* git.fetchRemote({ cwd: clonePath, remoteName: "origin" });
  } else {
    yield* git.cloneRepository({ cwd: root, url, path: clonePath });
  }
  // A kept disk still has the thread's checkout; a new machine starts without one.
  if (input.existingWorktreePath !== null && (yield* isCheckout(input.existingWorktreePath))) {
    return {
      clonePath,
      worktreePath: input.existingWorktreePath,
      branch: input.branch,
      created: false,
    };
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
    return yield* new CloudLaunchError({
      projectId: input.projectId,
      reason: "base-ref-missing",
      baseRef: input.baseRef,
    });
  }
  const created = yield* git.createWorktree({
    cwd: clonePath,
    refName: `origin/${pushed ? input.branch : input.baseRef}`,
    newRefName: input.branch,
    baseRefName: `refs/remotes/origin/${input.baseRef}`,
    path: `${root}/worktrees/${input.branch.replaceAll("/", "-")}`,
  });
  return {
    clonePath,
    worktreePath: created.worktree.path,
    branch: created.worktree.refName,
    created: true,
  };
});
