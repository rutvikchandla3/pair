import { assert, it } from "@effect/vitest";
import {
  type ManagedPolicySummary,
  MemberId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { acpPermissionDisposition } from "@t3tools/provider-acp/server/clientPolicy";
import type * as Members from "../persistence/Members.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TeamState from "../team/TeamState.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const workspaceProjectId = ProjectId.make("project:runtime-policy-workspace");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
  readonly ownerId?: MemberId | null | undefined;
  readonly projectId?: ProjectId;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: input.projectId ?? projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
  };
}

const grokInstanceId = ProviderInstanceId.make("grok");
const antigravityInstanceId = ProviderInstanceId.make("antigravity");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
  [antigravityInstanceId, ["approval-required", "auto-accept-edits", "full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as ProviderInstance;

const layerWithPolicy = (policy?: ManagedPolicySummary) =>
  RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(ServerSettings.layerTest({}, policy)),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (requested) =>
          Effect.succeedSome({
            ...(requested === workspaceProjectId
              ? { roots: [{ projectId, name: "project" }] }
              : {}),
            projectId: requested,
            title: "Project",
            workspaceRoot: "/project-root",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            pinnedAt: null,
            archivedAt: null,
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
      }),
    ),
  );

const layerTest = layerWithPolicy();

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("asks for Antigravity command approval when a stored Auto thread falls back", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolve = (runtimeMode: RuntimeMode) =>
        policy.resolve({
          thread: makeThread({ now, worktreePath: null, runtimeMode }),
          modelSelection: { instanceId: antigravityInstanceId, model: "test-model" },
        });
      const request = {
        sessionId: "session-1",
        toolCall: { toolCallId: "command-1", title: "Run command", kind: "execute" as const },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
      };
      const auto = yield* resolve("auto");
      assert.equal(auto.runtimeMode, "approval-required");
      assert.equal(acpPermissionDisposition(auto, request), "ask");
      assert.equal(acpPermissionDisposition(yield* resolve("auto-accept-edits"), request), "ask");
      assert.equal(acpPermissionDisposition(yield* resolve("full-access"), request), "allow");
    }),
  );

  it.effect("runs a thread in its folder, or its project's, but never in a workspace's own", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const cwdOf = (worktreePath: string | null, threadProjectId?: ProjectId) =>
        policy
          .resolve({
            thread: makeThread({
              now,
              worktreePath,
              ...(threadProjectId === undefined ? {} : { projectId: threadProjectId }),
            }),
            modelSelection,
          })
          .pipe(Effect.map((resolved) => resolved.cwd));
      assert.equal(yield* cwdOf(null), "/project-root");
      assert.equal(
        yield* cwdOf("/worktrees/stack/feature", workspaceProjectId),
        "/worktrees/stack/feature",
      );
      const refused = yield* cwdOf(null, workspaceProjectId).pipe(Effect.flip);
      assert.equal(refused._tag, "RuntimePolicyResolveError");
    }),
  );

  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
      const withoutTeam = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.isFalse("gitAuthor" in withoutTeam);
    }),
  );
});

const member = (id: string, fields: Partial<Members.MemberRecord> = {}): Members.MemberRecord => ({
  id: MemberId.make(id),
  name: id,
  role: "member",
  gitName: null,
  gitEmail: null,
  isOwner: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
  removedAt: null,
  ...fields,
});

it.layer(
  layerWithPolicy().pipe(
    Layer.provide(
      TeamState.layerTest([
        member("alice", { isOwner: true, role: "admin", gitEmail: "alice@example.com" }),
        member("bob", { gitName: "Bob B", gitEmail: "bob@example.com" }),
        member("carol"),
        member("dave", { gitEmail: "dave@example.com", removedAt: "2026-02-01T00:00:00.000Z" }),
      ]),
    ),
  ),
)("RuntimePolicyV2 in a team", (it) => {
  it.effect("authors agent commits as the thread holder only when they set a git email", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const authorOf = (ownerId: MemberId | null | undefined) =>
        policy.resolve({
          thread: makeThread({ now, worktreePath: null, ownerId }),
          modelSelection,
        });

      assert.deepStrictEqual((yield* authorOf(MemberId.make("bob"))).gitAuthor, {
        name: "Bob B",
        email: "bob@example.com",
      });
      assert.isFalse("gitAuthor" in (yield* authorOf(MemberId.make("carol"))));
      assert.isFalse("gitAuthor" in (yield* authorOf(MemberId.make("dave"))));
      const serverOwner = { name: "alice", email: "alice@example.com" };
      assert.deepStrictEqual((yield* authorOf(null)).gitAuthor, serverOwner);
      assert.deepStrictEqual((yield* authorOf(undefined)).gitAuthor, serverOwner);
    }),
  );
});

it.layer(
  layerWithPolicy({
    organization: "Example Corp",
    lockedSettings: [],
    limits: { maxRuntimeMode: "auto-accept-edits" },
  }),
)("RuntimePolicyV2 under a runtime mode ceiling", (it) => {
  it.effect("refuses to start a turn above the ceiling, such as one resumed after a restart", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolve = (runtimeMode: RuntimeMode) =>
        policy.resolve({
          thread: makeThread({ now, worktreePath: "/work", runtimeMode }),
          modelSelection,
        });

      const refused = yield* resolve("full-access").pipe(Effect.flip);
      assert.equal(refused._tag, "RuntimePolicyAboveCeilingError");
      assert.equal(
        refused.message,
        "Example Corp limits threads to Auto-accept edits. Switch this thread's mode to continue.",
      );
      const allowed = yield* resolve("auto-accept-edits");
      assert.equal(allowed.runtimeMode, "auto-accept-edits");
      assert.equal(allowed.maxRuntimeMode, "auto-accept-edits");
    }),
  );
});
