import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MemberId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as ChiefOfStaffAudit from "../chiefOfStaff/ChiefOfStaffAudit.ts";
import { CHIEF_OF_STAFF_MCP_LABEL } from "../chiefOfStaff/caller.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";

const environmentId = EnvironmentId.make("cos-audit-environment");
const memberId = MemberId.make("member-1");

const voiceScope = (label: string = CHIEF_OF_STAFF_MCP_LABEL) => ({
  environmentId,
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label, access: "full-access" as const, memberId },
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 0,
});

const threadScope = (threadId: string): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId: ThreadId.make(threadId),
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "cos-audit-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cos-audit-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const probe = {
  success: Schema.Struct({ ran: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext],
};
const ProbeToolkit = Toolkit.make(Tool.make("probe_ok", probe), Tool.make("probe_fail", probe));
const layerProbe = McpToolAccess.toLayer(ProbeToolkit, {
  probe_ok: McpToolAccess.reads(() => Effect.succeed({ ran: "ok" })),
  probe_fail: McpToolAccess.reads(() =>
    Effect.fail(new OrchestratorMcpFailure({ code: "orchestration_error", message: "Nope." })),
  ),
});

const auditMock = (signals: Queue.Queue<ChiefOfStaffAudit.AuditRecordInput>) =>
  Layer.succeed(
    ChiefOfStaffAudit.ChiefOfStaffAudit,
    ChiefOfStaffAudit.ChiefOfStaffAudit.of({
      record: (input) => Queue.offer(signals, input).pipe(Effect.asVoid),
      recent: () => Effect.succeed([]),
    }),
  );

const serverLayer = (signals: Queue.Queue<ChiefOfStaffAudit.AuditRecordInput>) =>
  McpHttpServer.toolkitRegistration(ProbeToolkit, layerProbe).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(auditMock(signals)),
  );

const callWith = (
  signals: Queue.Queue<ChiefOfStaffAudit.AuditRecordInput>,
  tool: string,
  scope: McpInvocationContext.McpInvocationScope,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: tool, arguments: {} })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    Effect.provide(serverLayer(signals)),
  );

const layerServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-cos-hook-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const writeThreads = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const file = path.join(config.stateDir, "chief-of-staff", "threads.json");
  yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
  yield* fileSystem.writeFileString(file, JSON.stringify({ "home:member-1": "thread:home" }));
});

it.effect("records a voice client call as the member's voice session", () =>
  Effect.gen(function* () {
    const signals = yield* Queue.unbounded<ChiefOfStaffAudit.AuditRecordInput>();
    yield* callWith(signals, "probe_ok", voiceScope());
    expect(yield* Queue.take(signals)).toMatchObject({
      via: "voice",
      memberId: "member-1",
      tool: "probe_ok",
      outcome: "ok",
    });
  }).pipe(Effect.provide(layerServices)),
);

it.effect("records a declared failure's outcome and code", () =>
  Effect.gen(function* () {
    const signals = yield* Queue.unbounded<ChiefOfStaffAudit.AuditRecordInput>();
    yield* callWith(signals, "probe_fail", voiceScope());
    expect(yield* Queue.take(signals)).toMatchObject({
      via: "voice",
      tool: "probe_fail",
      outcome: "error",
      errorCode: "orchestration_error",
    });
  }).pipe(Effect.provide(layerServices)),
);

it.effect("records a home-thread caller with its member and thread", () =>
  Effect.gen(function* () {
    const signals = yield* Queue.unbounded<ChiefOfStaffAudit.AuditRecordInput>();
    yield* writeThreads;
    yield* callWith(signals, "probe_ok", threadScope("thread:home"));
    expect(yield* Queue.take(signals)).toMatchObject({
      via: "home-thread",
      memberId: "member-1",
      threadId: "thread:home",
      tool: "probe_ok",
      outcome: "ok",
    });
  }).pipe(Effect.provide(layerServices)),
);

it.effect("records nothing for an ordinary client", () =>
  Effect.gen(function* () {
    const signals = yield* Queue.unbounded<ChiefOfStaffAudit.AuditRecordInput>();
    yield* callWith(signals, "probe_ok", voiceScope("Claude Code"));
    yield* Effect.yieldNow;
    expect(yield* Queue.size(signals)).toBe(0);
  }).pipe(Effect.provide(layerServices)),
);

it.effect("records nothing for a thread that is not a home thread", () =>
  Effect.gen(function* () {
    const signals = yield* Queue.unbounded<ChiefOfStaffAudit.AuditRecordInput>();
    yield* writeThreads;
    yield* callWith(signals, "probe_ok", threadScope("thread:home"));
    yield* Queue.take(signals);
    yield* callWith(signals, "probe_ok", threadScope("thread:ordinary"));
    yield* Effect.yieldNow;
    expect(yield* Queue.size(signals)).toBe(0);
  }).pipe(Effect.provide(layerServices)),
);
