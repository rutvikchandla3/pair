import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, MemberId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ChiefOfStaffMemory from "../../../chiefOfStaff/ChiefOfStaffMemory.ts";
import { homeThreadsFile } from "../../../chiefOfStaff/homeThreads.ts";
import { ServerConfig } from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Handlers from "./handlers.ts";
import { ChiefOfStaffMemoryToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:cos-memory");
const member = MemberId.make("member-a");
const homeThreadId = ThreadId.make("thread:home-a");

const threadScope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider:cos-memory",
  thread: {
    threadId,
    providerSessionId: "provider:cos-memory",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

const clientScope = (memberId: MemberId | undefined): McpInvocationContext.McpInvocationScope => ({
  ...threadScope(homeThreadId),
  thread: undefined,
  client: {
    sessionId: "session:cos-memory",
    label: "Chief of staff",
    access: "full-access",
    memberId,
  },
});

const layerFor = (scope: McpInvocationContext.McpInvocationScope) => {
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-cos-memory-tools-test-" });
  const memory = ChiefOfStaffMemory.layer.pipe(Layer.provideMerge(config));
  return McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(
    Layer.provideMerge(memory),
    Layer.provideMerge(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
    Layer.provideMerge(Layer.succeed(McpInvocationContext.McpInvocationContext, scope)),
    Layer.provideMerge(NodeServices.layer),
  );
};

const writeHomeThreads = (contents: string) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = homeThreadsFile(config.stateDir, path);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, contents);
  });

const call = (name: "cos_memory_read" | "cos_memory_history", params: object) =>
  Effect.gen(function* () {
    const toolkit = yield* ChiefOfStaffMemoryToolkit;
    const messages = yield* toolkit.handle(name, params).pipe(Stream.unwrap, Stream.runCollect);
    return messages.at(-1)?.result;
  });

type ReadResult = {
  memberId: string;
  blocks: Array<{ label: string; size: number; limit: number }>;
};

it.effect("serves a home thread its own memory", () =>
  Effect.gen(function* () {
    yield* writeHomeThreads(JSON.stringify({ [`home:${member}`]: String(homeThreadId) }));
    const result = (yield* call("cos_memory_read", {})) as unknown as ReadResult;
    expect(result.memberId).toBe(member);
    expect(result.blocks.find((block) => block.label === "profile")).toMatchObject({
      size: 0,
      limit: 1500,
    });
  }).pipe(Effect.provide(layerFor(threadScope(homeThreadId)))),
);

it.effect("serves a client whose member owns a home thread", () =>
  Effect.gen(function* () {
    yield* writeHomeThreads(JSON.stringify({ [`home:${member}`]: String(homeThreadId) }));
    const result = yield* call("cos_memory_history", {});
    expect(result).toEqual({ entries: [] });
  }).pipe(Effect.provide(layerFor(clientScope(member)))),
);

it.effect("refuses a thread that is not a home thread", () =>
  Effect.gen(function* () {
    yield* writeHomeThreads(JSON.stringify({ [`home:${member}`]: String(homeThreadId) }));
    const result = yield* call("cos_memory_read", {});
    expect(result).toMatchObject({ code: "capability_denied" });
  }).pipe(Effect.provide(layerFor(threadScope(ThreadId.make("thread:ordinary"))))),
);

it.effect("refuses a client whose member has no home thread", () =>
  Effect.gen(function* () {
    yield* writeHomeThreads(JSON.stringify({ [`home:${member}`]: String(homeThreadId) }));
    const result = yield* call("cos_memory_read", {});
    expect(result).toMatchObject({ code: "capability_denied" });
  }).pipe(Effect.provide(layerFor(clientScope(MemberId.make("member-b"))))),
);
