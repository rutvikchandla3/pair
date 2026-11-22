import {
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";

export const WORKSPACE_PROJECT_ID = ProjectId.make("workspace-project");
const INSTANCE_ID = ProviderInstanceId.make("codex");

export const threadShell = (
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  id: ThreadId.make(id),
  projectId: WORKSPACE_PROJECT_ID,
  title: "Fix the login bug",
  providerInstanceId: INSTANCE_ID,
  modelSelection: { instanceId: INSTANCE_ID, model: "test-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  activityRunStatus: null,
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  providerInstanceHistory: [],
  itemCount: 0,
  visibleItemCount: 0,
  createdBy: "user",
  creationSource: "web",
  createdAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-11-01T00:05:00.000Z"),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  ...overrides,
});

/** A test server config in Pair Builder host mode. */
export const layerHostConfig = (pairBuilder: ServerConfig.PairBuilderHostConfig) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    ServerConfig.ServerConfig.pipe(Effect.map((config) => ({ ...config, pairBuilder }))),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pair-builder-" })),
    Layer.provide(NodeServices.layer),
  );
