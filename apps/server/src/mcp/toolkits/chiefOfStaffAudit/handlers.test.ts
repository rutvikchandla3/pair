import { expect, it } from "@effect/vitest";
import { EnvironmentId, MemberId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as ChiefOfStaffAudit from "../../../chiefOfStaff/ChiefOfStaffAudit.ts";
import { CHIEF_OF_STAFF_MCP_LABEL } from "../../../chiefOfStaff/caller.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ChiefOfStaffAuditHandlers from "./handlers.ts";
import { ChiefOfStaffAuditToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("cos-toolkit-environment");
const entry: ChiefOfStaffAudit.AuditEntry = {
  at: "2024-01-01T00:00:00.000Z",
  via: "voice",
  memberId: MemberId.make("member-1"),
  tool: "t3_environment_read",
  args: "{}",
  outcome: "ok",
  durationMs: 5,
};

const voiceScope = (label: string = CHIEF_OF_STAFF_MCP_LABEL) => ({
  environmentId,
  requestNamespace: "client:session",
  thread: undefined,
  client: {
    sessionId: "session",
    label,
    access: "full-access" as const,
    memberId: MemberId.make("member-1"),
  },
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
  clientInfo: { name: "cos-toolkit-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cos-toolkit-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const toolkitLayer = McpHttpServer.toolkitRegistration(
  ChiefOfStaffAuditToolkit,
  ChiefOfStaffAuditHandlers.layer,
).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(
    Layer.succeed(
      ChiefOfStaffAudit.ChiefOfStaffAudit,
      ChiefOfStaffAudit.ChiefOfStaffAudit.of({
        record: () => Effect.void,
        recent: () => Effect.succeed([entry]),
      }),
    ),
  ),
);

const call = (scope: McpInvocationContext.McpInvocationScope) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) =>
      server.callTool({ name: "cos_audit_read", arguments: { limit: 5 } }),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const declaredCode = (result: McpSchema.CallToolResult): string | undefined => {
  if (result.isError !== true) return undefined;
  const block = result.content[0];
  if (block?.type !== "text") return undefined;
  return (JSON.parse(block.text) as { readonly code?: string }).code;
};

const layerServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-cos-toolkit-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("lets a Chief of staff client read the audit log", () =>
  Effect.gen(function* () {
    const result = yield* call(voiceScope());
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ entries: [entry] });
  }).pipe(Effect.provide(Layer.merge(toolkitLayer, layerServices))),
);

it.effect("lets a home thread read the audit log", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const file = path.join(config.stateDir, "chief-of-staff", "threads.json");
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(file, JSON.stringify({ "home:member-1": "thread:home" }));
    const result = yield* call(threadScope("thread:home"));
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ entries: [entry] });
  }).pipe(Effect.provide(Layer.merge(toolkitLayer, layerServices))),
);

it.effect("refuses an ordinary client", () =>
  Effect.gen(function* () {
    expect(declaredCode(yield* call(voiceScope("Claude Code")))).toBe("capability_denied");
  }).pipe(Effect.provide(Layer.merge(toolkitLayer, layerServices))),
);

it.effect("refuses an ordinary thread", () =>
  Effect.gen(function* () {
    expect(declaredCode(yield* call(threadScope("thread:ordinary")))).toBe("capability_denied");
  }).pipe(Effect.provide(Layer.merge(toolkitLayer, layerServices))),
);
