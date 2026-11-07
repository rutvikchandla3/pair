// @effect-diagnostics nodeBuiltinImport:off -- the fake targets and the agent's side are real node:http and node:net sockets.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ComputeDriverId,
  EnvironmentId,
  type OrchestrationV2Sandbox,
  ProjectId,
  ProviderInstanceId,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import type { RunnerGitCredentialRequest } from "@t3tools/contracts/runner";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import type { McpThreadInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { McpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { CodexManagedTokenBroker } from "../../provider/CodexManagedTokenBroker.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { GitCredentialService } from "../credentials/GitCredentialService.ts";
import {
  answerGitCredential,
  codexForwardAllows,
  exposeServerEndpoint,
  mcpForwardAllows,
  RunnerForwards,
  layer as runnerForwardsLayer,
} from "./RunnerForwards.ts";
import * as RunnerGrants from "./RunnerGrants.ts";
import * as RunnerHub from "./RunnerHub.ts";
import * as RunnerHubTesting from "./RunnerHubTesting.ts";
import * as WorkspaceHostTesting from "../../workspaceHost/WorkspaceHostTesting.ts";

const sandboxA = SandboxId.make("sbx_000000000000000a1130");
const sandboxB = SandboxId.make("sbx_000000000000000b1130");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const expiresAt = DateTime.makeUnsafe("2026-11-07T13:00:00.000Z");
const profileKey = "a".repeat(64);

const scopeFor = (providerSessionId: string, threadId = threadA): McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("environment-test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: providerSessionId,
  thread: {
    threadId,
    providerSessionId,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
});

const sandboxRecord = (id: SandboxId, ownerThreadId: ThreadId): OrchestrationV2Sandbox => ({
  id,
  projectId: ProjectId.make("project"),
  ownerThreadId,
  ownerMemberId: null,
  driverId: ComputeDriverId.make("docker"),
  size: "default",
  state: "ready",
  generation: 1,
  driverRef: "ref",
  admission: null,
  runnerLostAt: null,
  sleepReason: null,
  failure: null,
  createdAt: expiresAt,
  updatedAt: expiresAt,
});

/** Sandbox A is thread A's, B is thread B's. */
const projections = {
  getSandbox: (id: SandboxId) =>
    Effect.succeed(
      id === sandboxA
        ? sandboxRecord(sandboxA, threadA)
        : id === sandboxB
          ? sandboxRecord(sandboxB, threadB)
          : null,
    ),
  listSandboxThreads: (id: SandboxId) =>
    Effect.succeed(
      id === sandboxA || id === sandboxB
        ? [
            {
              threadId: id === sandboxA ? threadA : threadB,
              attachedAt: expiresAt,
              archived: false,
            },
          ]
        : [],
    ),
};

type GitAnswerInput = Parameters<GitCredentialService["Service"]["answer"]>[0];

/** Records each call and answers with a password naming the thread. */
const recordingCredentials = (calls: Queue.Queue<GitAnswerInput>) =>
  GitCredentialService.of({
    answer: (input) =>
      Queue.offer(calls, input).pipe(
        Effect.as({
          username: "x-access-token",
          password: Redacted.make(`token-for-${input.threadId}`),
          expiresAt,
        }),
      ),
  });

const gitRequest = (
  patch: Partial<RunnerGitCredentialRequest> = {},
): RunnerGitCredentialRequest => ({
  version: 1,
  operation: "get",
  protocol: "https",
  host: "github.com",
  path: "org/repo.git",
  ...patch,
});

describe("forward checks", () => {
  it.each([
    ["its own session's token on /mcp", scopeFor("session-a"), "/mcp", true],
    ["another session's token", scopeFor("session-b"), "/mcp", false],
    ["a token the registry does not know", undefined, "/mcp", false],
    ["its own token on another path", scopeFor("session-a"), "/api/orchestration", false],
  ])("mcp allows %s: %s", (_name, scope, pathname, allowed) => {
    expect(mcpForwardAllows(scope, "session-a", pathname)).toBe(allowed);
  });

  it.each([
    ["its own instance", "instance-a", true],
    ["a sibling instance", "instance-b", false],
  ])("codex allows %s: %s", (_name, instanceId, allowed) => {
    const request = { version: 1 as const, instanceId, environmentId: "env", profileKey };
    expect(codexForwardAllows(request, "instance-a")).toBe(allowed);
  });

  it.effect("git asks the service only for a thread that uses the sandbox", () =>
    Effect.gen(function* () {
      const calls = yield* Queue.unbounded<GitAnswerInput>();
      const deps = { projections, credentials: recordingCredentials(calls) };
      expect(yield* answerGitCredential(deps, sandboxA, gitRequest({ threadId: threadB }))).toBe(
        null,
      );
      expect(yield* answerGitCredential(deps, sandboxA, gitRequest({ operation: "store" }))).toBe(
        null,
      );
      expect(yield* Queue.size(calls)).toBe(0);
      // A terminal carries no thread id: the owner thread answers.
      const owner = yield* answerGitCredential(deps, sandboxA, gitRequest());
      expect(owner?.username).toBe("x-access-token");
      expect(yield* Queue.take(calls)).toEqual({
        sandboxId: sandboxA,
        threadId: threadA,
        protocol: "https",
        host: "github.com",
        path: "org/repo.git",
      });
    }),
  );
});

/** A stand-in for the server's own `/mcp` listener: records what reaches it. */
const fakeMcpTarget = Effect.gen(function* () {
  const requests = yield* Queue.unbounded<{
    readonly url: string;
    readonly authorization: string;
  }>();
  const server = NodeHttp.createServer((request, response) => {
    Queue.offerUnsafe(requests, {
      url: request.url ?? "",
      authorization: request.headers.authorization ?? "",
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("data: ok\n\n");
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen({ host: "127.0.0.1", port: 0 }, () => resume(Effect.void));
    }),
    () => Effect.sync(() => server.close()),
  );
  const { port } = server.address() as NodeNet.AddressInfo;
  return { endpoint: `http://127.0.0.1:${port}/mcp`, requests };
});

/** A stand-in for the Codex broker: one frame in, one token out. */
const fakeBroker = (path: string) =>
  Effect.gen(function* () {
    const frames = yield* Queue.unbounded<string>();
    const server = NodeNet.createServer((socket) => {
      socket.once("data", (chunk: Buffer) => {
        Queue.offerUnsafe(frames, chunk.toString("utf8"));
        socket.end('{"token":"chatgpt-token"}\n');
      });
    });
    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        server.listen(path, () => resume(Effect.void));
      }),
      () => Effect.sync(() => server.close()),
    );
    return frames;
  });

const httpRequest = (url: string, authorization: string | undefined) =>
  Effect.callback<{ readonly status: number; readonly body: string }, Error>((resume) => {
    const request = NodeHttp.request(
      url,
      { method: "POST", headers: authorization === undefined ? {} : { authorization } },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        response.once("end", () =>
          resume(Effect.succeed({ status: response.statusCode ?? 0, body })),
        );
      },
    );
    request.once("error", (error) => resume(Effect.fail(error)));
    request.end('{"jsonrpc":"2.0"}');
  });

/** The agent's side of a Unix forward: one line out, everything until the end back. */
const unixRoundTrip = (path: string, line: string) =>
  Effect.callback<string, Error>((resume) => {
    const socket = NodeNet.createConnection(path);
    let text = "";
    socket.once("connect", () => socket.write(`${line}\n`));
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    socket.once("end", () => {
      socket.destroy();
      resume(Effect.succeed(text));
    });
    socket.once("error", (error) => resume(Effect.fail(error)));
  });

const codexFrame = (instanceId: string) =>
  JSON.stringify({ version: 1, instanceId, environmentId: "environment-test", profileKey });

describe("RunnerForwards", () => {
  it.live("connects each sandbox's forwards only to its own sessions and threads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "forwards-" });
      const target = yield* fakeMcpTarget;
      const brokerFrames = yield* fakeBroker(`${tmp}/broker.sock`);
      const gitCalls = yield* Queue.unbounded<GitAnswerInput>();
      const tokens = new Map([
        ["token-a", scopeFor("session-a", threadA)],
        ["token-b", scopeFor("session-b", threadB)],
      ]);

      const layer = runnerForwardsLayer.pipe(
        Layer.provideMerge(RunnerHub.layer),
        Layer.provide(WorkspaceHostTesting.layerFromContext),
        Layer.provideMerge(RunnerGrants.layer),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provideMerge(NodeCrypto.layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(McpSessionRegistry)({
              endpoint: target.endpoint,
              resolve: (token) => Effect.succeed(tokens.get(token)),
            }),
            Layer.mock(CodexManagedTokenBroker)({
              endpoint: Effect.succeed(`${tmp}/broker.sock`),
            }),
            Layer.mock(ProjectionStoreV2)(projections),
            Layer.succeed(GitCredentialService, recordingCredentials(gitCalls)),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const hub = yield* RunnerHub.RunnerHub;
        const forwards = yield* RunnerForwards;
        const boot = Effect.fnUntraced(function* (sandboxId: SandboxId) {
          const runner = yield* RunnerHubTesting.makeRunner(
            yield* hub.mintEnrollment(sandboxId, 1),
          );
          // The git forward opens on attach, in the background: await its socket, not a timer.
          const ready = yield* Deferred.make<void>();
          const gitSocket = `${runner.stateDir}/git-credential.sock`;
          const created = yield* fs
            .watch(runner.stateDir, { onReady: () => Deferred.doneUnsafe(ready, Effect.void) })
            .pipe(
              Stream.filter((event) => event.path.endsWith("git-credential.sock")),
              Stream.runHead,
              Effect.forkScoped,
            );
          yield* Deferred.await(ready);
          yield* runner.connect();
          yield* hub.connection(sandboxId);
          yield* Fiber.join(created);
          return gitSocket;
        });
        const gitA = yield* boot(sandboxA);
        yield* boot(sandboxB);

        // MCP: the sandbox host's seam opens the forward the provider session uses.
        const mcpA = yield* exposeServerEndpoint(
          forwards,
          sandboxA,
        )({
          name: "mcp",
          address: target.endpoint,
          ownerKey: "session-a",
        });
        const mcpB = yield* exposeServerEndpoint(
          forwards,
          sandboxB,
        )({
          name: "mcp",
          address: target.endpoint,
          ownerKey: "session-b",
        });
        expect(mcpA).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        expect((yield* httpRequest(mcpA, "Bearer token-b")).status).toBe(401);
        expect((yield* httpRequest(mcpA, undefined)).status).toBe(401);
        expect((yield* httpRequest(mcpA, "Bearer unknown")).status).toBe(401);
        const api = mcpA.replace(/\/mcp$/, "/api/orchestration");
        expect((yield* httpRequest(api, "Bearer token-a")).status).toBe(404);
        expect(yield* httpRequest(`${mcpA}?session=1`, "Bearer token-a")).toEqual({
          status: 200,
          body: "data: ok\n\n",
        });
        // The refusals above never reached the target: its first request is the allowed one.
        expect(yield* Queue.take(target.requests)).toEqual({
          url: "/mcp?session=1",
          authorization: "Bearer token-a",
        });
        expect((yield* httpRequest(mcpB, "Bearer token-b")).status).toBe(200);
        expect((yield* Queue.take(target.requests)).authorization).toBe("Bearer token-b");

        // Codex: a sibling instance's frame is refused before the broker sees it.
        const codexA = yield* forwards.open({
          sandboxId: sandboxA,
          name: "codex-token",
          ownerKey: "instance-a",
        });
        expect(yield* unixRoundTrip(codexA, codexFrame("instance-b"))).toBe("");
        expect(yield* unixRoundTrip(codexA, codexFrame("instance-a"))).toBe(
          '{"token":"chatgpt-token"}\n',
        );
        expect(yield* Queue.take(brokerFrames)).toBe(`${codexFrame("instance-a")}\n`);

        // Git: a thread of the other sandbox gets nothing, and the service is never asked.
        const ask = (threadId?: ThreadId) =>
          unixRoundTrip(
            gitA,
            JSON.stringify({
              version: 1,
              operation: "get",
              protocol: "https",
              host: "github.com",
              ...(threadId === undefined ? {} : { threadId }),
            }),
          ).pipe(Effect.map((line) => JSON.parse(line) as unknown));
        expect(yield* ask(threadB)).toEqual({ version: 1, credential: null });
        expect(yield* ask(threadA)).toEqual({
          version: 1,
          credential: {
            username: "x-access-token",
            password: "token-for-thread-a",
            expiresAt: "2026-11-07T13:00:00.000Z",
          },
        });
        expect(yield* Queue.take(gitCalls)).toMatchObject({
          sandboxId: sandboxA,
          threadId: threadA,
        });
        expect(yield* Queue.size(gitCalls)).toBe(0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
