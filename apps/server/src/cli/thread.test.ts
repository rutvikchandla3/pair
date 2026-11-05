// @effect-diagnostics nodeBuiltinImport:off - the fixture serves /mcp on a real port.
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MemberId,
  OrchestratorMcpFailure,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { Command } from "effect/cli";
import { HttpRouter, HttpServer } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
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
  readLatestMessages,
  resolveProject,
  ThreadUnauthorizedError,
  ThreadUsageError,
  type ThreadTools,
  titleFromMessage,
  waitForRun,
} from "./thread.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

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

const ProbeToolkit = Toolkit.make(
  Tool.make("t3_project_list", {
    description: "Lists projects.",
    parameters: Schema.Struct({ cursor: Schema.optional(Schema.Int) }),
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
    parameters: Schema.Struct({ projectId: ProjectId, title: Schema.String }),
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
