import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("A refused command never opens a session"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  Layer.mergeAll(EventStore.layer, CommandReceiptStore.layer).pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "cloud-only-dispatch" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false, cloudOnly: true },
  ),
);

it.layer(layerTest)("cloud-only dispatch", (it) => {
  it.effect("refuses a prompt, a rollback and a retry on a local thread and records nothing", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const events = yield* EventStore.EventStoreV2;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const threadId = ThreadId.make("thread:cloud-only-local");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:cloud-only-local"),
        threadId,
        projectId: ProjectId.make("project:cloud-only"),
        title: "Local thread",
        modelSelection: { instanceId, model: "gpt-5" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const sequence = yield* events.latestSequence();

      for (const command of [
        {
          type: "message.dispatch",
          commandId: CommandId.make("cloud-only:prompt"),
          threadId,
          messageId: MessageId.make("cloud-only:message"),
          text: "Run the tests",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        },
        {
          type: "checkpoint.rollback",
          commandId: CommandId.make("cloud-only:rollback"),
          threadId,
          scopeId: CheckpointScopeId.make("scope:cloud-only"),
          checkpointId: CheckpointId.make("checkpoint:cloud-only"),
        },
        {
          type: "prepared-run.retry",
          commandId: CommandId.make("cloud-only:retry"),
          threadId,
          runId: RunId.make("run:cloud-only"),
        },
      ] as const) {
        const refused = yield* Effect.flip(orchestrator.dispatch(command));
        assert.equal(refused._tag, "OrchestratorLocalThreadReadOnlyError", command.type);
        assert.isTrue(Option.isNone(yield* receipts.getByCommandId(command.commandId)));
      }
      assert.equal(yield* events.latestSequence(), sequence);
    }),
  );
});
