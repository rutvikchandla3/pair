import {
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { EventId } from "@t3tools/contracts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadPullRequestService from "./ThreadPullRequestService.ts";
import * as WorkspaceHostTesting from "../workspaceHost/WorkspaceHostTesting.ts";
import * as WorkspaceHosts from "../workspaceHost/WorkspaceHosts.ts";
import type { SandboxHeadContext } from "../sandbox/mirror/SandboxHeadContext.ts";
import * as StoppedSandboxReads from "../sandbox/mirror/StoppedSandboxReadsService.ts";

describe("ThreadPullRequestServiceV2 project guard", () => {
  it("rejects a pull-request result when the project root changes before dispatch", () => {
    const currentProject = Option.some({
      workspaceRoot: "/workspace/replaced",
    } satisfies Pick<OrchestrationProjectShell, "workspaceRoot">);

    expect(
      ThreadPullRequestService.projectWorkspaceMatchesSnapshot(
        currentProject,
        "/workspace/original",
      ),
    ).toBe(false);
  });
});

describe("ThreadPullRequestServiceV2 reads", () => {
  const NOW = DateTime.makeUnsafe("2026-09-20T00:00:00.000Z");
  const threadShell = (id: string): OrchestrationV2ThreadShell => {
    const threadId = ThreadId.make(id);
    return {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: id,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      activeRunId: null,
      latestRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
  };

  it.effect("does not sweep branch pull requests while no client is connected", () =>
    Effect.gen(function* () {
      // Polling active branches without a connected client wastes GitHub requests.
      const thread = { ...threadShell("idle-branch-thread"), branch: "feature/idle" };
      const project: OrchestrationProjectShell = {
        id: thread.projectId,
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
      const activation = yield* Deferred.make<void>();
      const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const turnLookup = yield* Deferred.make<void>();
      const lookups: Array<{ readonly refresh: boolean }> = [];
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.fromQueue(domainEvents),
          getPullRequestSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 1,
              threads: [thread],
              archivedThreads: [],
            }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed([project]),
          getShell: () => Effect.succeedSome(project),
        }),
        Layer.mock(GitManager.GitManager)({
          branchPullRequest: (_input, options) =>
            Effect.gen(function* () {
              const refresh = options?.refresh ?? false;
              lookups.push({ refresh });
              if (refresh) yield* Deferred.succeed(turnLookup, undefined);
              return null;
            }),
        }),
        Layer.mock(PullRequestService.PullRequestService)({
          notifyLinkedThreadsChanged: Effect.void,
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () =>
            Effect.succeed({
              canonicalKey: "github.com/acme/project",
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: "git@github.com:acme/project.git",
              },
              provider: SourceControlProviderKind.make("github"),
              owner: "acme",
              name: "project",
            }),
        }),
        // No client holds an activity lease.
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
          shouldRunOpportunisticWork: Effect.succeed(false),
        }),
        Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
        Layer.succeed(
          SecureRandom.SecureRandom,
          SecureRandom.make((size) => new Uint8Array(size).fill(1)),
        ),
        FileSystem.layerNoop({}),
        Path.layer,
      );
      yield* Effect.gen(function* () {
        const service = yield* ThreadPullRequestService.make;
        yield* service.start();
        yield* Deferred.succeed(activation, undefined);

        // A finished turn still discovers the pull request for its branch.
        yield* Queue.offer(domainEvents, {
          type: "checkpoint.captured",
          threadId: thread.id,
        } as OrchestrationV2DomainEvent);
        yield* Deferred.await(turnLookup);
        yield* service.drain;
        const lookupsBeforeIdle = lookups.length;

        yield* TestClock.adjust("10 minutes");
        yield* service.drain;

        expect(lookups.slice(lookupsBeforeIdle)).toEqual([]);
      }).pipe(
        Effect.provide(
          WorkspaceHostTesting.layerFromContext.pipe(Layer.provideMerge(dependencies)),
        ),
      );
    }),
  );

  it.effect("refreshes linked-thread readers at most every 10s while activity reorders them", () =>
    Effect.gen(function* () {
      const link = {
        host: "github.com",
        repository: "acme/web",
        number: 7,
        url: "https://github.com/acme/web/pull/7",
        source: "agent",
      };
      const linked = (id: string) =>
        ({
          type: "thread.pull-request-synced",
          threadId: ThreadId.make(id),
          payload: { ...threadShell(id), pullRequests: [link] },
        }) as unknown as OrchestrationV2DomainEvent;
      const activity = (id: string, second: number) =>
        ({
          type: "message.updated",
          threadId: ThreadId.make(id),
          occurredAt: DateTime.makeUnsafe(`2026-09-20T00:00:${String(second).padStart(2, "0")}Z`),
        }) as unknown as OrchestrationV2DomainEvent;
      const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const notified = yield* Queue.unbounded<void>();
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.fromQueue(domainEvents),
          getPullRequestSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 1,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
        Layer.mock(GitManager.GitManager)({}),
        Layer.mock(PullRequestService.PullRequestService)({
          notifyLinkedThreadsChanged: Queue.offer(notified, undefined).pipe(Effect.asVoid),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunOpportunisticWork: Effect.succeed(false),
        }),
        Layer.succeed(ServerActivation.ServerActivation, undefined),
        Layer.succeed(
          SecureRandom.SecureRandom,
          SecureRandom.make((size) => new Uint8Array(size).fill(1)),
        ),
        FileSystem.layerNoop({}),
        Path.layer,
      );
      yield* Effect.gen(function* () {
        const service = yield* ThreadPullRequestService.make;
        yield* service.start();

        yield* Queue.offerAll(domainEvents, [linked("a"), linked("b"), activity("a", 1)]);
        yield* Queue.takeN(notified, 3);
        // Two turns on threads linked to one pull request swap its top thread on every event.
        yield* Queue.offerAll(
          domainEvents,
          Array.from({ length: 20 }, (_, index) => activity(index % 2 ? "a" : "b", index + 2)),
        );
        // A link change still refreshes at once, and marks the burst as processed.
        yield* Queue.offer(domainEvents, linked("c"));
        yield* Queue.take(notified);
        expect(yield* Queue.size(notified)).toBe(0);

        yield* TestClock.adjust("10 seconds");
        yield* Queue.take(notified);
        yield* TestClock.adjust("10 seconds");
        expect(yield* Queue.size(notified)).toBe(0);
      }).pipe(
        Effect.provide(
          WorkspaceHostTesting.layerFromContext.pipe(Layer.provideMerge(dependencies)),
        ),
      );
    }),
  );

  it.effect("looks up a finished turn's branch once for all its turn-end events", () =>
    Effect.gen(function* () {
      const thread = { ...threadShell("turn-end-thread"), branch: "t3/turn-end" };
      const otherThread = {
        ...threadShell("other-turn-end-thread"),
        branch: "t3/other-turn-end",
      };
      const project: OrchestrationProjectShell = {
        id: thread.projectId,
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
      // A turn end commits its checkpoints and the run's end together. The queued
      // non-refresh request ahead of them must still become a refresh when they join it.
      const turnEnd = [
        { type: "thread.metadata-updated", threadId: thread.id, payload: thread },
        { type: "checkpoint.captured", threadId: thread.id },
        { type: "checkpoint.captured", threadId: thread.id },
        { type: "run.updated", threadId: thread.id, payload: { status: "completed" } },
        { type: "checkpoint.captured", threadId: otherThread.id },
        { type: "run.updated", threadId: otherThread.id, payload: { status: "completed" } },
      ] as Array<OrchestrationV2DomainEvent>;
      // Arrives during the thread's own lookup, which may already have read the old host state.
      const duringLookup = [
        { type: "checkpoint.captured", threadId: thread.id },
        { type: "thread.metadata-updated", threadId: thread.id, payload: thread },
      ] as unknown as Array<OrchestrationV2DomainEvent>;
      const activation = yield* Deferred.make<void>();
      const sweepStarted = yield* Deferred.make<void>();
      const turnEndQueued = yield* Deferred.make<void>();
      const lookupStarted = yield* Deferred.make<void>();
      const followUpQueued = yield* Deferred.make<void>();
      const lookups: Array<{ readonly branch: string; readonly refresh: boolean }> = [];
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          // The batch arrives while the worker is busy with the startup sweep.
          streamDomainEvents: Stream.fromEffect(Deferred.await(sweepStarted)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromIterable(turnEnd)),
            Stream.concat(
              Stream.fromEffect(Deferred.succeed(turnEndQueued, undefined)).pipe(Stream.drain),
            ),
            Stream.concat(Stream.fromEffect(Deferred.await(lookupStarted)).pipe(Stream.drain)),
            Stream.concat(Stream.fromIterable(duringLookup)),
            Stream.concat(
              Stream.fromEffect(Deferred.succeed(followUpQueued, undefined)).pipe(Stream.drain),
            ),
            Stream.concat(Stream.never),
          ),
          getPullRequestSnapshot: ({ threadId }) =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 1,
              threads: [thread, otherThread].filter(
                (candidate) => threadId === undefined || candidate.id === threadId,
              ),
              archivedThreads: [],
            }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed([project]),
          getShell: () => Effect.succeedSome(project),
        }),
        Layer.mock(GitManager.GitManager)({
          branchPullRequest: (input, options) =>
            Effect.gen(function* () {
              lookups.push({ branch: input.branch, refresh: options?.refresh ?? false });
              if (!(yield* Deferred.isDone(turnEndQueued))) {
                yield* Deferred.succeed(sweepStarted, undefined);
                yield* Deferred.await(turnEndQueued);
              } else if (
                input.branch === thread.branch &&
                !(yield* Deferred.isDone(followUpQueued))
              ) {
                yield* Deferred.succeed(lookupStarted, undefined);
                yield* Deferred.await(followUpQueued);
              }
              return null;
            }),
        }),
        Layer.mock(PullRequestService.PullRequestService)({
          notifyLinkedThreadsChanged: Effect.void,
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () =>
            Effect.succeed({
              canonicalKey: "github.com/acme/project",
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: "git@github.com:acme/project.git",
              },
              provider: SourceControlProviderKind.make("github"),
              owner: "acme",
              name: "project",
            }),
        }),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
          shouldRunOpportunisticWork: Effect.succeed(false),
        }),
        Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
        Layer.succeed(
          SecureRandom.SecureRandom,
          SecureRandom.make((size) => new Uint8Array(size).fill(1)),
        ),
        FileSystem.layerNoop({}),
        Path.layer,
      );
      yield* Effect.gen(function* () {
        const service = yield* ThreadPullRequestService.make;
        yield* service.start();
        yield* Deferred.succeed(activation, undefined);
        yield* Deferred.await(followUpQueued);
        yield* service.drain;
      }).pipe(
        Effect.provide(
          WorkspaceHostTesting.layerFromContext.pipe(Layer.provideMerge(dependencies)),
        ),
      );

      // The startup sweep, one refresh lookup per thread for its turn-end batch, then one
      // follow-up refresh for the events that arrived during the thread's lookup.
      expect(lookups).toEqual([
        { branch: thread.branch, refresh: false },
        { branch: otherThread.branch, refresh: false },
        { branch: thread.branch, refresh: true },
        { branch: otherThread.branch, refresh: true },
        { branch: thread.branch, refresh: true },
      ]);
    }),
  );

  it.effect.each([
    {
      worktree: "a linked worktree",
      worktreePath: "/workspace/worktree",
      existingPaths: ["/workspace/worktree", "/workspace/worktree/.git"],
      unreadablePaths: [],
      lookups: ["/workspace/worktree"],
    },
    // A folder that outlived its .git makes git fail with not_a_repository.
    {
      worktree: "a folder without .git",
      worktreePath: "/workspace/worktree",
      existingPaths: ["/workspace/worktree"],
      unreadablePaths: [],
      lookups: ["/workspace/project"],
    },
    {
      worktree: "a folder whose .git cannot be checked",
      worktreePath: "/workspace/worktree",
      existingPaths: ["/workspace/worktree"],
      unreadablePaths: ["/workspace/worktree/.git"],
      lookups: ["/workspace/worktree"],
    },
    {
      worktree: "a missing folder",
      worktreePath: "/workspace/worktree",
      existingPaths: [],
      unreadablePaths: [],
      lookups: ["/workspace/project"],
    },
    // Nothing wakes a stopped machine, and its branch can't move: the last link stays.
    {
      worktree: "a stopped machine's checkout",
      worktreePath: "/t3-sandbox/sbx_00000000000000000033/worktrees/main",
      existingPaths: [],
      unreadablePaths: [],
      lookups: [],
    },
    // The project root is another checkout, never the machine's branch.
    {
      worktree: "a ready machine's checkout without .git",
      worktreePath: "/t3-sandbox/sbx_00000000000000000034/worktrees/main",
      existingPaths: ["/t3-sandbox/sbx_00000000000000000034/worktrees/main"],
      unreadablePaths: [],
      lookups: [],
    },
    // A workspace's folder sits inside some checkout, whose PRs are not the workspace's.
    {
      worktree: "a workspace's folder of checkouts",
      worktreePath: "/workspace/worktree",
      existingPaths: ["/workspace/worktree"],
      unreadablePaths: [],
      lookups: [],
      roots: [{ projectId: ProjectId.make("project:api"), name: "api" }],
    },
  ] as const)(
    "looks up a branch whose worktree is $worktree in $lookups",
    ({ worktreePath, existingPaths, unreadablePaths, lookups, ...workspace }) =>
      Effect.gen(function* () {
        const thread = {
          ...threadShell("worktree-thread"),
          settledOverride: "settled" as const,
          settledAt: NOW,
          branch: "feature/worktree",
          worktreePath,
        };
        const project: OrchestrationProjectShell = {
          id: thread.projectId,
          title: "Project",
          workspaceRoot: "/workspace/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          ...workspace,
        };
        const activation = yield* Deferred.make<void>();
        const sweepStarted = yield* Deferred.make<void>();
        const lookupCwds: Array<string> = [];
        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.never,
            getPullRequestSnapshot: () =>
              Deferred.succeed(sweepStarted, undefined).pipe(
                Effect.as({
                  schemaVersion: 2,
                  snapshotSequence: 1,
                  threads: [thread],
                  archivedThreads: [],
                }),
              ),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([project]),
            getShell: () => Effect.succeedSome(project),
          }),
          Layer.mock(GitManager.GitManager)({
            branchPullRequest: (input) =>
              Effect.sync(() => {
                lookupCwds.push(input.cwd);
                return null;
              }),
          }),
          Layer.mock(PullRequestService.PullRequestService)({
            notifyLinkedThreadsChanged: Effect.void,
          }),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () =>
              Effect.succeed({
                canonicalKey: "github.com/acme/project",
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: "git@github.com:acme/project.git",
                },
                provider: SourceControlProviderKind.make("github"),
                owner: "acme",
                name: "project",
              }),
          }),
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(1)),
          ),
          FileSystem.layerNoop({
            exists: (path) =>
              unreadablePaths.some((entry) => entry === path)
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "exists",
                      pathOrDescriptor: path,
                    }),
                  )
                : Effect.succeed(existingPaths.some((entry) => entry === path)),
          }),
          Path.layer,
        );
        yield* Effect.gen(function* () {
          const hosts = yield* WorkspaceHosts.WorkspaceHosts;
          yield* hosts.register("/t3-sandbox/sbx_00000000000000000034", hosts.local);
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          yield* Deferred.await(sweepStarted);
          yield* service.drain;
        }).pipe(
          Effect.provide(
            WorkspaceHostTesting.layerFromContext.pipe(Layer.provideMerge(dependencies)),
          ),
        );

        expect(lookupCwds).toEqual(lookups);
      }),
  );

  it.effect(
    "finds a PR for an asleep cloud thread from its recorded head without touching the sandbox path",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // A side chat sorts first; the owner named the snapshot and holds the record.
          const worktreePath = "/t3-sandbox/sbx_00000000000000000033/worktrees/main";
          const asleep = (id: string) => ({
            ...threadShell(id),
            branch: "feature/asleep",
            worktreePath,
          });
          const sideChat = asleep("asleep-side-chat");
          const ownerThread = asleep("asleep-owner");
          const head: SandboxHeadContext = {
            version: 1,
            capturedAt: NOW,
            branch: "feature/asleep",
            headOid: "a".repeat(40),
            upstream: { remoteName: "origin", remoteRef: "refs/heads/feature/asleep" },
            remotes: [{ name: "origin", url: "git@github.com:acme/project.git" }],
            defaultBranch: "main",
          };
          const project: OrchestrationProjectShell = {
            id: sideChat.projectId,
            title: "Project",
            workspaceRoot: "/workspace/project",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          };
          const activation = yield* Deferred.make<void>();
          const sweepStarted = yield* Deferred.make<void>();
          const commands: Array<OrchestrationV2ServerCommand> = [];
          const recordedLookups: Array<{ readonly cwd: string; readonly head: unknown }> = [];
          const dependencies = Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.never,
              getPullRequestSnapshot: () =>
                Deferred.succeed(sweepStarted, undefined).pipe(
                  Effect.as({
                    schemaVersion: 2,
                    snapshotSequence: 1,
                    threads: [sideChat, ownerThread],
                    archivedThreads: [],
                  }),
                ),
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: 2, storedEvents: [] };
                }),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed([project]),
              getShell: () => Effect.succeedSome(project),
            }),
            Layer.mock(GitManager.GitManager)({
              branchPullRequest: () => Effect.die("git must not run for a sleeping machine"),
              pullRequestForRecordedHead: (input) =>
                Effect.sync(() => {
                  recordedLookups.push(input);
                  return {
                    number: 7,
                    title: "Opened while asleep",
                    url: "https://github.com/acme/project/pull/7",
                    baseRef: "main",
                    headRef: "feature/asleep",
                    state: "open" as const,
                    repositoryKey: "github.com/acme/project",
                    updatedAt: "2026-09-20T00:00:00.000Z",
                  };
                }),
            }),
            Layer.mock(StoppedSandboxReads.StoppedSandboxReads)({
              headContext: (threadId) => Effect.succeed(threadId === ownerThread.id ? head : null),
            }),
            Layer.mock(PullRequestService.PullRequestService)({
              notifyLinkedThreadsChanged: Effect.void,
            }),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () =>
                Effect.succeed({
                  canonicalKey: "github.com/acme/project",
                  locator: {
                    source: "git-remote" as const,
                    remoteName: "origin",
                    remoteUrl: "git@github.com:acme/project.git",
                  },
                  provider: SourceControlProviderKind.make("github"),
                  owner: "acme",
                  name: "project",
                }),
            }),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => new Uint8Array(size).fill(1)),
            ),
            FileSystem.layerNoop({
              exists: () => Effect.die("no file check at a sleeping machine's path"),
            }),
            Path.layer,
          );
          yield* Effect.gen(function* () {
            const service = yield* ThreadPullRequestService.make;
            yield* service.start();
            yield* Deferred.succeed(activation, undefined);
            yield* Deferred.await(sweepStarted);
            yield* service.drain;
          }).pipe(
            Effect.provide(
              WorkspaceHostTesting.layerFromContext.pipe(Layer.provideMerge(dependencies)),
            ),
          );

          expect(recordedLookups[0]).toEqual({ cwd: project.workspaceRoot, head });
          const reference = {
            projectId: project.id,
            repository: "acme/project",
            number: 7,
            url: "https://github.com/acme/project/pull/7",
          };
          expect(commands).toMatchObject(
            [sideChat, ownerThread].map((thread) => ({
              type: "thread.pull-request.sync",
              threadId: thread.id,
              branchPullRequest: reference,
            })),
          );
          expect(commands).toHaveLength(2);
        }),
      ),
  );

  it.effect.each([
    { linked: "nothing", existing: [], discovered: ["api", "web"], asleep: false },
    // An earlier sync linked api's pull request; web's joins it without clearing it.
    { linked: "api's pull request", existing: ["api"], discovered: ["web"], asleep: false },
    // Each repository's head comes from its root project's mirror; the machine stays asleep.
    {
      linked: "nothing on a sleeping machine",
      existing: [],
      discovered: ["api", "web"],
      asleep: true,
    },
  ] as const)(
    "links each workspace repository's pull request when $linked is linked",
    ({ existing, discovered, asleep }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const folder = asleep
            ? "/t3-sandbox/sbx_00000000000000000034/worktrees/feature"
            : "/worktrees/stack/feature";
          const roots = ["api", "web"].map((name) => ({
            projectId: ProjectId.make(`project:${name}`),
            name,
          }));
          const pullRequest = (name: string) => ({
            host: "github.com",
            repository: `acme/${name}`,
            number: name === "api" ? 11 : 12,
            url: `https://github.com/acme/${name}/pull/${name === "api" ? 11 : 12}`,
          });
          const thread = {
            ...threadShell("workspace-thread"),
            projectId: ProjectId.make("project:stack"),
            branch: "feature",
            worktreePath: folder,
            roots,
            pullRequests: existing.map((name) => ({
              ...pullRequest(name),
              source: "manual" as const,
              linkedAt: "2026-09-19T00:00:00.000Z",
              snapshot: null,
              stack: null,
            })),
          };
          const project = (id: ProjectId, workspaceRoot: string): OrchestrationProjectShell => ({
            id,
            title: id,
            workspaceRoot,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          });
          const workspace = { ...project(thread.projectId, "/workspaces/stack"), roots };
          const projects = [
            workspace,
            ...roots.map((root) => project(root.projectId, `/repos/${root.name}`)),
          ];
          const activation = yield* Deferred.make<void>();
          const sweepStarted = yield* Deferred.make<void>();
          const commands: Array<OrchestrationV2ServerCommand> = [];
          const lookupCwds: Array<string> = [];
          const headFor = (projectId: ProjectId): SandboxHeadContext => {
            const name = roots.find((root) => root.projectId === projectId)!.name;
            return {
              version: 1,
              capturedAt: NOW,
              branch: "feature",
              headOid: (name === "api" ? "a" : "b").repeat(40),
              upstream: { remoteName: "origin", remoteRef: "refs/heads/feature" },
              remotes: [{ name: "origin", url: `git@github.com:acme/${name}.git` }],
              defaultBranch: "main",
            };
          };
          const detectedFor = (name: string, headRef: string) => ({
            number: pullRequest(name).number,
            title: name,
            url: pullRequest(name).url,
            baseRef: "main",
            headRef,
            state: "open" as const,
            repositoryKey: `github.com/acme/${name}`,
            updatedAt: "2026-09-20T00:00:00.000Z",
          });
          const dependencies = Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.never,
              getPullRequestSnapshot: () =>
                Deferred.succeed(sweepStarted, undefined).pipe(
                  Effect.as({
                    schemaVersion: 2,
                    snapshotSequence: 1,
                    threads: [thread],
                    archivedThreads: [],
                  }),
                ),
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: 2, storedEvents: [] };
                }),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed(projects),
              getShell: (id) =>
                Effect.succeed(Option.fromNullishOr(projects.find((entry) => entry.id === id))),
            }),
            Layer.mock(GitManager.GitManager)({
              branchPullRequest: (input) =>
                asleep
                  ? Effect.die("git must not run for a sleeping machine")
                  : Effect.sync(() => {
                      lookupCwds.push(input.cwd);
                      return detectedFor(input.cwd.split("/").at(-1)!, input.branch);
                    }),
              pullRequestForRecordedHead: (input) =>
                Effect.sync(() => {
                  const name = input.cwd.split("/").at(-1)!;
                  expect(input.head).toEqual(headFor(ProjectId.make(`project:${name}`)));
                  lookupCwds.push(input.cwd);
                  return detectedFor(name, input.head.branch);
                }),
            }),
            Layer.mock(StoppedSandboxReads.StoppedSandboxReads)({
              headContext: (threadId, projectId) =>
                threadId === thread.id && projectId !== undefined
                  ? Effect.succeed(headFor(projectId))
                  : Effect.die("a workspace reads each repository's own head"),
            }),
            Layer.mock(PullRequestService.PullRequestService)({
              notifyLinkedThreadsChanged: Effect.void,
            }),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: (cwd) => {
                const name = cwd.split("/").at(-1)!;
                return Effect.succeed({
                  canonicalKey: `github.com/acme/${name}`,
                  locator: {
                    source: "git-remote" as const,
                    remoteName: "origin",
                    remoteUrl: `git@github.com:acme/${name}.git`,
                  },
                  provider: SourceControlProviderKind.make("github"),
                  owner: "acme",
                  name,
                });
              },
            }),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => new Uint8Array(size).fill(1)),
            ),
            FileSystem.layerNoop({
              exists: () =>
                asleep
                  ? Effect.die("no file check at a sleeping machine's path")
                  : Effect.succeed(true),
            }),
            Path.layer,
          );
          yield* Effect.gen(function* () {
            const service = yield* ThreadPullRequestService.make;
            yield* service.start();
            yield* Deferred.succeed(activation, undefined);
            yield* Deferred.await(sweepStarted);
            yield* service.drain;
          }).pipe(
            Effect.provide(
              WorkspaceHostTesting.layerFromContext.pipe(Layer.provideMerge(dependencies)),
            ),
          );

          // Asleep, each lookup runs at the root project's checkout on the server.
          expect(new Set(lookupCwds)).toEqual(
            new Set(
              roots.map((root) => (asleep ? `/repos/${root.name}` : `${folder}/${root.name}`)),
            ),
          );
          expect(commands).toEqual([
            expect.objectContaining({
              type: "thread.pull-request.sync",
              threadId: thread.id,
              projectId: workspace.id,
              expected: expect.objectContaining({ workspaceRoot: "/workspaces/stack" }),
              branchPullRequest: null,
              discoveredPullRequests: discovered.map(pullRequest),
            }),
          ]);
        }),
      ),
  );

  it.effect.each([
    // The repositories are the project's own checkouts, each on whatever branch it is on.
    { name: "in the project folder", checkouts: "/workspace/wrapper", branch: null },
    // The repositories are the thread's worktrees; `web` stands for a checkout off its branch.
    { name: "in a task folder", checkouts: "/worktrees/wrapper/task", branch: "feature/api" },
  ])(
    "links the open pull request of each tracked repository a thread $name changed",
    ({ checkouts, branch }) =>
      Effect.scoped(
        Effect.gen(function* () {
          let thread: OrchestrationV2ThreadShell = {
            ...threadShell("repositories-thread"),
            branch,
            worktreePath: branch === null ? null : checkouts,
          };
          const project: OrchestrationProjectShell = {
            id: thread.projectId,
            title: "Wrapper",
            workspaceRoot: "/workspace/wrapper",
            trackedFolders: ["api", "web", "docs"].map((name) => ({
              name,
              path: `/workspace/wrapper/${name}`,
            })),
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          };
          const activation = yield* Deferred.make<void>();
          const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
          const lookedUp = yield* Queue.unbounded<void>();
          const lookups: Array<{ readonly cwd: string; readonly branch: string }> = [];
          const dispatched: Array<OrchestrationV2ServerCommand> = [];
          const dependencies = Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromQueue(domainEvents),
              getPullRequestSnapshot: () =>
                Effect.sync(() => ({
                  schemaVersion: 2,
                  snapshotSequence: 1,
                  threads: [thread],
                  archivedThreads: [],
                })),
              // The thread changed api and web, and a folder the project no longer tracks.
              getCheckpointContext: () =>
                Effect.succeed({
                  runs: [],
                  checkpoints: [],
                  checkpointScopes: ["api", "web", "removed"].map((name) => ({
                    id: `scope-${name}`,
                    runId: null,
                    kind: "manual",
                    cwd: `${checkouts}/${name}`,
                    repositoryPath: `/workspace/wrapper/${name}`,
                  })),
                } as never),
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatched.push(command as OrchestrationV2ServerCommand);
                  return {} as never;
                }),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed([project]),
              getShell: () => Effect.succeedSome(project),
            }),
            Layer.mock(GitManager.GitManager)({
              localStatus: ({ cwd }) =>
                Effect.succeed({
                  isRepo: true,
                  refName: cwd.endsWith("/api")
                    ? "feature/api"
                    : branch === null
                      ? "main"
                      : "other",
                  isDefaultRef: !cwd.endsWith("/api") && branch === null,
                } as never),
              branchPullRequest: (input) =>
                Queue.offer(lookedUp, undefined).pipe(
                  Effect.map(() => {
                    lookups.push(input);
                    return {
                      number: 7,
                      title: "API change",
                      url: "https://github.com/Acme/API/pull/7",
                      baseRef: "main",
                      headRef: input.branch,
                      state: "open" as const,
                      repositoryKey: "github.com/acme/api",
                      updatedAt: null,
                    };
                  }),
                ),
            }),
            Layer.mock(PullRequestService.PullRequestService)({}),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({
              shouldRunScopeWork: () => Effect.succeed(false),
              shouldRunOpportunisticWork: Effect.succeed(false),
            }),
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => new Uint8Array(size).fill(1)),
            ),
            FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
            Path.layer,
          );
          yield* Effect.gen(function* () {
            const service = yield* ThreadPullRequestService.make;
            yield* service.start();
            yield* Deferred.succeed(activation, undefined);
            // The startup sweep asks no repository.
            yield* service.drain;
            expect(lookups).toEqual([]);

            const turnEnd = {
              type: "checkpoint.captured",
              threadId: thread.id,
            } as OrchestrationV2DomainEvent;
            yield* Queue.offer(domainEvents, turnEnd);
            yield* Queue.take(lookedUp);
            yield* service.drain;

            // Only the repository on a branch of its own is asked, and nothing touches the
            // thread's own branch.
            expect(lookups).toEqual([{ cwd: `${checkouts}/api`, branch: "feature/api" }]);
            expect(dispatched).toMatchObject([
              {
                type: "thread.pull-request.link",
                threadId: thread.id,
                host: "github.com",
                repository: "acme/api",
                number: 7,
                source: "created",
              },
            ]);

            thread = {
              ...thread,
              pullRequests: [
                {
                  host: "github.com",
                  repository: "acme/api",
                  number: 7,
                  url: "https://github.com/acme/api/pull/7",
                  source: "created",
                  linkedAt: "2026-09-20T00:00:00.000Z",
                  snapshot: null,
                  stack: null,
                },
              ],
            };
            yield* Queue.offer(domainEvents, turnEnd);
            yield* Queue.take(lookedUp);
            yield* service.drain;
            expect(dispatched).toHaveLength(1);
          }).pipe(
            Effect.provide(
              WorkspaceHostTesting.layerFromContext.pipe(Layer.provideMerge(dependencies)),
            ),
          );
        }),
      ),
  );

  it.effect("leaves delegated child threads to their own refresh instead of the sweep", () =>
    Effect.gen(function* () {
      const parent = {
        ...threadShell("parent-thread"),
        branch: "feature/parent",
        worktreePath: "/workspace/parent",
      };
      const child: OrchestrationV2ThreadShell = {
        ...threadShell("child-thread"),
        branch: "t3/reply-ok",
        worktreePath: "/workspace/child",
        lineage: {
          rootThreadId: parent.id,
          parentThreadId: parent.id,
          relationshipToParent: "subagent",
        },
      };
      const project: OrchestrationProjectShell = {
        id: parent.projectId,
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
      const activation = yield* Deferred.make<void>();
      const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const sweeps = yield* Queue.unbounded<void>();
      const childLookup = yield* Deferred.make<void>();
      const lookups: Array<{ readonly branch: string; readonly refresh: boolean }> = [];
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.fromQueue(domainEvents),
          getPullRequestSnapshot: ({ threadId }) =>
            threadId !== undefined
              ? Effect.succeed({ snapshotSequence: 1, threads: [child] })
              : Queue.offer(sweeps, undefined).pipe(
                  Effect.as({
                    schemaVersion: 2,
                    snapshotSequence: 1,
                    threads: [parent, child],
                    archivedThreads: [],
                  }),
                ),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed([project]),
          getShell: () => Effect.succeedSome(project),
        }),
        Layer.mock(GitManager.GitManager)({
          branchPullRequest: (input, options) =>
            Effect.gen(function* () {
              const refresh = options?.refresh ?? false;
              lookups.push({ branch: input.branch, refresh });
              if (input.branch === child.branch && refresh) {
                yield* Deferred.succeed(childLookup, undefined);
              }
              return null;
            }),
        }),
        Layer.mock(PullRequestService.PullRequestService)({
          notifyLinkedThreadsChanged: Effect.void,
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () =>
            Effect.succeed({
              canonicalKey: "github.com/acme/project",
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: "git@github.com:acme/project.git",
              },
              provider: SourceControlProviderKind.make("github"),
              owner: "acme",
              name: "project",
            }),
        }),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(true),
          shouldRunOpportunisticWork: Effect.succeed(true),
        }),
        Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
        Layer.succeed(
          SecureRandom.SecureRandom,
          SecureRandom.make((size) => new Uint8Array(size).fill(1)),
        ),
        FileSystem.layerNoop({}),
        Path.layer,
      );
      yield* Effect.gen(function* () {
        const service = yield* ThreadPullRequestService.make;
        yield* service.start();
        yield* Deferred.succeed(activation, undefined);

        // Startup backfill sweep, then periodic sweeps: a branch without a pull request
        // is reread after half an hour, not on every sweep.
        yield* Queue.take(sweeps);
        yield* service.drain;
        for (let minute = 1; minute <= 29; minute += 1) {
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(sweeps);
          yield* service.drain;
        }
        expect(lookups.map((lookup) => lookup.branch)).toEqual([parent.branch]);
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(sweeps);
        yield* service.drain;
        const sweepLookups = lookups.map((lookup) => lookup.branch).toSorted();

        // The child's own turn still discovers its pull request.
        yield* Queue.offer(domainEvents, {
          type: "checkpoint.captured",
          threadId: child.id,
        } as OrchestrationV2DomainEvent);
        yield* Deferred.await(childLookup);
        yield* service.drain;

        expect(sweepLookups).toEqual([parent.branch, parent.branch]);
        expect(lookups.slice(sweepLookups.length)).toEqual([
          { branch: child.branch, refresh: true },
        ]);
      }).pipe(
        Effect.provide(
          WorkspaceHostTesting.layerFromContext.pipe(Layer.provideMerge(dependencies)),
        ),
      );
    }),
  );

  it.effect("startup backfill looks up a branch once for threads whose worktrees are gone", () =>
    Effect.gen(function* () {
      // Removed worktree folders all fall back to the project root, so they share one lookup.
      const shared = ["a", "b", "c", "d"].map((suffix) => ({
        ...threadShell(`gone-worktree-${suffix}`),
        branch: "feature/shared",
        worktreePath: `/workspace/worktrees/gone-${suffix}`,
        settledAt: NOW,
      }));
      // Every start repeats the backfill, so it reads only the most recently updated threads.
      const older = Array.from({ length: 100 }, (_, index) => ({
        ...threadShell(`old-${index}`),
        branch: `t3/old-${index}`,
        worktreePath: `/workspace/worktrees/old-${index}`,
        settledAt: NOW,
        updatedAt: DateTime.subtract(NOW, { minutes: index + 1 }),
      }));
      const threads = [...older.toReversed(), ...shared];
      const project: OrchestrationProjectShell = {
        id: threads[0]!.projectId,
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
      const activation = yield* Deferred.make<void>();
      const sweeps = yield* Queue.unbounded<void>();
      const lookups: Array<{ readonly cwd: string; readonly branch: string }> = [];
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.never,
          getPullRequestSnapshot: () =>
            Queue.offer(sweeps, undefined).pipe(
              Effect.as({
                schemaVersion: 2,
                snapshotSequence: 1,
                threads,
                archivedThreads: [],
              }),
            ),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed([project]),
          getShell: () => Effect.succeedSome(project),
        }),
        Layer.mock(GitManager.GitManager)({
          branchPullRequest: (input) =>
            Effect.sync(() => {
              lookups.push({ cwd: input.cwd, branch: input.branch });
              return null;
            }),
        }),
        Layer.mock(PullRequestService.PullRequestService)({
          notifyLinkedThreadsChanged: Effect.void,
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () =>
            Effect.succeed({
              canonicalKey: "github.com/acme/project",
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: "git@github.com:acme/project.git",
              },
              provider: SourceControlProviderKind.make("github"),
              owner: "acme",
              name: "project",
            }),
        }),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(true),
          shouldRunOpportunisticWork: Effect.succeed(true),
        }),
        Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
        Layer.succeed(
          SecureRandom.SecureRandom,
          SecureRandom.make((size) => new Uint8Array(size).fill(1)),
        ),
        FileSystem.layerNoop({}),
        Path.layer,
      );
      yield* Effect.gen(function* () {
        const service = yield* ThreadPullRequestService.make;
        yield* service.start();
        yield* Deferred.succeed(activation, undefined);

        yield* Queue.take(sweeps);
        yield* service.drain;

        expect(lookups.map((lookup) => lookup.branch).toSorted()).toEqual(
          ["feature/shared", ...older.slice(0, 60).map((thread) => thread.branch)].toSorted(),
        );
        expect(lookups.every((lookup) => lookup.cwd === project.workspaceRoot)).toBe(true);
      }).pipe(Effect.provide(dependencies));
    }),
  );

  it.effect.each([
    { state: "open", checkedOut: false },
    { state: "merged", checkedOut: false },
    { state: "closed", checkedOut: false },
    { state: "merged", checkedOut: true },
  ] as const)(
    "associates a $state branch PR (checkedOut=$checkedOut) only with threads that predate its completion or saved it",
    ({ state, checkedOut }) =>
      Effect.gen(function* () {
        const reference = {
          projectId: ProjectId.make("project-1"),
          repository: "acme/project",
          number: 42,
          url: "https://github.com/acme/project/pull/42",
        };
        const terminalAt = "2026-09-19T00:00:00.000Z";
        const detected = {
          number: 42,
          url: reference.url,
          title: "Previous staging work",
          baseRef: "main",
          headRef: "staging",
          state,
          updatedAt: terminalAt,
          closedAt: state === "closed" ? terminalAt : null,
          mergedAt: state === "merged" ? terminalAt : null,
          repositoryKey: "github.com/acme/project",
        };
        const threads = [
          { ...threadShell("older"), createdAt: DateTime.makeUnsafe("2026-09-18T00:00:00Z") },
          { ...threadShell("same-time"), createdAt: DateTime.makeUnsafe(terminalAt) },
          threadShell("new"),
          { ...threadShell("saved"), branchPullRequest: reference },
          { ...threadShell("explicit"), linkedPullRequest: reference },
        ].map((thread) => ({ ...thread, branch: "staging" }));
        const project: OrchestrationProjectShell = {
          id: reference.projectId,
          title: "Project",
          workspaceRoot: "/workspace/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        };
        const activation = yield* Deferred.make<void>();
        const sweepStarted = yield* Deferred.make<void>();
        const commands: Array<OrchestrationV2ServerCommand> = [];
        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.never,
            getPullRequestSnapshot: () =>
              Deferred.succeed(sweepStarted, undefined).pipe(
                Effect.as({ snapshotSequence: 1, threads }),
              ),
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: 2, storedEvents: [] };
              }),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([project]),
            getShell: () => Effect.succeedSome(project),
          }),
          Layer.mock(GitManager.GitManager)({
            branchPullRequest: () => Effect.succeed(detected),
            checkedOutPullRequest: () => Effect.succeed(checkedOut),
          }),
          Layer.mock(PullRequestService.PullRequestService)({
            summary: () =>
              Effect.succeed({
                ...detected,
                ...reference,
                provider: SourceControlProviderKind.make("github"),
                baseBranch: detected.baseRef,
                headBranch: detected.headRef,
              }),
          }),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () =>
              Effect.succeed({
                canonicalKey: "github.com/acme/project",
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: "git@github.com:acme/project.git",
                },
                provider: SourceControlProviderKind.make("github"),
                owner: "acme",
                name: "project",
              }),
          }),
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(1)),
          ),
          FileSystem.layerNoop({}),
          Path.layer,
        );
        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          yield* Deferred.await(sweepStarted);
          yield* service.drain;
        }).pipe(
          Effect.provide(
            WorkspaceHostTesting.layerFromContext.pipe(Layer.provideMerge(dependencies)),
          ),
        );

        expect(
          commands.map((command) => {
            if (command.type !== "thread.pull-request.sync") throw new Error(command.type);
            expect(command).not.toHaveProperty("linkedPullRequest");
            return [command.threadId, command.branchPullRequest];
          }),
        ).toEqual(
          (state === "open" || checkedOut
            ? ["older", "same-time", "new", "explicit"]
            : ["older", "same-time"]
          ).map((id) => [id, reference]),
        );
      }),
  );

  it.effect.each([
    { state: "closed", sameBranch: false },
    { state: "merged", sameBranch: false },
    { state: "closed", sameBranch: true },
    { state: "merged", sameBranch: true },
  ] as const)(
    "restores a $state automatic PR only for its own branch (sameBranch=$sameBranch)",
    ({ state, sameBranch }) =>
      Effect.gen(function* () {
        const savedReference = {
          projectId: ProjectId.make("project-1"),
          repository: "acme/project",
          number: 42,
          url: "https://github.com/acme/project/pull/42",
        };
        const thread = {
          ...threadShell("branch-pr-thread"),
          branch: "main",
          branchPullRequest: savedReference,
          linkedPullRequest: savedReference,
        };
        const project: OrchestrationProjectShell = {
          id: thread.projectId,
          title: "Project",
          workspaceRoot: "/workspace/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        };
        const activation = yield* Deferred.make<void>();
        const sweepStarted = yield* Deferred.make<void>();
        const commands: Array<OrchestrationV2ServerCommand> = [];
        let snapshotThread: unknown;
        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.never,
            getPullRequestSnapshot: (options) =>
              Effect.gen(function* () {
                const store = yield* ProjectionStore.ProjectionStoreV2;
                yield* store.apply({
                  id: EventId.make(`event:${thread.id}:created`),
                  type: "thread.created",
                  threadId: thread.id,
                  occurredAt: NOW,
                  payload: { ...thread, lastVisitedAt: thread.lastVisitedAt ?? null },
                });
                const sql = yield* SqlClient.SqlClient;
                yield* sql`INSERT INTO orchestration_events (
                    sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
                    occurred_at, actor_kind, payload_json, metadata_json, application_event_version
                  ) VALUES (7, 'pr-discovery', 'thread', ${thread.id}, 1, 'thread.created',
                    '2026-09-20T00:00:00.000Z', 'system', '{}', '{}', 2)`;
                for (const table of [
                  "orchestration_v2_projection_turn_items",
                  "orchestration_v2_projection_messages",
                  "orchestration_v2_projection_provider_threads",
                  "orchestration_v2_projection_runs",
                ])
                  yield* sql.unsafe(`DROP TABLE ${table}`);
                const snapshot = yield* store.getPullRequestSnapshot(options);
                snapshotThread = snapshot.threads[0];
                yield* Deferred.succeed(sweepStarted, undefined);
                return snapshot;
              }).pipe(
                Effect.provide(
                  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
                ),
                Effect.orDie,
              ),
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: 2, storedEvents: [] };
              }),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([project]),
            getShell: () => Effect.succeedSome(project),
          }),
          Layer.mock(GitManager.GitManager)({
            branchPullRequest: () => Effect.succeed(null),
          }),
          Layer.mock(PullRequestService.PullRequestService)({
            summary: () =>
              Effect.succeed({
                ...savedReference,
                provider: SourceControlProviderKind.make("github"),
                title: "Previous branch work",
                state,
                headBranch: sameBranch ? thread.branch : "feature/previous-work",
                baseBranch: "release",
                updatedAt: "2026-09-19T00:00:00.000Z",
              }),
          }),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () =>
              Effect.succeed({
                canonicalKey: "github.com/acme/project",
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: "git@github.com:acme/project.git",
                },
                provider: SourceControlProviderKind.make("github"),
                owner: "acme",
                name: "project",
              }),
          }),
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(1)),
          ),
          FileSystem.layerNoop({}),
          Path.layer,
        );
        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          yield* Deferred.await(sweepStarted);
          yield* service.drain;
        }).pipe(
          Effect.provide(
            WorkspaceHostTesting.layerFromContext.pipe(Layer.provideMerge(dependencies)),
          ),
        );

        expect(snapshotThread).toHaveProperty("createdAt", NOW);
        if (sameBranch) {
          expect(commands).toEqual([]);
        } else {
          expect(commands).toHaveLength(1);
          expect(commands[0]).toMatchObject({
            type: "thread.pull-request.sync",
            threadId: thread.id,
            snapshotSequence: 7,
            expected: {
              workspaceRoot: project.workspaceRoot,
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              linkedPullRequest: savedReference,
              branchPullRequest: savedReference,
            },
            branchPullRequest: null,
          });
          expect(commands[0]).not.toHaveProperty("linkedPullRequest");
        }
      }),
  );

  it.effect("a saved merged branch PR rereads no git state on each sweep", () =>
    Effect.gen(function* () {
      const savedReference = {
        projectId: ProjectId.make("project-1"),
        repository: "acme/project",
        number: 42,
        url: "https://github.com/acme/project/pull/42",
      };
      const thread = {
        ...threadShell("merged-branch-thread"),
        branch: "feature/merged",
        branchPullRequest: savedReference,
      };
      const project: OrchestrationProjectShell = {
        id: thread.projectId,
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
      const activation = yield* Deferred.make<void>();
      const sweeps = yield* Queue.unbounded<void>();
      const commands: Array<OrchestrationV2ServerCommand> = [];
      const lookups: Array<Parameters<GitManager.GitManager["Service"]["branchPullRequest"]>[1]> =
        [];
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.never,
          getPullRequestSnapshot: () =>
            Queue.offer(sweeps, undefined).pipe(
              Effect.as({
                schemaVersion: 2,
                snapshotSequence: 1,
                threads: [thread],
                archivedThreads: [],
              }),
            ),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: 2, storedEvents: [] };
            }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed([project]),
          getShell: () => Effect.succeedSome(project),
        }),
        Layer.mock(GitManager.GitManager)({
          branchPullRequest: (_input, options) =>
            Effect.sync(() => {
              lookups.push(options);
              return {
                number: 42,
                title: "Merged work",
                url: savedReference.url,
                baseRef: "main",
                headRef: thread.branch,
                state: "merged" as const,
                repositoryKey: "github.com/acme/project",
                updatedAt: "2026-09-19T00:00:00.000Z",
                closedAt: null,
                mergedAt: "2026-09-19T00:00:00.000Z",
              };
            }),
        }),
        Layer.mock(PullRequestService.PullRequestService)({
          notifyLinkedThreadsChanged: Effect.void,
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () =>
            Effect.succeed({
              canonicalKey: "github.com/acme/project",
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: "git@github.com:acme/project.git",
              },
              provider: SourceControlProviderKind.make("github"),
              owner: "acme",
              name: "project",
            }),
        }),
        // A connected client keeps the periodic sweep running.
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunOpportunisticWork: Effect.succeed(true),
        }),
        Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
        Layer.succeed(
          SecureRandom.SecureRandom,
          SecureRandom.make((size) => new Uint8Array(size).fill(1)),
        ),
        FileSystem.layerNoop({}),
        Path.layer,
      );
      yield* Effect.gen(function* () {
        const service = yield* ThreadPullRequestService.make;
        yield* service.start();
        yield* Deferred.succeed(activation, undefined);
        yield* Queue.take(sweeps);
        yield* service.drain;
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(sweeps);
        yield* service.drain;
      }).pipe(
        Effect.provide(
          WorkspaceHostTesting.layerFromContext.pipe(Layer.provideMerge(dependencies)),
        ),
      );

      expect(commands).toEqual([]);
      expect(lookups).toHaveLength(2);
      // GitManager rereads git state on request, and by default whenever its
      // remembered answer is merged or closed.
      expect(
        lookups.filter(
          (options) =>
            options?.refresh === true ||
            options?.freshGitState === true ||
            options?.confirmTerminal !== false,
        ),
      ).toEqual([]);
    }),
  );

  const mergedPullRequest43 = {
    number: 43,
    title: "Replacement work",
    url: "https://github.com/acme/project/pull/43",
    baseRef: "main",
    headRef: "feature/replaced",
    state: "merged" as const,
    repositoryKey: "github.com/acme/project",
    updatedAt: "2026-09-19T00:00:00.000Z",
    closedAt: null,
    mergedAt: "2026-09-19T00:00:00.000Z",
  };

  it.effect.each([
    { name: "reopened", fresh: { ...mergedPullRequest43, state: "open" as const }, writes: false },
    { name: "the same merged PR", fresh: mergedPullRequest43, writes: true },
  ])("saves a remembered merged PR only when fresh git state finds $name", ({ fresh, writes }) =>
    Effect.gen(function* () {
      const savedReference = {
        projectId: ProjectId.make("project-1"),
        repository: "acme/project",
        number: 42,
        url: "https://github.com/acme/project/pull/42",
      };
      const thread = {
        ...threadShell("replaced-branch-thread"),
        createdAt: DateTime.makeUnsafe("2026-09-01T00:00:00.000Z"),
        branch: mergedPullRequest43.headRef,
        branchPullRequest: savedReference,
      };
      const project: OrchestrationProjectShell = {
        id: thread.projectId,
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
      const activation = yield* Deferred.make<void>();
      const sweeps = yield* Queue.unbounded<void>();
      const commands: Array<OrchestrationV2ServerCommand> = [];
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.never,
          getPullRequestSnapshot: () =>
            Queue.offer(sweeps, undefined).pipe(
              Effect.as({
                schemaVersion: 2,
                snapshotSequence: 1,
                threads: [thread],
                archivedThreads: [],
              }),
            ),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: 2, storedEvents: [] };
            }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed([project]),
          getShell: () => Effect.succeedSome(project),
        }),
        // Only the fresh read disagrees with the remembered detection.
        Layer.mock(GitManager.GitManager)({
          branchPullRequest: (_input, options) =>
            Effect.succeed(options?.freshGitState === true ? fresh : mergedPullRequest43),
        }),
        Layer.mock(PullRequestService.PullRequestService)({
          notifyLinkedThreadsChanged: Effect.void,
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () =>
            Effect.succeed({
              canonicalKey: "github.com/acme/project",
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: "git@github.com:acme/project.git",
              },
              provider: SourceControlProviderKind.make("github"),
              owner: "acme",
              name: "project",
            }),
        }),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunOpportunisticWork: Effect.succeed(true),
        }),
        Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
        Layer.succeed(
          SecureRandom.SecureRandom,
          SecureRandom.make((size) => new Uint8Array(size).fill(1)),
        ),
        FileSystem.layerNoop({}),
        Path.layer,
      );
      yield* Effect.gen(function* () {
        const service = yield* ThreadPullRequestService.make;
        yield* service.start();
        yield* Deferred.succeed(activation, undefined);
        yield* Queue.take(sweeps);
        yield* service.drain;
      }).pipe(
        Effect.provide(
          WorkspaceHostTesting.layerFromContext.pipe(Layer.provideMerge(dependencies)),
        ),
      );

      expect(
        commands.map((command) =>
          command.type === "thread.pull-request.sync" ? command.branchPullRequest : command.type,
        ),
      ).toEqual(
        writes
          ? [
              {
                projectId: project.id,
                repository: "acme/project",
                number: 43,
                url: mergedPullRequest43.url,
              },
            ]
          : [],
      );
    }),
  );
});
