// @effect-diagnostics nodeBuiltinImport:off - the fixture serves /mcp on a real port.
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  MemberId,
  OrchestratorMcpFailure,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { Command } from "effect/cli";
import { HttpRouter, HttpServer } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import { vi } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpBridge from "../mcp/AcpMcpStdioBridge.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as Members from "../persistence/Members.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TeamState from "../team/TeamState.ts";
import {
  cloudConnection,
  inEnvironment,
  launchWorkspaceStrategy,
  projectListEntries,
  launchModelSelection,
  readLatestMessages,
  resolveProject,
  threadCommand,
  ThreadUnauthorizedError,
  ThreadUsageError,
  type ThreadTools,
  titleFromMessage,
  waitForRun,
} from "./thread.ts";

vi.mock("../auth/EnvironmentAuth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/EnvironmentAuth.ts")>();
  return {
    ...actual,
    layerRuntime: Layer.mock(actual.EnvironmentAuth)({
      issueMcpClientSession: () =>
        Effect.map(DateTime.now, (expiresAt) => ({
          sessionId: AuthSessionId.make("test-session"),
          token: "synthetic-token",
          expiresAt,
        })),
      revokeSession: () => Effect.succeed(true),
    }),
  };
});

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

it.effect(
  "start resolves home-relative project paths while preserving ids and relative paths",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-thread-project-path-" })
        .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
      const home = path.join(root, "home");
      const cwd = path.join(root, "current");
      const workspaceRoot = path.join(home, "My Project");
      const nestedRoot = path.join(workspaceRoot, "nested");
      const baseDir = path.join(root, "state");
      yield* fs.makeDirectory(nestedRoot, { recursive: true });
      yield* fs.makeDirectory(cwd);
      const projects = [
        { id: ProjectId.make("current-project"), title: "Current", workspaceRoot: cwd },
        { id: ProjectId.make("home-project"), title: "Home", workspaceRoot: home },
        { id: ProjectId.make("intended-project"), title: "Intended", workspaceRoot },
        { id: ProjectId.make("nested-project"), title: "Nested", workspaceRoot: nestedRoot },
        { id: ProjectId.make("~/literal-id"), title: "Exact id", workspaceRoot: cwd },
      ];
      yield* persistServerRuntimeState({
        path: path.join(baseDir, "userdata", "server-runtime.json"),
        state: yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: 3_773,
        }),
      });
      using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
        Effect.succeed({
          call: (tool, args) => {
            switch (tool) {
              case "t3_project_list":
                return Effect.succeed({ structuredContent: { projects, nextCursor: null } });
              case "t3_thread_launch":
                return Effect.succeed({
                  structuredContent: { threadId, projectId: args.projectId, runId: null },
                });
              default:
                return Effect.die(`unexpected ${tool} call`);
            }
          },
        }),
      );

      for (const [identifier, expectedProjectId] of [
        ["intended-project", "intended-project"],
        ["~/literal-id", "~/literal-id"],
        [workspaceRoot, "intended-project"],
        [path.relative(cwd, workspaceRoot), "intended-project"],
        [".", "current-project"],
        ["~/My Project", "intended-project"],
        ["~", "home-project"],
        ["~/My Project/nested", "nested-project"],
        ["~/My Project/missing", "intended-project"],
      ] as const) {
        yield* Command.runWith(threadCommand, { version: "0.0.0" })([
          "start",
          identifier,
          "Inspect this project",
          "--json",
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.WorkingDirectory, cwd),
        );
        assert.strictEqual(
          (yield* TestConsole.logLines).at(-1),
          JSON.stringify({ threadId, projectId: expectedProjectId, runId: null }),
          identifier,
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          NetService.layer,
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
        ),
      ),
    ),
);

it.effect("does not sign in to whatever took over a dead server's port", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-dead-server-" });
    const state = yield* makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port: 3_773,
    });
    yield* persistServerRuntimeState({
      path: path.join(baseDir, "userdata", "server-runtime.json"),
      // Above Linux's PID ceiling, as in pair.test.ts: no process can hold it.
      state: { ...state, pid: 4_194_305 },
    });
    using session = vi
      .spyOn(McpBridge, "mcpToolSession")
      .mockReturnValue(Effect.die("no session should open"));

    const error = yield* Command.runWith(threadCommand, { version: "0.0.0" })([
      "list",
      "--base-dir",
      baseDir,
    ]).pipe(Effect.flip);

    assert.strictEqual(error._tag, "ThreadServerNotRunningError");
    assert.strictEqual(session.mock.calls.length, 0);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
      ),
    ),
  ),
);

/** Answers each tool call with the next scripted response for that tool. */
const scriptedTools = (script: Record<string, Array<unknown>>) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call = ((tool: string, args: unknown) => {
    calls.push({ tool, args });
    const next = script[tool]?.shift();
    return next === undefined ? Effect.die(`unscripted ${tool} call`) : Effect.succeed(next);
  }) as ThreadTools["call"];
  return { tools: { call } satisfies ThreadTools, calls };
};

it.effect("--wait follows the sent run to its continuation's terminal status", () =>
  Effect.gen(function* () {
    const continuation = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId: continuation, status: "failed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 0 } }],
    });

    const outcome = yield* waitForRun(tools, threadId, runId);

    assert.deepStrictEqual(outcome, { type: "ended", runId: continuation, status: "failed" });
    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "t3_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000 },
      ],
    );
  }),
);

/** The reads that ask whether a run after `runId` holds a message someone sent. */
const laterRunReads = (
  laterRun: RunId,
  items: ReadonlyArray<{ readonly runId: RunId; readonly type: string }>,
) => [
  {
    recentRuns: [
      { runId, ordinal: 1 },
      { runId: laterRun, ordinal: 2 },
    ],
  },
  { thread: {}, items, nextPosition: null, hasMore: false },
];

it.effect("--wait lasts until background work the agent waits on wakes it and that run ends", () =>
  Effect.gen(function* () {
    const wakeRun = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "completed", timedOut: false },
        {
          threadId,
          runId,
          status: "completed",
          timedOut: false,
          resultRun: { runId: wakeRun, status: "completed" },
        },
      ],
      // The wake run starts from a notification, which the messages view leaves out.
      t3_thread_read: laterRunReads(wakeRun, []),
    });

    const outcome = yield* waitForRun(tools, threadId, runId, true);

    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "t3_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000, untilDelegatedWorkSettled: true },
      ],
    );
    assert.deepStrictEqual(outcome, { type: "ended", runId: wakeRun, status: "completed" });
  }),
);

it.effect(
  "--wait waits out the moment between background work ending and its wake run starting",
  () =>
    Effect.gen(function* () {
      const wakeRun = RunId.make("run-2");
      const ownOnly = { recentRuns: [{ runId, ordinal: 1, status: "completed" }] };
      const withWake = (status: string) => [
        {
          recentRuns: [
            { runId, ordinal: 1, status: "completed" },
            { runId: wakeRun, ordinal: 2, status },
          ],
        },
        { thread: {}, items: [], nextPosition: null, hasMore: false },
      ];
      const { tools } = scriptedTools({
        t3_thread_wait: [
          { threadId, runId, status: "completed", timedOut: false },
          { threadId, runId, status: "completed", timedOut: true },
          // The work ended, and the run it wakes is not recorded yet.
          {
            threadId,
            runId,
            status: "completed",
            timedOut: false,
            resultRun: { runId, status: "completed" },
          },
          {
            threadId,
            runId,
            status: "completed",
            timedOut: false,
            resultRun: { runId: wakeRun, status: "completed" },
          },
        ],
        t3_thread_read: [
          ownOnly,
          { thread: { pendingRequestCount: 0 } },
          ownOnly,
          ...withWake("running"),
          ...withWake("completed"),
        ],
      });

      const fiber = yield* Effect.forkChild(waitForRun(tools, threadId, runId, true));
      yield* TestClock.adjust("500 millis");

      assert.deepStrictEqual(yield* Fiber.join(fiber), {
        type: "ended",
        runId: wakeRun,
        status: "completed",
      });
    }),
);

it.effect(
  "--wait keeps its own run's result when another client's later run settles the thread",
  () =>
    Effect.gen(function* () {
      const sentRun = RunId.make("run-2");
      const { tools } = scriptedTools({
        t3_thread_wait: [
          { threadId, runId, status: "completed", timedOut: false },
          {
            threadId,
            runId,
            status: "completed",
            timedOut: false,
            resultRun: { runId: sentRun, status: "failed" },
          },
        ],
        t3_thread_read: laterRunReads(sentRun, [{ runId: sentRun, type: "user_message" }]),
      });

      assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId, true), {
        type: "ended",
        runId,
        status: "completed",
      });
    }),
);

it.effect("--wait stops when the thread waits for an answer instead of polling forever", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "queued", timedOut: true },
        { threadId, runId, status: "queued", timedOut: true },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), { type: "needs_input" });
  }),
);

it.effect("--wait reports its run's result when a later run is the one waiting", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId, status: "completed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);

it.effect("start sends each --option as a typed model option", () =>
  Effect.gen(function* () {
    const selection = yield* launchModelSelection({
      provider: Option.some("codex"),
      model: Option.some("gpt-6.1-sol"),
      option: ["reasoningEffort=high", " fastMode = false ", "note=a=b"],
    });

    assert.deepStrictEqual(selection, {
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: false },
        { id: "note", value: "a=b" },
      ],
    });
  }),
);

it.effect("start rejects a repeated --option before reaching the server", () =>
  Effect.gen(function* () {
    const error = yield* Command.runWith(threadCommand, { version: "0.0.0" })([
      "start",
      ".",
      "hi",
      "--provider",
      "codex",
      "--model",
      "gpt-6.1-sol",
      "--option",
      "reasoningEffort=high",
      "--option",
      "reasoningEffort=low",
    ]).pipe(Effect.flip);

    assert.strictEqual(error.message, "--option reasoningEffort is given more than once.");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer, TestConsole.layer),
    ),
  ),
);

/** Serves t3_thread_read pages the way the server does: positions count every item. */
const timelineTools = (types: ReadonlyArray<string>) => {
  const items = types.map((type, position) => ({ position, itemId: `item-${position}`, type }));
  const served: Array<number> = [];
  const call = ((_tool: string, input: unknown) => {
    const args = input as { readonly afterPosition?: number; readonly limit: number };
    // Scanning one match past the page keeps reads of huge fixtures linear.
    const matching: typeof items = [];
    for (let position = (args.afterPosition ?? -1) + 1; position < items.length; position++) {
      const item = items[position]!;
      if (["user_message", "assistant_message", "proposed_plan"].includes(item.type)) {
        matching.push(item);
        if (matching.length > args.limit) break;
      }
    }
    const page = matching.slice(0, args.limit);
    served.push(page.length);
    return Effect.succeed({
      thread: { itemCount: items.length },
      items: page,
      nextPosition: page.at(-1)?.position ?? null,
      hasMore: matching.length > page.length,
    });
  }) as ThreadTools["call"];
  const latest = (count: number) =>
    items
      .filter((item) => item.type === "user_message" || item.type === "assistant_message")
      .slice(-count)
      .map((item) => item.itemId);
  return { tools: { call } satisfies ThreadTools, served, latest };
};

const tail = (tools: number) => [...Array<string>(tools).fill("tool_call"), "assistant_message"];

it.effect("show reads the end of a long thread, not its whole history", () =>
  Effect.gen(function* () {
    const { tools, served, latest } = timelineTools([
      ...Array.from({ length: 1000 }, (_, index) =>
        index % 2 === 0 ? "user_message" : "assistant_message",
      ),
      ...Array.from({ length: 10 }, () => tail(30)).flat(),
      "proposed_plan",
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.isBelow(
      served.reduce((sum, count) => sum + count, 0),
      100,
    );
  }),
);

it.effect("show widens back to the first item when the thread has fewer messages", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools([
      "user_message",
      ...Array.from({ length: 4 }, () => tail(150)).flat(),
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.lengthOf(messages, 5);
  }),
);

it.effect("show returns a --messages count larger than one call can spread", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools(Array<string>(200_000).fill("assistant_message"));

    const { messages } = yield* readLatestMessages(tools, threadId, 200_000);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(200_000),
    );
  }),
);

it.effect(
  "--cloud asks for a cloud checkout of its ref and size, and not alongside --worktree",
  () =>
    Effect.gen(function* () {
      const strategy = (input: {
        worktree?: string;
        cloud?: string;
        branch?: string;
        machine?: "small" | "default" | "large";
      }) =>
        launchWorkspaceStrategy({
          worktree: Option.fromUndefinedOr(input.worktree),
          cloud: Option.fromUndefinedOr(input.cloud),
          branch: Option.fromUndefinedOr(input.branch),
          machine: Option.fromUndefinedOr(input.machine),
        });
      assert.deepStrictEqual(yield* strategy({ cloud: "main" }), {
        type: "cloud",
        baseRef: "main",
      });
      assert.deepStrictEqual(yield* strategy({ cloud: "main", machine: "large" }), {
        type: "cloud",
        baseRef: "main",
        machineSize: "large",
      });
      const machineAlone = yield* strategy({ worktree: "main", machine: "large" }).pipe(
        Effect.flip,
      );
      assert.strictEqual(machineAlone.detail, "--machine needs --cloud <base-ref>.");
      assert.deepStrictEqual(yield* strategy({ worktree: "main", branch: "fix" }), {
        type: "worktree",
        baseRef: "main",
        branch: "fix",
      });
      const both = yield* strategy({ worktree: "main", cloud: "main" }).pipe(Effect.flip);
      assert.strictEqual(both.detail, "Use --worktree or --cloud, not both.");
    }),
);

it("titles from a long first line without splitting an emoji", () => {
  const title = titleFromMessage(`${"a".repeat(78)}😀 and the rest of a long first line`);
  assert.strictEqual(title, `${"a".repeat(78)}…`);
});

const projects = [
  { id: "project-api", title: "API", workspaceRoot: "/srv/api" },
  { id: "project-web", title: "Web", workspaceRoot: "/srv/web" },
  { id: "project-web-2", title: "web", workspaceRoot: "/srv/web-2" },
];

it.effect("resolves a remote project by id, server folder, or unique title", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_project_list: Array.from({ length: 5 }, () => ({ projects, nextCursor: null })),
    });
    const resolve = (identifier: string) =>
      resolveProject(tools, identifier, { remote: true }).pipe(
        Effect.map((project) => project.id),
        Effect.catch((error) => Effect.succeed(error._tag)),
      );

    assert.strictEqual(yield* resolve("project-web"), "project-web");
    assert.strictEqual(yield* resolve("/srv/web-2"), "project-web-2");
    assert.strictEqual(yield* resolve("api"), "project-api");
    assert.strictEqual(yield* resolve("WEB"), "ThreadUsageError");
    assert.strictEqual(yield* resolve("."), "ThreadProjectNotFoundError");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "--environment sends every call there and finds this checkout's project there by repository",
  () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-pair-cloud");
      const here = {
        id: "project-here",
        title: "app",
        workspaceRoot: process.cwd(),
        repositoryIdentity: { canonicalKey: "github.com/acme/app" },
      };
      const there = (id: string, canonicalKey: string) => ({
        id,
        title: id,
        workspaceRoot: `/srv/${id}`,
        repositoryIdentity: { canonicalKey },
      });
      const resolveThere = (projectsThere: ReadonlyArray<ReturnType<typeof there>>) => {
        const scripted = scriptedTools({
          t3_project_list: [
            { projects: projectsThere, nextCursor: null },
            { projects: [here], nextCursor: null },
          ],
        });
        return resolveProject(inEnvironment(scripted.tools, environmentId), ".", {
          remote: true,
          environmentId,
        }).pipe(
          Effect.map((project) => ({ found: project.id as string, calls: scripted.calls })),
          Effect.catch((error) => Effect.succeed({ found: error._tag, calls: scripted.calls })),
        );
      };

      const matched = yield* resolveThere([
        there("project-other", "github.com/acme/other"),
        there("project-cloud-app", "github.com/acme/app"),
      ]);
      assert.strictEqual(matched.found, "project-cloud-app");
      assert.deepStrictEqual(
        matched.calls.map((entry) => (entry.args as { environmentId?: string }).environmentId),
        [environmentId, undefined],
      );
      assert.strictEqual(
        (yield* resolveThere([there("project-other", "github.com/acme/other")])).found,
        "ThreadProjectNotFoundError",
      );
      assert.strictEqual(
        (yield* resolveThere([
          there("project-a", "github.com/acme/app"),
          there("project-b", "github.com/acme/app"),
        ])).found,
        "ThreadUsageError",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("--environment fails on a name that is neither a title there nor a folder here", () =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("environment-pair-cloud");
    const here = {
      id: "project-here",
      title: "app",
      workspaceRoot: process.cwd(),
      repositoryIdentity: { canonicalKey: "github.com/acme/app" },
    };
    const { tools } = scriptedTools({
      t3_project_list: [
        {
          projects: [
            {
              id: "project-cloud-app",
              title: "app-cloud",
              workspaceRoot: "/srv/app",
              repositoryIdentity: { canonicalKey: "github.com/acme/app" },
            },
          ],
          nextCursor: null,
        },
        { projects: [here], nextCursor: null },
      ],
    });
    const error = yield* resolveProject(inEnvironment(tools, environmentId), "app-typo", {
      remote: true,
      environmentId,
    }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "ThreadProjectNotFoundError");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("project list puts repos before workspaces and names each workspace's repositories", () => {
  const entries = projectListEntries(
    [
      {
        id: ProjectId.make("workspace-1"),
        title: "ade-pair",
        workspaceRoot: "/srv/workspaces/ade-pair",
        roots: [
          { projectId: ProjectId.make("project-ade"), name: "ade" },
          { projectId: ProjectId.make("project-gone"), name: "gone" },
        ],
      },
      {
        id: ProjectId.make("project-ade"),
        title: "ade",
        workspaceRoot: "/srv/ade",
        repositoryIdentity: { canonicalKey: "github.com/acme/ade", owner: "acme", name: "ade" },
      },
      {
        id: ProjectId.make("project-old"),
        title: "old",
        workspaceRoot: "/srv/old",
        archivedAt: "2026-11-01T00:00:00.000Z",
      },
    ],
    { archived: false },
  );
  assert.deepStrictEqual(
    entries.map((entry) => [entry.kind, entry.title, entry.repository]),
    [
      ["repo", "ade", "acme/ade"],
      ["workspace", "ade-pair", null],
    ],
  );
  assert.deepStrictEqual(entries[1]?.roots, [
    { name: "ade", projectId: "project-ade", repository: "acme/ade" },
    { name: "gone", projectId: "project-gone", repository: null },
  ]);
});

it.effect("--cloud runs on the one linked Pair Cloud when this server has no cloud machines", () =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("environment-pair-cloud");
    const link = (id: string, cloud: boolean) => ({
      environmentId: EnvironmentId.make(id),
      label: id,
      status: "reachable",
      access: "full-access",
      expiresAt: "2026-12-01T00:00:00.000Z",
      lastError: null,
      ...(cloud ? { cloud: true } : {}),
    });
    const route = (cloudThreads: boolean, links: ReadonlyArray<unknown>) => {
      const { tools, calls } = scriptedTools({
        orchestrator_capabilities: [{ features: { cloudThreads } }],
        t3_environment_links: [{ environmentId: "environment-here", links, notListed: "" }],
      });
      return cloudConnection(tools, { remote: false }).pipe(
        Effect.map(({ connection }) => ({ connection, calls })),
      );
    };

    const here = yield* route(true, []);
    assert.deepStrictEqual(here.connection, { remote: false });
    assert.deepStrictEqual(
      here.calls.map((entry) => entry.tool),
      ["orchestrator_capabilities"],
    );

    const there = yield* route(false, [link("vps", false), link(environmentId, true)]);
    assert.deepStrictEqual(there.connection, {
      remote: true,
      environmentId,
      cloudLabel: environmentId,
    });

    const none = yield* route(false, [link("vps", false)]).pipe(Effect.flip);
    assert.instanceOf(none, ThreadUsageError);
    const two = yield* route(false, [link("cloud-a", true), link("cloud-b", true)]).pipe(
      Effect.flip,
    );
    assert.instanceOf(two, ThreadUsageError);
    assert.include(two.message, "Pass --environment");
  }),
);

const ProbeToolkit = Toolkit.make(
  Tool.make("t3_project_list", {
    description: "Lists projects.",
    parameters: Schema.Struct({
      cursor: Schema.optional(Schema.Int),
      limit: Schema.optional(Schema.Int),
    }),
    success: Schema.Struct({
      projects: Schema.Array(
        Schema.Struct({ id: ProjectId, title: Schema.String, workspaceRoot: Schema.String }),
      ),
      nextCursor: Schema.NullOr(Schema.Int),
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
  }),
  Tool.make("t3_thread_launch", {
    description: "Records who launched.",
    parameters: Schema.Struct({
      projectId: ProjectId,
      title: Schema.String,
      message: Schema.String,
    }),
    success: Schema.Struct({
      threadId: ThreadId,
      projectId: ProjectId,
      runId: Schema.NullOr(RunId),
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
);

const layerMcpAuth = Layer.mergeAll(EnvironmentAuth.layer, McpSessionRegistry.layer).pipe(
  Layer.provideMerge(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-thread-cli-test")),
    }),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-cli-test-" })),
  Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { port: 0, host: "127.0.0.1" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

/**
 * Serves /mcp with the real API-token check. A launched thread belongs to
 * the client's member, as `t3_thread_launch` assigns it.
 */
const serveMcp = Effect.gen(function* () {
  const owners: Array<MemberId | undefined> = [];
  yield* HttpRouter.serve(
    McpHttpServer.layerMcpTransport(
      McpHttpServer.toolkitRegistration(
        ProbeToolkit,
        McpToolAccess.toLayer(ProbeToolkit, {
          t3_project_list: McpToolAccess.reads(() =>
            Effect.succeed({
              projects: projects.map((p) => ({ ...p, id: ProjectId.make(p.id) })),
              nextCursor: null,
            }),
          ),
          t3_thread_launch: McpToolAccess.reads(({ projectId }) =>
            McpInvocationContext.McpInvocationContext.pipe(
              Effect.map((scope) => {
                owners.push(scope.client?.memberId);
                return { threadId: ThreadId.make("thread-ci"), projectId, runId: null };
              }),
            ),
          ),
        }),
      ),
    ).pipe(
      Layer.provide(McpOAuth.layerMcpClientAuthenticator),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-cli-test-" })),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.build);
  const origin = HttpServer.formatAddress((yield* HttpServer.HttpServer).address);
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const members = yield* Members.MemberRepository;
  const teamState = yield* TeamState.TeamState;
  const bob = MemberId.make("member-bob");
  yield* members.insert({
    id: bob,
    name: "bob",
    role: "member",
    gitName: null,
    gitEmail: null,
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  yield* teamState.reload;
  const token = yield* auth.issueMcpClientSession({
    memberId: bob,
    label: "CI",
    access: "auto",
    peerLink: false,
    client: { deviceType: "bot" },
  });
  return { owners, bob, token, auth, origin };
});

const runCli = (args: ReadonlyArray<string>, env: Record<string, string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
      ),
    ),
  );

it.effect("--url needs T3CODE_TOKEN", () =>
  Effect.gen(function* () {
    const error = yield* runCli(
      ["thread", "list", "--url", "http://127.0.0.1:9", "--project", "API"],
      {},
    ).pipe(Effect.flip);
    assert.instanceOf(error, ThreadUsageError);

    const throughLink = yield* runCli(
      [
        "thread",
        "list",
        "--url",
        "http://127.0.0.1:9",
        "--environment",
        "Pair Cloud",
        "--project",
        "API",
      ],
      { T3CODE_TOKEN: "token" },
    ).pipe(Effect.flip);
    assert.instanceOf(throughLink, ThreadUsageError);
    assert.include(throughLink.message, "--environment goes through this machine's server");
  }),
);

it.effect.each(["--url", "this machine's server"] as const)(
  "a token acts as its member through %s, until it is revoked",
  (route) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { owners, bob, token, auth, origin } = yield* serveMcp;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-cli-" });
      yield* persistServerRuntimeState({
        path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
        state: yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: Number(new URL(origin).port),
        }),
      });
      const env = {
        T3CODE_TOKEN: token.token,
        ...(route === "--url" ? { T3CODE_URL: origin } : {}),
      };
      // Remotely a path is the server's; locally it is this machine's folder.
      const project = route === "--url" ? "/srv/api" : "project-api";
      const start = runCli(["thread", "start", project, "Ship it", "--base-dir", baseDir], env);

      yield* start;
      assert.deepStrictEqual(owners, [bob]);

      yield* auth.revokeSession(token.sessionId);
      const error = yield* start.pipe(Effect.flip);
      assert.instanceOf(error, ThreadUnauthorizedError);
    }).pipe(Effect.provide(layerMcpAuth), Effect.scoped),
);

const git = Effect.fn("test.git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(ChildProcess.make("git", args, { cwd }));
  assert.strictEqual(Number(exitCode), 0, `git ${args.join(" ")}`);
});

const commitAll = (cwd: string) =>
  Effect.andThen(
    git(cwd, ["add", "."]),
    git(cwd, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--quiet",
      "-m",
      "initial",
    ]),
  );

it.live("resolves a path inside a git worktree of the project's repository to that project", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-worktree-" });
    const repo = path.join(root, "sample");
    const worktree = path.join(root, "worktrees", "sample", "t3-8ff64c24");
    const feature = path.join(root, "wt", "feature");
    const featureWorktree = path.join(root, "worktrees", "feature", "t3-1a2b3c4d");
    yield* fileSystem.makeDirectory(path.join(repo, "pkg"), { recursive: true });
    yield* fileSystem.writeFileString(path.join(repo, "pkg", "index.ts"), "export {};\n");
    yield* git(repo, ["init", "--quiet", "-b", "main"]);
    yield* commitAll(repo);
    yield* git(repo, ["worktree", "add", "--quiet", "-b", "t3/8ff64c24", worktree]);
    yield* git(repo, ["worktree", "add", "--quiet", "-b", "feature", feature]);
    yield* git(feature, ["worktree", "add", "--quiet", "-b", "t3/1a2b3c4d", featureWorktree]);

    const project = (id: string, workspaceRoot: string) => ({
      id: ProjectId.make(id),
      title: path.basename(workspaceRoot),
      workspaceRoot,
    });
    const sample = project("project-sample", repo);
    const featureProject = project("project-feature", feature);
    const resolveFrom = (
      projects: ReadonlyArray<ReturnType<typeof project>>,
      workingDirectory: string,
      identifier = ".",
    ) =>
      resolveProject(
        scriptedTools({ t3_project_list: [{ projects, nextCursor: null }] }).tools,
        identifier,
        { remote: false },
      ).pipe(Effect.provideService(HostProcess.WorkingDirectory, workingDirectory));

    assert.deepStrictEqual(yield* resolveFrom([sample], worktree), sample);
    assert.deepStrictEqual(yield* resolveFrom([sample], path.join(worktree, "pkg")), sample);
    assert.deepStrictEqual(yield* resolveFrom([sample], worktree, "pkg/index.ts"), sample);
    assert.deepStrictEqual(yield* resolveFrom([featureProject], featureWorktree), featureProject);
    const ambiguous = yield* Effect.flip(resolveFrom([sample, featureProject], featureWorktree));
    assert.strictEqual(ambiguous._tag, "ThreadUsageError");
    assert.include(ambiguous.message, "sample (project-sample)");
    assert.include(ambiguous.message, "feature (project-feature)");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
