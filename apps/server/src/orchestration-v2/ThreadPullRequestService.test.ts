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
    Effect.scoped(
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
          Layer.mock(PullRequestService.PullRequestService)({}),
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
    ),
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
      Effect.scoped(
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
            Layer.mock(PullRequestService.PullRequestService)({}),
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
      ),
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
            Layer.mock(PullRequestService.PullRequestService)({}),
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
    { linked: "nothing", existing: [], discovered: ["api", "web"] },
    // An earlier sync linked api's pull request; web's joins it without clearing it.
    { linked: "api's pull request", existing: ["api"], discovered: ["web"] },
  ] as const)(
    "links each workspace repository's pull request when $linked is linked",
    ({ existing, discovered }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const folder = "/worktrees/stack/feature";
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
                Effect.sync(() => {
                  lookupCwds.push(input.cwd);
                  const name = input.cwd.split("/").at(-1)!;
                  return {
                    number: pullRequest(name).number,
                    title: name,
                    url: pullRequest(name).url,
                    baseRef: "main",
                    headRef: input.branch,
                    state: "open" as const,
                    repositoryKey: `github.com/acme/${name}`,
                    updatedAt: "2026-09-20T00:00:00.000Z",
                  };
                }),
            }),
            Layer.mock(PullRequestService.PullRequestService)({}),
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
            FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
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

          expect(new Set(lookupCwds)).toEqual(
            new Set(roots.map((root) => `${folder}/${root.name}`)),
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

  it.effect("leaves delegated child threads to their own refresh instead of the sweep", () =>
    Effect.scoped(
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
          Layer.mock(PullRequestService.PullRequestService)({}),
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

          // Startup backfill sweep, then one periodic sweep.
          yield* Queue.take(sweeps);
          yield* service.drain;
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
    ),
  );

  it.effect.each([
    { state: "closed", sameBranch: false },
    { state: "merged", sameBranch: false },
    { state: "closed", sameBranch: true },
    { state: "merged", sameBranch: true },
  ] as const)(
    "restores a $state automatic PR only for its own branch (sameBranch=$sameBranch)",
    ({ state, sameBranch }) =>
      Effect.scoped(
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
      ),
  );
});
