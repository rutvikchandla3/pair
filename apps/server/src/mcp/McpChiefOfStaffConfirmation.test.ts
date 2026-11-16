import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MemberId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as ChiefOfStaffAudit from "../chiefOfStaff/ChiefOfStaffAudit.ts";
import * as ChiefOfStaffConfirmation from "../chiefOfStaff/ChiefOfStaffConfirmation.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";

const environmentId = EnvironmentId.make("cos-confirm-environment");
const memberId = MemberId.make("member-1");

const scope = (
  chiefOfStaff?: McpInvocationContext.McpInvocationScope["chiefOfStaff"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider:thread:home",
  thread: {
    threadId: ThreadId.make("thread:home"),
    providerSessionId: "provider:thread:home",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  ...(chiefOfStaff === undefined ? {} : { chiefOfStaff }),
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "cos-confirm-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cos-confirm-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const probe = {
  parameters: Schema.Struct({ ref: Schema.String }),
  success: Schema.Struct({ ran: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext],
};
const ProbeToolkit = Toolkit.make(
  Tool.make("probe_ok", probe),
  Tool.make("t3_project_delete", probe),
);
const layerProbe = (calls: Queue.Queue<string>) =>
  McpToolAccess.toLayer(ProbeToolkit, {
    probe_ok: McpToolAccess.reads((input: { readonly ref: string }) =>
      Queue.offer(calls, "probe_ok").pipe(Effect.as({ ran: input.ref })),
    ),
    t3_project_delete: McpToolAccess.reads((input: { readonly ref: string }) =>
      Queue.offer(calls, "t3_project_delete").pipe(Effect.as({ ran: input.ref })),
    ),
  });

const confirmLayer = (confirm: () => Effect.Effect<ChiefOfStaffAudit.AuditConfirmation>) =>
  Layer.succeed(
    ChiefOfStaffConfirmation.ChiefOfStaffConfirmation,
    ChiefOfStaffConfirmation.ChiefOfStaffConfirmation.of({
      confirm: () => confirm(),
    }),
  );

const serverLayer = (
  confirm: () => Effect.Effect<ChiefOfStaffAudit.AuditConfirmation>,
  calls: Queue.Queue<string>,
) =>
  McpHttpServer.toolkitRegistration(ProbeToolkit, layerProbe(calls)).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(confirmLayer(confirm)),
  );

const layerServices = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-cos-confirm-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const callWith = (
  confirm: () => Effect.Effect<ChiefOfStaffAudit.AuditConfirmation>,
  calls: Queue.Queue<string>,
  tool: string,
  invocation: McpInvocationContext.McpInvocationScope,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({ name: tool, arguments: { ref: "ran" } });
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    Effect.provide(serverLayer(confirm, calls)),
    Effect.provide(layerServices),
  );

const chiefOfStaff = { via: "home-thread" as const, memberId };

const errorMessageOf = (result: McpSchema.CallToolResult) => {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
};

it.effect("runs the handler when the person allows", () =>
  Effect.gen(function* () {
    const calls = yield* Queue.unbounded<string>();
    const result = yield* callWith(
      () => Effect.succeed("allowed" as const),
      calls,
      "t3_project_delete",
      scope(chiefOfStaff),
    );
    expect(result.isError).not.toBe(true);
    expect(yield* Queue.take(calls)).toBe("t3_project_delete");
  }),
);

it.effect("denies with capability_denied and does not run the handler", () =>
  Effect.gen(function* () {
    const calls = yield* Queue.unbounded<string>();
    const result = yield* callWith(
      () => Effect.succeed("denied" as const),
      calls,
      "t3_project_delete",
      scope(chiefOfStaff),
    );
    expect(result.isError).toBe(true);
    expect(errorMessageOf(result)).toContain("The user declined");
    expect(errorMessageOf(result)).toContain("capability_denied");
    expect(yield* Queue.size(calls)).toBe(0);
  }),
);

it.effect("times out with capability_denied and does not run the handler", () =>
  Effect.gen(function* () {
    const calls = yield* Queue.unbounded<string>();
    const entered = yield* Deferred.make<void>();
    const fiber = yield* callWith(
      () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.sleep(Duration.minutes(10))),
          Effect.as("timeout" as const),
        ),
      calls,
      "t3_project_delete",
      scope(chiefOfStaff),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.minutes(10));
    yield* TestClock.adjust(Duration.minutes(1));
    const result = yield* Fiber.join(fiber);
    expect(result.isError).toBe(true);
    expect(errorMessageOf(result)).toContain("No answer in time");
    expect(yield* Queue.size(calls)).toBe(0);
  }),
);

it.effect("leaves a caller who is not Chief of staff untouched", () =>
  Effect.gen(function* () {
    const calls = yield* Queue.unbounded<string>();
    const result = yield* callWith(
      () => Effect.die("the gate must not ask"),
      calls,
      "t3_project_delete",
      scope(),
    );
    expect(result.isError).not.toBe(true);
    expect(yield* Queue.take(calls)).toBe("t3_project_delete");
  }),
);

it.effect("leaves an ordinary Chief of staff tool untouched", () =>
  Effect.gen(function* () {
    const calls = yield* Queue.unbounded<string>();
    const result = yield* callWith(
      () => Effect.die("the gate must not ask"),
      calls,
      "probe_ok",
      scope(chiefOfStaff),
    );
    expect(result.isError).not.toBe(true);
    expect(yield* Queue.take(calls)).toBe("probe_ok");
  }),
);
