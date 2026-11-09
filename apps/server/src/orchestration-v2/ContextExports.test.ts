import { assert, it } from "@effect/vitest";
import {
  CommandId,
  CONTEXT_EXPORT_MAX_BYTES,
  CONTEXT_EXPORT_MAX_MESSAGE_CHARS,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ContextExport,
  type OrchestrationV2ContextExportMessage,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ContextExports from "./ContextExports.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const at = (minute: number) =>
  DateTime.makeUnsafe(`2026-11-09T10:${String(minute).padStart(2, "0")}:00.000Z`);
const message = (
  role: "user" | "assistant",
  text: string,
  minute = 0,
): OrchestrationV2ContextExportMessage => ({ role, text, createdAt: at(minute) });
const pad = (index: number) => String(index).padStart(2, "0").repeat(30_000);

it.each([
  {
    name: "keeps a conversation under the caps whole",
    messages: [message("assistant", "Hi"), message("user", "Fix it"), message("assistant", "Done")],
    kept: ["Hi", "Fix it", "Done"],
    omitted: 0,
  },
  {
    name: "keeps the first user message and the newest over the message cap",
    messages: [
      message("assistant", "Welcome"),
      message("user", "first"),
      ...Array.from({ length: 1_200 }, (_, index) => message("assistant", `reply ${index}`)),
    ],
    kept: ["first", ...Array.from({ length: 999 }, (_, index) => `reply ${index + 201}`)],
    omitted: 202,
  },
  {
    name: "keeps the first user message and the newest over the byte cap",
    messages: [
      message("user", "first"),
      ...Array.from({ length: 40 }, (_, index) => message("assistant", pad(index))),
    ],
    kept: ["first", ...Array.from({ length: 34 }, (_, index) => pad(index + 6))],
    omitted: 6,
  },
])("capContextExport $name", ({ messages, kept, omitted }) => {
  const capped = ContextExports.capContextExport(messages);
  assert.deepEqual(
    capped.messages.map((kept) => kept.text),
    kept,
  );
  assert.equal(capped.omittedMessageCount, omitted);
});

it("capContextExport shortens a long message without splitting a surrogate pair", () => {
  const marker = "\n\n[Message shortened; the rest is on the original thread.]";
  const cut = CONTEXT_EXPORT_MAX_MESSAGE_CHARS - marker.length;
  const text = `${"a".repeat(cut - 1)}😀${"b".repeat(100)}`;
  const [shortened] = ContextExports.capContextExport([message("user", text)]).messages;
  assert.equal(shortened?.text, `${"a".repeat(cut - 1)}${marker}`);
});

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const environmentId = EnvironmentId.make("environment:cloud");

const layerTest = (() => {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "context-exports" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(ServerSettings.layerTest({})),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  return Layer.mergeAll(
    ContextExports.layer.pipe(
      Layer.provide(layerThreadManagement),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({ environmentId, label: "Pair Cloud" } as never),
        }),
      ),
    ),
    layerThreadManagement,
    layerOrchestrator,
  );
})();

const dispatch = (command: OrchestrationV2ServerCommand) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) => orchestrator.dispatch(command));

const createThread = (threadId: ThreadId) =>
  dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId: ProjectId.make("project:exports"),
    title: "Fix the flaky test",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });

const send = (threadId: ThreadId, id: string, text = id, queue = false) =>
  dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`send:${id}`),
    threadId,
    messageId: MessageId.make(id),
    text,
    attachments: [],
    dispatchMode: queue ? { type: "queue_after_active" } : { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });

const laptopExport = (
  messages: ReadonlyArray<OrchestrationV2ContextExportMessage>,
  omittedMessageCount = 0,
): OrchestrationV2ContextExport => ({
  version: 1,
  source: {
    environmentId: EnvironmentId.make("environment:laptop"),
    threadId: ThreadId.make("thread:laptop"),
    title: "Fix the flaky test",
    environmentLabel: "Kim's MacBook Pro",
  },
  exportedAt: at(30),
  messages,
  omittedMessageCount,
});

/** Each row as `type: text`, in timeline order, with whether it rides a run. */
const timeline = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId);
    return projection.visibleTurnItems.map(({ item }) => {
      const text =
        item.type === "user_message" || item.type === "assistant_message"
          ? item.text
          : item.type === "system_notice" || item.type === "move"
            ? item.message
            : "";
      return `${item.runId === null ? "" : "run "}${item.type}: ${text}`;
    });
  });

it.effect("imports an export as runless history the first run hands off", () =>
  Effect.gen(function* () {
    const exports = yield* ContextExports.ContextExports;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:imported");
    yield* createThread(threadId);
    // Over the handoff's token cap, so the handoff leaves some out and points at them.
    const long = (label: string) => `${label} ${"word ".repeat(6_000)}`;
    yield* exports.import({
      commandId: CommandId.make("import:imported"),
      threadId,
      contextExport: laptopExport(
        [
          message("user", long("first"), 1),
          message("assistant", long("second"), 5),
          message("user", long("third"), 6),
          message("assistant", long("fourth"), 7),
        ],
        2,
      ),
    });

    const imported = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(imported.thread.historyOrigin, "context_export");
    assert.deepEqual(
      (yield* timeline(threadId)).map((row) => row.slice(0, row.indexOf(":") + 7)),
      [
        "user_message: first",
        "system_notice: 2 ear",
        "assistant_message: secon",
        "user_message: third",
        "assistant_message: fourt",
        "move: Conti",
      ],
    );
    assert.deepEqual((yield* timeline(threadId)).slice(1, 2), [
      "system_notice: 2 earlier messages stayed on the original thread on Kim's MacBook Pro.",
    ]);
    assert.deepEqual((yield* timeline(threadId)).slice(-1), [
      "move: Continued from “Fix the flaky test” on Kim's MacBook Pro",
    ]);

    yield* send(threadId, "next");
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const handoff = projection.contextHandoffs[0];
    assert.equal(handoff?.strategy, "manual_context");
    assert.deepEqual(handoff?.fromProviderThreadIds, []);
    assert.isTrue(
      handoff?.summaryText?.startsWith(
        "Conversation carried over from the thread this one continues, in another T3 Code environment.",
      ),
    );
    const omitted = handoff?.history?.omittedItemIds ?? [];
    assert.isAbove(omitted.length, 0);
    for (const itemId of omitted) {
      assert.isNotNull(yield* orchestrator.getTurnItem({ threadId, itemId }));
    }
    // The history sits before run 1.
    assert.deepEqual((yield* timeline(threadId)).at(-1), "run user_message: next");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("replays an import and refuses a used thread or an export over the cap", () =>
  Effect.gen(function* () {
    const exports = yield* ContextExports.ContextExports;
    const threadId = ThreadId.make("thread:replayed");
    yield* createThread(threadId);
    const contextExport = laptopExport([message("user", "Why does it flake?")]);
    const input = { commandId: CommandId.make("import:replayed"), threadId, contextExport };
    yield* exports.import(input);
    const before = yield* timeline(threadId);
    yield* exports.import(input);
    assert.deepEqual(yield* timeline(threadId), before);

    const reasonOf = (effect: Effect.Effect<void, ContextExports.ContextExportError>) =>
      effect.pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      );
    assert.equal(
      yield* reasonOf(exports.import({ ...input, commandId: CommandId.make("import:again") })),
      "not-empty",
    );
    const used = ThreadId.make("thread:used");
    yield* createThread(used);
    yield* send(used, "hello");
    assert.equal(
      yield* reasonOf(
        exports.import({ commandId: CommandId.make("import:used"), threadId: used, contextExport }),
      ),
      "not-empty",
    );
    assert.equal(
      yield* reasonOf(
        exports.import({
          commandId: CommandId.make("import:missing"),
          threadId: ThreadId.make("thread:missing"),
          contextExport,
        }),
      ),
      "not-found",
    );
    const fresh = ThreadId.make("thread:fresh");
    yield* createThread(fresh);
    const huge = laptopExport(
      Array.from({ length: Math.ceil(CONTEXT_EXPORT_MAX_BYTES / 60_000) + 1 }, () =>
        message("assistant", "x".repeat(60_000)),
      ),
    );
    assert.equal(
      yield* reasonOf(
        exports.import({
          commandId: CommandId.make("import:huge"),
          threadId: fresh,
          contextExport: huge,
        }),
      ),
      "too-large",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("builds an export from the visible conversation", () =>
  Effect.gen(function* () {
    const exports = yield* ContextExports.ContextExports;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const source = ThreadId.make("thread:source");
    yield* createThread(source);
    yield* exports.import({
      commandId: CommandId.make("import:source"),
      threadId: source,
      contextExport: laptopExport([message("user", "inherited question", 1)]),
    });
    yield* send(source, "source-run", "Where were we?");
    const now = yield* DateTime.now;
    const sourceRun = (yield* orchestrator.getThreadProjection(source)).runs[0]!;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:source-run"),
          type: "run.updated",
          threadId: source,
          runId: sourceRun.id,
          occurredAt: now,
          payload: { ...sourceRun, status: "completed", completedAt: now },
        },
      ],
    });
    const threadId = ThreadId.make("thread:fork");
    yield* dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork:source"),
      sourceThreadId: source,
      targetThreadId: threadId,
      sourcePoint: { type: "run", runId: sourceRun.id },
      title: "Fix the flaky test",
      createdBy: "user",
      creationSource: "web",
    });
    yield* send(threadId, "kept", "Why does it flake?");
    const reply = (id: string, runIndex: number, text: string) =>
      Effect.gen(function* () {
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs[runIndex]!;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`event:${id}`),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(id),
                threadId,
                runId: run.id,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "assistant_message",
                messageId: MessageId.make(id),
                text,
                streaming: false,
              },
            },
            {
              id: EventId.make(`event:${id}:tool`),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`${id}:tool`),
                threadId,
                runId: run.id,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "completed",
                title: "Read notes",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "command_execution",
                input: "cat notes.md",
                output: "notes",
              },
            },
          ],
        });
        return run;
      });
    yield* reply("reply:kept", 0, "A race in the setup.");
    yield* send(threadId, "compact", "/compact", true);
    yield* send(threadId, "rolled-back", "Try again", true);
    const rolledBack = yield* reply("reply:rolled-back", 2, "A different answer.");
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:roll-back"),
          type: "run.updated",
          threadId,
          runId: rolledBack.id,
          occurredAt: now,
          payload: { ...rolledBack, status: "rolled_back", completedAt: now },
        },
      ],
    });

    const built = yield* exports.build(threadId);
    assert.deepEqual(built.source, {
      environmentId,
      threadId,
      title: "Fix the flaky test",
      environmentLabel: "Pair Cloud",
    });
    assert.deepEqual(
      built.messages.map(({ role, text }) => `${role}: ${text}`),
      [
        "user: inherited question",
        "user: Where were we?",
        "user: Why does it flake?",
        "assistant: A race in the setup.",
      ],
    );
    assert.equal(built.omittedMessageCount, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("records a move row after the newest kept run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const record = (threadId: ThreadId) =>
      dispatch({
        type: "thread.move.record",
        commandId: CommandId.make(`move:${threadId}`),
        threadId,
        to: {
          environmentId: EnvironmentId.make("environment:laptop"),
          threadId: ThreadId.make("thread:local"),
        },
        message: "Continued locally on Kim's MacBook Pro",
      });

    const empty = ThreadId.make("thread:no-runs");
    yield* createThread(empty);
    yield* record(empty);
    assert.deepEqual(yield* timeline(empty), ["move: Continued locally on Kim's MacBook Pro"]);

    const threadId = ThreadId.make("thread:moved");
    yield* createThread(threadId);
    yield* send(threadId, "completed");
    yield* send(threadId, "rolled-back", "rolled-back", true);
    const [completed, rolledBack] = (yield* orchestrator.getThreadProjection(threadId)).runs;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:completed"),
          type: "run.updated",
          threadId,
          runId: completed!.id,
          occurredAt: now,
          payload: { ...completed!, status: "completed", completedAt: now },
        },
        {
          id: EventId.make("event:rolled-back"),
          type: "run.updated",
          threadId,
          runId: rolledBack!.id,
          occurredAt: now,
          payload: { ...rolledBack!, status: "rolled_back", completedAt: now },
        },
      ],
    });
    yield* record(threadId);
    // A replay records nothing new.
    yield* record(threadId);

    const projection = yield* orchestrator.getThreadProjection(threadId);
    const moves = projection.turnItems.filter((item) => item.type === "move");
    assert.equal(moves.length, 1);
    assert.equal(moves[0]?.runId, completed!.id);
    assert.equal(Math.max(...projection.turnItems.map((item) => item.ordinal)), moves[0]?.ordinal);
  }).pipe(Effect.provide(layerTest)),
);
