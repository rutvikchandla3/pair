import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import {
  type ModelSelection,
  PullRequestOperationError,
  type PullRequestDetail,
  type PullRequestRef,
  type PullRequestReviewGuide,
  type PullRequestReviewGuideResult,
  type PullRequestReviewGuideRun,
  type PullRequestStack,
  ProjectId,
  type RepositoryIdentity,
  type ThreadId,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import type { ReviewGuideStackLayer } from "@t3tools/provider-core/server/textGeneration";
import { providerInstanceOwner } from "@t3tools/shared/providerInstanceOwnership";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as PullRequestReviewGuides from "../persistence/PullRequestReviewGuides.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SandboxActivity from "../sandbox/lifecycle/SandboxActivity.ts";
import { makeSandboxTempDirectory } from "../sandbox/providers/SandboxProviderHome.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { PATCH_RENDER_PREFIX_ARGS } from "../vcs/GitVcsDriverCore.ts";
import { threadPullRequestKeysEqual } from "../sourceControl/threadPullRequests.ts";
import type { WorkspaceHost } from "../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../workspaceHost/WorkspaceHosts.ts";
import * as PullRequestService from "./PullRequestService.ts";
import { pullRequestSyncKey } from "./pullRequestSyncKey.ts";
import { reviewGuideInputFromPullRequest } from "./pullRequestReviewGuideInput.ts";
import { normalizeReviewGuide, parseReviewGuideChange } from "./pullRequestReviewGuideNormalize.ts";

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,64}$/;

export interface ReviewGuideRequester {
  /** Holds `terminal:operate`: on Pair Cloud the guide runs in a linked thread's machine. */
  readonly mayUseMachines: boolean;
}

/** Where the guide's git and investigation run: the project's checkout, or a cloud thread's. */
interface ReviewGuideCheckout {
  readonly root: string;
  readonly host: WorkspaceHost;
  readonly threadId: ThreadId | undefined;
}

const MACHINE_GUIDE =
  "On Pair Cloud, a guide is written in the machine of a cloud thread on this pull request";

/** Cloud threads of the project linked to the pull request, newest first. */
const linkedMachineThreads = (
  key: ThreadPullRequestKey,
  projectId: ProjectId,
  threads: ReadonlyArray<ProjectionStore.ProjectionThreadPullRequests>,
) =>
  threads
    .flatMap((thread) =>
      thread.projectId === projectId &&
      thread.sandboxId !== undefined &&
      thread.worktreePath !== null &&
      thread.lineage.sideChat !== true &&
      (thread.pullRequests ?? []).some(
        (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, key),
      )
        ? [{ id: thread.id, title: thread.title, worktreePath: thread.worktreePath }]
        : [],
    )
    .toReversed();

export class PullRequestReviewGuideService extends Context.Service<
  PullRequestReviewGuideService,
  {
    readonly get: (
      input: PullRequestRef,
    ) => Effect.Effect<PullRequestReviewGuideResult, PullRequestService.PullRequestError>;
    readonly generate: (
      input: PullRequestRef,
      requester: ReviewGuideRequester,
    ) => Effect.Effect<
      PullRequestReviewGuideResult & { readonly started: boolean },
      PullRequestService.PullRequestError
    >;
  }
>()("t3/pullRequest/PullRequestReviewGuideService") {}

const keyString = (key: ThreadPullRequestKey) => `${key.host}/${key.repository}#${key.number}`;

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
);

const make = Effect.gen(function* () {
  const pullRequests = yield* PullRequestService.PullRequestService;
  const guides = yield* PullRequestReviewGuides.PullRequestReviewGuideRepository;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  const sandboxActivity = yield* SandboxActivity.SandboxActivity;
  const serviceScope = yield* Effect.scope;
  const runs = yield* Ref.make<ReadonlyMap<string, PullRequestReviewGuideRun>>(new Map());
  let runCounter = 0;
  // Serialize claims and guide writes so a newer claim cannot steal ownership between checking and storing.
  const ownership = yield* Semaphore.make(1);

  const keyFor = Effect.fn("PullRequestReviewGuideService.keyFor")(function* (
    input: PullRequestRef,
  ) {
    const project = Option.getOrUndefined(
      yield* projects.getShell(input.projectId).pipe(Effect.orElseSucceed(() => Option.none())),
    );
    const key = pullRequestSyncKey(input, project?.repositoryIdentity ?? undefined);
    if (key === null || project === undefined) {
      return yield* new PullRequestOperationError({
        operation: "reviewGuide",
        detail: "Could not identify this pull request's host.",
      });
    }
    return { key, workspaceRoot: project.workspaceRoot, identity: project.repositoryIdentity };
  });

  const requireOwnRepository = Effect.fn("PullRequestReviewGuideService.requireOwnRepository")(
    function* (key: ThreadPullRequestKey, identity: RepositoryIdentity | null | undefined) {
      const own =
        identity == null
          ? null
          : pullRequestSyncKey(
              {
                projectId: ProjectId.make("own"),
                number: key.number,
                repository: sourceControlDefinitions.repositorySelector(identity) ?? "",
              },
              identity,
            );
      if (
        identity == null ||
        own === null ||
        own.host !== key.host ||
        own.repository !== key.repository
      ) {
        return yield* new PullRequestOperationError({
          operation: "generateReviewGuide",
          detail:
            "Guides are written from this project's checkout, and this pull request is in another repository. Write it from a project that is a checkout of that repository.",
        });
      }
      return identity.locator;
    },
  );

  const refuse = (detail: string) =>
    new PullRequestOperationError({ operation: "generateReviewGuide", detail });

  // Never this server's host on Pair Cloud: the checkout and the agent's tools stay in a machine.
  const machineCheckout = Effect.fn("PullRequestReviewGuideService.machineCheckout")(function* (
    key: ThreadPullRequestKey,
    projectId: ProjectId,
    requester: ReviewGuideRequester,
  ) {
    const threads = yield* projections.getThreadsWithPullRequests().pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestOperationError({
            operation: "generateReviewGuide",
            detail: "Could not read the pull request's threads.",
            cause,
          }),
      ),
    );
    const linked = linkedMachineThreads(key, projectId, threads);
    const newest = linked[0];
    if (newest === undefined) {
      return yield* refuse(
        `${MACHINE_GUIDE}, and none is linked to it. Link it to a cloud thread, then write the guide.`,
      );
    }
    if (!requester.mayUseMachines) {
      return yield* refuse(
        `${MACHINE_GUIDE}, and this session can't use machines. Write it from a session that can open that thread's terminal.`,
      );
    }
    for (const thread of linked) {
      const host = yield* Effect.option(hosts.forPath(thread.worktreePath));
      if (Option.isSome(host) && host.value.kind === "sandbox") {
        return {
          root: thread.worktreePath,
          host: host.value,
          threadId: thread.id,
        } satisfies ReviewGuideCheckout;
      }
    }
    return yield* refuse(`Wake the machine of ‘${newest.title}’, then write the guide.`);
  });

  // A machine's git runs as the agent and the runner's file calls as root, so the agent makes it.
  const scratchDirectory = (host: WorkspaceHost) =>
    host.kind === "local"
      ? fileSystem.makeTempDirectoryScoped({
          directory: config.worktreesDir,
          prefix: "review-guide-",
        })
      : Effect.acquireRelease(
          makeSandboxTempDirectory(host, "t3-review-guide-").pipe(
            Effect.mapError((cause) => refuse(cause.message)),
          ),
          (directory) =>
            host.fileSystem
              .remove(directory, { recursive: true })
              .pipe(Effect.ignore({ log: true })),
        );

  const readStored = (key: ThreadPullRequestKey) =>
    guides.get(key).pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestOperationError({
            operation: "reviewGuide",
            detail: "Could not read the stored review guide.",
            cause,
          }),
      ),
      Effect.map(Option.getOrNull),
    );

  const get: PullRequestReviewGuideService["Service"]["get"] = Effect.fn(
    "PullRequestReviewGuideService.get",
  )(function* (input) {
    const { key } = yield* keyFor(input);
    const [guide, detail, current] = yield* Effect.all(
      [readStored(key), pullRequests.detail(input), Ref.get(runs)],
      { concurrency: "unbounded" },
    );
    return {
      guide,
      run: current.get(keyString(key)) ?? null,
      currentHeadSha: detail.headSha ?? null,
    };
  });

  const checkoutHead = Effect.fn("PullRequestReviewGuideService.checkoutHead")(function* (
    checkout: ReviewGuideCheckout,
    locator: RepositoryIdentity["locator"],
    detail: PullRequestDetail,
    headSha: string,
    stack: PullRequestStack | null,
    runId: string,
  ) {
    const workspaceRoot = checkout.root;
    // Identity names can be stale; match effective fetch URLs, including insteadOf rewrites.
    const names = yield* git
      .execute({
        operation: "PullRequestReviewGuideService.listRemotes",
        cwd: workspaceRoot,
        args: ["remote"],
      })
      .pipe(Effect.map((result) => result.stdout.split("\n").filter((name) => name.length > 0)));
    const remote = yield* Effect.findFirst(
      [locator.remoteName, ...names.filter((name) => name !== locator.remoteName)],
      (name) =>
        git
          .execute({
            operation: "PullRequestReviewGuideService.remoteUrl",
            cwd: workspaceRoot,
            args: ["remote", "get-url", "--", name],
          })
          .pipe(
            Effect.map((result) => result.stdout.trim() === locator.remoteUrl),
            Effect.orElseSucceed(() => false),
          ),
    ).pipe(Effect.map(Option.getOrUndefined));
    if (remote === undefined) {
      return yield* new PullRequestOperationError({
        operation: "generateReviewGuide",
        detail: "This project's checkout no longer has a remote for the pull request's repository.",
      });
    }
    const fetch = (args: ReadonlyArray<string>) =>
      git.execute({
        operation: "PullRequestReviewGuideService.fetch",
        cwd: workspaceRoot,
        args: ["fetch", "--quiet", "--no-tags", "--", remote, ...args],
        timeoutMs: 5 * 60_000,
      });
    // Reject invalid branch names and refspec operators before fetching host-provided names.
    yield* git
      .execute({
        operation: "PullRequestReviewGuideService.checkBaseBranch",
        cwd: workspaceRoot,
        args: ["check-ref-format", "--branch", detail.baseBranch],
      })
      .pipe(
        Effect.filterOrFail(
          () => !detail.baseBranch.startsWith("+") && !detail.baseBranch.includes(":"),
          () =>
            new PullRequestOperationError({
              operation: "generateReviewGuide",
              detail: "The pull request's base branch name is not one git can fetch.",
            }),
        ),
      );
    // FETCH_HEAD is workspace-global; isolate this run's base from concurrent fetches.
    const baseRef = `refs/t3/review-guide/${runId}/base`;
    yield* fetch([`+refs/heads/${detail.baseBranch}:${baseRef}`]);
    yield* Effect.addFinalizer(() =>
      git
        .execute({
          operation: "PullRequestReviewGuideService.dropBaseRef",
          cwd: workspaceRoot,
          args: ["update-ref", "-d", baseRef],
        })
        .pipe(Effect.ignore({ log: true })),
    );
    const baseTip = yield* git.resolveCommit({ cwd: workspaceRoot, revision: baseRef });
    const fetchHead = Effect.fn("PullRequestReviewGuideService.fetchHead")(function* (
      number: number,
      reportedSha: string,
      branch: string,
    ) {
      const sha = reportedSha.toLowerCase();
      if (!COMMIT_HASH_PATTERN.test(sha)) {
        return yield* new PullRequestOperationError({
          operation: "generateReviewGuide",
          detail: `The host reported a head for #${number} that is not a commit hash.`,
        });
      }
      // rev-parse prefers same-named branches/tags over short hashes.
      const resolveHead = git.resolveCommit({ cwd: workspaceRoot, revision: sha }).pipe(
        Effect.filterOrFail(
          ({ commitSha }) => commitSha.startsWith(sha),
          ({ commitSha }) =>
            new PullRequestOperationError({
              operation: "generateReviewGuide",
              detail: `${sha} names ${commitSha} here, a branch or tag rather than the commit.`,
            }),
        ),
      );
      const fetchAndResolve = (ref: string) => fetch([ref]).pipe(Effect.andThen(resolveHead));
      const headRef = sourceControlDefinitions.get(detail.provider).changeRequestHeadRef?.(number);
      const branchRef = `refs/heads/${branch}`;
      const checkBranch = git.execute({
        operation: "PullRequestReviewGuideService.checkHeadBranch",
        cwd: workspaceRoot,
        args: ["check-ref-format", branchRef],
      });
      const sources = [
        { source: "local objects", head: resolveHead },
        ...(sha.length === 40 || sha.length === 64
          ? [{ source: "the commit", head: fetchAndResolve(sha) }]
          : []),
        {
          source: `branch ${branch}`,
          head: checkBranch.pipe(Effect.andThen(fetchAndResolve(branchRef))),
        },
        ...(headRef === undefined ? [] : [{ source: headRef, head: fetchAndResolve(headRef) }]),
      ];
      const failures: Array<string> = [];
      for (const { source, head } of sources) {
        const result = yield* Effect.result(head);
        if (Result.isSuccess(result)) return result.success;
        failures.push(`${source}: ${result.failure.detail}`);
      }
      return yield* new PullRequestOperationError({
        operation: "generateReviewGuide",
        detail: `Could not find head ${sha} of #${number}. ${failures.join(" ")}`,
      });
    });
    const resolvedHead = yield* fetchHead(detail.number, headSha, detail.headBranch);
    const layers: ReadonlyArray<ReviewGuideStackLayer> = yield* Effect.forEach(
      stack?.layers ?? [],
      (layer) => {
        const described = { number: layer.number, title: layer.title ?? null, state: layer.state };
        if (layer.number === detail.number) return Effect.succeed({ ...described, headSha });
        const sha = layer.headSha;
        if (sha === undefined) return Effect.succeed({ ...described, headSha: null });
        return fetchHead(layer.number, sha, layer.headBranch).pipe(
          Effect.map(({ commitSha }) => ({ ...described, headSha: commitSha })),
          Effect.catch((error) =>
            Effect.logInfo("Review guide could not read a stack layer's head", {
              layer: layer.number,
              detail: error.detail,
            }).pipe(Effect.as({ ...described, headSha: null })),
          ),
        );
      },
      { concurrency: 4 },
    );
    const directory = yield* scratchDirectory(checkout.host);
    const path = `${directory}/checkout`;
    yield* git.execute({
      operation: "PullRequestReviewGuideService.addWorktree",
      cwd: workspaceRoot,
      // Scratch checkout for reading the change: repository hooks (installs, LFS) only slow or fail it.
      args: [
        "-c",
        "core.hooksPath=/dev/null",
        "worktree",
        "add",
        "--detach",
        "--quiet",
        path,
        resolvedHead.commitSha,
      ],
      timeoutMs: 5 * 60_000,
    });
    yield* Effect.addFinalizer(() =>
      git
        .removeWorktree({ cwd: workspaceRoot, path, force: true })
        .pipe(Effect.ignore({ log: true })),
    );
    const mergeBase = yield* git.execute({
      operation: "PullRequestReviewGuideService.mergeBase",
      cwd: path,
      args: ["merge-base", baseTip.commitSha, "HEAD"],
    });
    return { path, baseCommit: mergeBase.stdout.trim(), stack: layers };
  });

  const readChange = Effect.fn("PullRequestReviewGuideService.readChange")(function* (
    cwd: string,
    baseCommit: string,
  ) {
    const diff = (args: ReadonlyArray<string>) =>
      git
        .execute({
          operation: "PullRequestReviewGuideService.readChange",
          cwd,
          // Override user diff prefixes so the parser can find headers.
          args: [
            "-c",
            "core.quotePath=false",
            "diff",
            ...PATCH_RENDER_PREFIX_ARGS,
            ...args,
            `${baseCommit}...HEAD`,
          ],
          timeoutMs: 60_000,
          maxOutputBytes: 64 * 1024 * 1024,
        })
        .pipe(Effect.map((result) => result.stdout));
    const [nameOnly, patch] = yield* Effect.all(
      [
        diff(["--name-only", "-z"]),
        diff(["--unified=0", "--no-color", "--no-ext-diff", "--no-textconv"]),
      ],
      { concurrency: "unbounded" },
    );
    return parseReviewGuideChange(nameOnly, patch);
  });

  const write = Effect.fn("PullRequestReviewGuideService.write")(function* (
    input: PullRequestRef,
    key: ThreadPullRequestKey,
    checkout: ReviewGuideCheckout,
    model: { readonly modelSelection: ModelSelection; readonly instructions: string },
    locator: RepositoryIdentity["locator"],
    detail: PullRequestDetail,
    headSha: string,
    runId: string,
    owns: Effect.Effect<boolean>,
  ) {
    const { modelSelection, instructions } = model;
    const [activity, stack] = yield* Effect.all(
      [
        pullRequests.activity(input),
        pullRequests.stack(input).pipe(Effect.orElseSucceed(() => null)),
      ],
      { concurrency: "unbounded" },
    );
    // A run can outlast the idle window; it counts as viewing the thread whose machine it uses.
    if (checkout.threadId !== undefined) yield* sandboxActivity.view(checkout.threadId);
    const { generated, change } = yield* checkoutHead(
      checkout,
      locator,
      detail,
      headSha,
      stack,
      runId,
    ).pipe(
      Effect.flatMap((scratch) =>
        Effect.all(
          {
            generated: textGeneration.generateReviewGuide({
              ...reviewGuideInputFromPullRequest(detail, activity, scratch.baseCommit),
              cwd: scratch.path,
              modelSelection,
              instructions,
              stack: scratch.stack,
            }),
            change: readChange(scratch.path, scratch.baseCommit),
          },
          { concurrency: "unbounded" },
        ),
      ),
      Effect.scoped,
    );
    const guide: PullRequestReviewGuide = {
      headSha,
      generatedAt: yield* nowIso,
      modelSelection,
      ...normalizeReviewGuide(generated, change),
    };
    yield* ownership.withPermits(1)(
      Effect.gen(function* () {
        if (yield* owns) yield* guides.put(key, guide);
      }),
    );
  });

  const failureDetail = (cause: Cause.Cause<unknown>): string => {
    const error = Cause.squash(cause);
    if (error instanceof Error && "detail" in error && typeof error.detail === "string") {
      return error.detail;
    }
    return "The review guide could not be written.";
  };

  const generate: PullRequestReviewGuideService["Service"]["generate"] = Effect.fn(
    "PullRequestReviewGuideService.generate",
  )(function* (input, requester) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestOperationError({
            operation: "generateReviewGuide",
            detail: "Could not read the server settings.",
            cause,
          }),
      ),
    );
    if (!settings.reviewGuidesEnabled) {
      return yield* new PullRequestOperationError({
        operation: "generateReviewGuide",
        detail: "Review guides are off. Turn them on in Settings → Source Control.",
      });
    }
    const { key, workspaceRoot, identity } = yield* keyFor(input);
    const locator = yield* requireOwnRepository(key, identity);
    const projectSettings = resolveProjectSettings(settings, input.projectId).settings;
    const model = {
      modelSelection: ServerSettings.resolveReviewGuideModelSelection(
        projectSettings,
        yield* providerRegistry.getProviders,
        input.projectId,
      ),
      instructions: projectSettings.reviewGuideInstructions,
    };
    // The machine's agent can read the credential, so a member's own account never goes there.
    if (
      config.cloudOnly &&
      providerInstanceOwner(settings, model.modelSelection.instanceId) !== undefined
    ) {
      return yield* refuse(
        "Review guides on Pair Cloud run on a team account, and this guide's model is a member's own. Pick a team account for Review guide model in Settings → Source Control.",
      );
    }
    const checkout: ReviewGuideCheckout = config.cloudOnly
      ? yield* machineCheckout(key, input.projectId, requester)
      : { root: workspaceRoot, host: hosts.local, threadId: undefined };
    const runKey = keyString(key);
    yield* pullRequests.invalidate({ reference: input });
    const [detail, stored] = yield* Effect.all([pullRequests.detail(input), readStored(key)], {
      concurrency: "unbounded",
    });
    const currentHeadSha = detail.headSha ?? null;
    if (currentHeadSha === null) {
      return yield* new PullRequestOperationError({
        operation: "generateReviewGuide",
        detail: "This host did not report the pull request's head commit.",
      });
    }
    const running: PullRequestReviewGuideRun = {
      _tag: "Running",
      headSha: currentHeadSha,
      startedAt: yield* nowIso,
    };
    // Claim atomically and re-read the head so stale clicks cannot replace a newer head's run.
    const claimed = yield* ownership.withPermits(1)(
      pullRequests.detail(input).pipe(
        Effect.flatMap((latest) =>
          (latest.headSha ?? null) !== currentHeadSha
            ? Effect.fail(
                new PullRequestOperationError({
                  operation: "generateReviewGuide",
                  detail: "The pull request changed while the guide was starting. Try again.",
                }),
              )
            : Ref.modify(runs, (current) => {
                const existing = current.get(runKey);
                if (existing?._tag === "Running" && existing.headSha === currentHeadSha) {
                  return [existing, current] as const;
                }
                return [running, new Map(current).set(runKey, running)] as const;
              }),
        ),
      ),
    );
    if (claimed !== running) return { guide: stored, run: claimed, currentHeadSha, started: false };

    const owns = Ref.get(runs).pipe(Effect.map((current) => current.get(runKey) === running));
    const finish = (next: PullRequestReviewGuideRun | null) =>
      Ref.update(runs, (current) => {
        if (current.get(runKey) !== running) return current;
        const updated = new Map(current);
        if (next === null) updated.delete(runKey);
        else updated.set(runKey, next);
        return updated;
      });
    const runId = `${runCounter++}`;
    yield* write(input, key, checkout, model, locator, detail, currentHeadSha, runId, owns).pipe(
      Effect.andThen(finish(null)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? finish(null)
          : Effect.logWarning("Review guide generation failed", {
              key: runKey,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.andThen(nowIso),
              Effect.flatMap((failedAt) =>
                finish({
                  _tag: "Failed",
                  headSha: currentHeadSha,
                  failedAt,
                  detail: failureDetail(cause),
                }),
              ),
            ),
      ),
      Effect.forkIn(serviceScope),
    );
    return { guide: stored, run: running, currentHeadSha, started: true };
  });

  return PullRequestReviewGuideService.of({ get, generate });
});

export const layer = Layer.effect(PullRequestReviewGuideService, make);
