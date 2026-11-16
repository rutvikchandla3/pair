import { expect, it } from "@effect/vitest";
import { EnvironmentId, MemberId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as ChiefOfStaffAudit from "../../../chiefOfStaff/ChiefOfStaffAudit.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ChiefOfStaffAuditHandlers from "./handlers.ts";
import { ChiefOfStaffAuditToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("cos-toolkit-environment");
const memberId = MemberId.make("member-1");
const entry: ChiefOfStaffAudit.AuditEntry = {
  at: "2024-01-01T00:00:00.000Z",
  via: "voice",
  memberId,
  tool: "t3_environment_read",
  args: "{}",
  outcome: "ok",
  durationMs: 5,
};

const voiceScope = (
  chiefOfStaff?: McpInvocationContext.McpInvocationScope["chiefOfStaff"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "client:session",
  thread: undefined,
  client: {
    sessionId: "session",
    label: "Chief of staff",
    access: "full-access" as const,
    memberId,
  },
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
  ...(chiefOfStaff === undefined ? {} : { chiefOfStaff }),
});

const threadScope = (
  threadId: string,
  chiefOfStaff?: McpInvocationContext.McpInvocationScope["chiefOfStaff"],
): McpInvocationContext.McpInvocationScope => ({
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
  ...(chiefOfStaff === undefined ? {} : { chiefOfStaff }),
});

const auditService = Layer.succeed(
  ChiefOfStaffAudit.ChiefOfStaffAudit,
  ChiefOfStaffAudit.ChiefOfStaffAudit.of({
    record: () => Effect.void,
    recent: () => Effect.succeed([entry]),
  }),
);

const layerFor = (scope: McpInvocationContext.McpInvocationScope) => {
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-cos-toolkit-" });
  return McpToolAccess.HandlersLayer.layer(ChiefOfStaffAuditHandlers.layer).pipe(
    Layer.provideMerge(auditService),
    Layer.provideMerge(config),
    Layer.provideMerge(Layer.succeed(McpInvocationContext.McpInvocationContext, scope)),
    Layer.provideMerge(NodeServices.layer),
  );
};

const call = () =>
  Effect.gen(function* () {
    const toolkit = yield* ChiefOfStaffAuditToolkit;
    const messages = yield* toolkit
      .handle("cos_audit_read", { limit: 5 })
      .pipe(Stream.unwrap, Stream.runCollect);
    return messages.at(-1)?.result;
  });

it.effect("lets a Chief of staff client read the audit log", () =>
  Effect.gen(function* () {
    expect(yield* call()).toEqual({ entries: [entry] });
  }).pipe(Effect.provide(layerFor(voiceScope({ via: "voice", memberId })))),
);

it.effect("lets a home thread read the audit log", () =>
  Effect.gen(function* () {
    expect(yield* call()).toEqual({ entries: [entry] });
  }).pipe(Effect.provide(layerFor(threadScope("thread:home", { via: "home-thread", memberId })))),
);

it.effect("refuses an ordinary client", () =>
  Effect.gen(function* () {
    expect(yield* call()).toMatchObject({ code: "capability_denied" });
  }).pipe(Effect.provide(layerFor(voiceScope()))),
);

it.effect("refuses an ordinary thread", () =>
  Effect.gen(function* () {
    expect(yield* call()).toMatchObject({ code: "capability_denied" });
  }).pipe(Effect.provide(layerFor(threadScope("thread:ordinary")))),
);
