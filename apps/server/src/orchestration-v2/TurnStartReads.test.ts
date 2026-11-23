import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  ContextHandoffId,
  ContextTransferId,
  NodeId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { latestNativeContextUsage } from "@t3tools/provider-core/server/handoffBudget";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { traceSqlRouting } from "../persistence/testkit/SqliteRouting.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerDatabase = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["sqlite"] as const)(
  "loads startup state without obsolete transcript payloads in %s",
  (storage) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:completion-reads");
      const runId = RunId.make("run:completion-reads");
      const messageId = MessageId.make("message:completion-reads");
      const instanceId = ProviderInstanceId.make("codex");
      const thread: OrchestrationV2AppThread = {
        id: threadId,
        projectId: ProjectId.make("project:completion-reads"),
        title: "Completion controls",
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "test" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const run: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 2,
        providerInstanceId: instanceId,
        modelSelection: thread.modelSelection,
        providerThreadId: null,
        userMessageId: messageId,
        rootNodeId: NodeId.make("startup:root"),
        activeAttemptId: null,
        status: "queued",
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const putThread = (value: OrchestrationV2AppThread) =>
        store.apply({
          id: EventId.make(`event:thread:${value.id}`),
          type: "thread.created",
          threadId: value.id,
          occurredAt: now,
          payload: value,
        });
      const putRun = (value: OrchestrationV2Run) =>
        store.apply({
          id: EventId.make(`event:run:${value.id}:${value.status}`),
          type: "run.updated",
          threadId,
          runId: value.id,
          occurredAt: now,
          payload: value,
        });
      yield* putThread(thread);
      yield* putRun(run);
      const scopeId = CheckpointScopeId.make("startup:shared-scope");
      yield* store.apply({
        id: EventId.make("startup:root-event"),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: run.rootNodeId!,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId: run.rootNodeId!,
          kind: "root_turn",
          status: "pending",
          countsForRun: true,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: scopeId,
          startedAt: null,
          completedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("startup:scope-event"),
        type: "checkpoint-scope.created",
        threadId,
        occurredAt: now,
        payload: {
          id: scopeId,
          threadId,
          runId: RunId.make("run:old"),
          nodeId: NodeId.make("startup:earlier-root"),
          parentScopeId: null,
          providerThreadId: null,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/repo/worktree",
          createdAt: now,
        },
      });
      const message = {
        id: messageId,
        threadId,
        runId,
        nodeId: null,
        role: "user" as const,
        text: "Continue",
        attachments: [],
        streaming: false,
        createdBy: "agent" as const,
        creationSource: "server" as const,
        createdAt: now,
        updatedAt: now,
        delegatedCompletion: { parentRunId: RunId.make("parent-run"), generation: 1, taskIds: [] },
      };
      yield* store.apply({
        id: EventId.make("event:input"),
        type: "message.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: message,
      });
      const oldRunId = RunId.make("run:old");
      yield* putRun({ ...run, id: oldRunId, ordinal: 1, status: "completed" });
      const item = {
        id: TurnItemId.make("item:history"),
        threadId,
        runId: oldRunId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed" as const,
        title: "old command",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "command_execution" as const,
        input: "echo history",
        output: "historical result",
      };
      yield* store.apply({
        id: EventId.make("item-event"),
        type: "turn-item.updated",
        threadId,
        runId: oldRunId,
        occurredAt: now,
        payload: item,
      });
      if (storage === "sqlite") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_messages
          (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
          VALUES ('obsolete-history', ${threadId}, NULL, NULL, 'assistant', 0,
            ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            type, status, ordinal, updated_at, payload_json)
          VALUES ('obsolete-tool', ${threadId}, ${oldRunId}, NULL, NULL, NULL,
            'tool_call', 'completed', 2, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
        assert.equal((yield* Effect.exit(store.getThreadProjection(threadId)))._tag, "Failure");
      }
      const selected = yield* store.getThreadRecords(threadId, ["runs", "messages"], {
        runIds: [runId],
        messageIds: [messageId],
      });
      assert.deepEqual(Object.keys(selected).sort(), ["messages", "runs", "thread"]);
      assert.deepEqual(
        selected.runs.map((r) => r.id),
        [runId],
      );
      assert.deepEqual(
        selected.messages.map((m) => m.id),
        [messageId],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["messages"], { messageIds: [] })).messages,
        [],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["command_execution"],
          turnItemRunId: oldRunId,
        })).turnItems,
        [item],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["command_execution"],
          turnItemRunId: runId,
        })).turnItems,
        [],
      );
      assert.equal(yield* store.getNextTurnItemOrdinal(threadId), storage === "sqlite" ? 3 : 2);
      assert.equal(yield* store.getMessageCount(threadId), storage === "sqlite" ? 2 : 1);
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["messages"], {
          messageRunIds: [runId],
        })).messages.map((message) => message.id),
        [messageId],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["messages"], { messageRunIds: [] })).messages,
        [],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["command_execution"],
          turnItemRunIds: [oldRunId],
        })).turnItems,
        [item],
      );
      assert.deepEqual(
        (yield* store.getThreadRecords(threadId, ["turnItems"], { turnItemRunIds: [] })).turnItems,
        [],
      );
      assert.deepEqual(yield* store.getThreadAttachmentIds(threadId), []);
      if (storage === "sqlite") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = json_object('text', ${"x".repeat(512_000)}, 'attachments', json_array(json_object('id', 'attachment:old'))) WHERE message_id = 'obsolete-history'`;
        assert.deepEqual(yield* store.getThreadAttachmentIds(threadId), ["attachment:old"]);
      }
      const page = yield* store.getTimelinePage(threadId, { view: "activity", limit: 1 });
      assert.deepEqual(
        page.items.map((row) => row.item),
        [item],
      );
      assert.equal(page.hasMore, storage === "sqlite");
      assert.equal(page.totalItems, storage === "sqlite" ? 2 : 1);
      assert.deepEqual(
        (yield* store.getTimelinePage(threadId, { view: "messages", limit: 1 })).items,
        [],
      );
      const context = yield* store.getTurnStartContext(threadId, runId);
      assert.equal(context.thread.id, threadId);
      assert.deepEqual(
        context.checkpointScopes.map((scope) => scope.id),
        [scopeId],
      );
      assert.equal(context.messages.find((m) => m.id === messageId)?.text, "Continue");
      assert.isTrue(context.hasConversation);
      assert.deepEqual(context.turnItems, []);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId), [item]);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, [oldRunId]), [item]);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, [runId]), []);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, []), []);
      const resultId = TurnItemId.make("interrupt-result");
      assert.isTrue(yield* store.hasUnpairedRunInterruptRequest(threadId, item.id, resultId));
      assert.isFalse(yield* store.hasUnpairedRunInterruptRequest(threadId, resultId, item.id));
      assert.isFalse(
        yield* store.hasUnpairedRunInterruptRequest(
          ThreadId.make("other-thread"),
          item.id,
          resultId,
        ),
      );
      yield* store.apply({
        id: EventId.make("interrupt-result-event"),
        type: "turn-item.updated",
        threadId,
        runId: oldRunId,
        occurredAt: now,
        payload: { ...item, id: resultId },
      });
      assert.isFalse(yield* store.hasUnpairedRunInterruptRequest(threadId, item.id, resultId));
      if (storage === "sqlite") {
        const sql = yield* SqlClient.SqlClient;
        const original = yield* sql<{ payload_json: string }>`SELECT payload_json
          FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${item.id}`;
        yield* sql`UPDATE orchestration_v2_projection_turn_items
          SET payload_json = 'invalid JSON' WHERE turn_item_id = ${item.id}`;
        assert.isTrue(
          yield* store.hasUnpairedRunInterruptRequest(
            threadId,
            item.id,
            TurnItemId.make("absent-result"),
          ),
        );
        yield* sql`UPDATE orchestration_v2_projection_turn_items
          SET payload_json = ${original[0]!.payload_json} WHERE turn_item_id = ${item.id}`;
      }
      for (const text of ["/compact", " \t/COMPACT\n", "\u00a0/compact\u3000"]) {
        yield* store.apply({
          id: EventId.make("compact-input"),
          type: "message.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: { ...message, text },
        });
        assert.isFalse((yield* store.getTurnStartContext(threadId, runId)).hasConversation);
      }
      const marker = {
        ...message,
        id: MessageId.make("old-compact"),
        runId: oldRunId,
        text: "\t/COMPACT\n",
      };
      yield* store.apply({
        id: EventId.make("old-compact-input"),
        type: "message.updated",
        threadId,
        runId: oldRunId,
        occurredAt: now,
        payload: marker,
      });
      assert.include(
        (yield* store.getTurnStartContext(threadId, runId)).messages.map((m) => m.id),
        marker.id,
      );
      const other = ThreadId.make("other");
      yield* putThread({ ...thread, id: other });
      assert.deepEqual((yield* store.getTurnStartContext(other, runId)).messages, []);
      assert.deepEqual(yield* store.getTurnStartHistory(other, [oldRunId]), []);
      assert.isFalse((yield* store.getTurnStartContext(other, runId)).hasConversation);
      assert.instanceOf(
        yield* store.getTurnStartContext(ThreadId.make("missing"), runId).pipe(Effect.flip),
        ProjectionStore.ProjectionStoreThreadNotFoundError,
      );
      const file = {
        type: "file" as const,
        id: "message-file",
        name: "notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 12,
      };
      yield* store.apply({
        id: EventId.make("attachment:message-event"),
        type: "message.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: { ...message, attachments: [file] },
      });
      yield* store.apply({
        id: EventId.make("attachment:question-event"),
        type: "turn-item.updated",
        threadId,
        runId: oldRunId,
        occurredAt: now,
        payload: {
          ...item,
          id: TurnItemId.make("attachment:question"),
          type: "user_input_request",
          requestId: RuntimeRequestId.make("attachment:request"),
          questions: [],
          questionAnswer: {
            requestId: "attachment:request",
            answers: { document: ["See document"], image: ["See image"] },
            attachmentsByQuestionId: {
              document: [{ ...file, id: "answer-document" }],
              image: [
                {
                  type: "image",
                  id: "answer-image",
                  name: "photo.png",
                  mimeType: "image/png",
                  sizeBytes: 8,
                },
              ],
            },
          },
        },
      });
      const recordingId = "thread-completion-reads-0b9f6c1e-3c1d-4f7a-9d2e-5a6b7c8d9e0f-webm";
      yield* store.apply({
        id: EventId.make("attachment:recording-event"),
        type: "turn-item.updated",
        threadId,
        runId: oldRunId,
        occurredAt: now,
        payload: {
          ...item,
          id: TurnItemId.make("attachment:recording"),
          type: "dynamic_tool",
          toolName: "mcp__t3-code__preview_recording_stop",
          input: {},
          output: [
            { type: "text", text: JSON.stringify({ id: recordingId, mimeType: "video/webm" }) },
          ],
        },
      });
      assert.deepEqual((yield* store.getThreadAttachmentIds(threadId)).toSorted(), [
        "answer-document",
        "answer-image",
        "attachment:old",
        "message-file",
        recordingId,
      ]);
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect(
  "counts a native fork's inherited history as conversation for its first /compact in sqlite",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const sourceId = ThreadId.make("thread:fork-source");
      const forkId = ThreadId.make("thread:fork-target");
      const sourceRunId = RunId.make("run:fork-source-third");
      const forkRunId = RunId.make("run:fork-compact");
      const source: OrchestrationV2AppThread = {
        id: sourceId,
        projectId: ProjectId.make("project:fork-compact"),
        title: "Source",
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "claude-opus-5-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: sourceId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const fork: OrchestrationV2AppThread = {
        ...source,
        id: forkId,
        title: "Fork",
        lineage: { parentThreadId: sourceId, relationshipToParent: "fork", rootThreadId: sourceId },
        forkedFrom: { type: "run", threadId: sourceId, runId: sourceRunId },
      };
      const run = (threadId: ThreadId, id: RunId, status: OrchestrationV2Run["status"]) =>
        ({
          id,
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection: source.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`message:${id}`),
          rootNodeId: NodeId.make(`node:${id}`),
          activeAttemptId: null,
          status,
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        }) satisfies OrchestrationV2Run;
      const userMessage = (threadId: ThreadId, runId: RunId, text: string) =>
        store.apply({
          id: EventId.make(`event:message:${runId}`),
          type: "message.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: MessageId.make(`message:${runId}`),
            threadId,
            runId,
            nodeId: null,
            role: "user",
            text,
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
          },
        });
      for (const thread of [source, fork]) {
        yield* store.apply({
          id: EventId.make(`event:thread:${thread.id}`),
          type: "thread.created",
          threadId: thread.id,
          occurredAt: now,
          payload: thread,
        });
      }
      for (const [threadId, value] of [
        [sourceId, run(sourceId, sourceRunId, "completed")],
        [forkId, run(forkId, forkRunId, "queued")],
      ] as const) {
        yield* store.apply({
          id: EventId.make(`event:run:${value.id}`),
          type: "run.updated",
          threadId,
          runId: value.id,
          occurredAt: now,
          payload: value,
        });
      }
      yield* userMessage(sourceId, sourceRunId, "THIRD");
      yield* store.apply({
        id: EventId.make("event:fork-transfer"),
        type: "context-transfer.created",
        threadId: forkId,
        occurredAt: now,
        payload: {
          id: ContextTransferId.make("transfer:fork-compact"),
          type: "fork",
          sourceThreadId: sourceId,
          targetThreadId: forkId,
          sourcePoint: { threadId: sourceId, runId: sourceRunId },
          basePoint: null,
          sourceProviderInstanceId: instanceId,
          targetProviderInstanceId: instanceId,
          targetRunId: forkRunId,
          status: "pending",
          resolution: {
            strategy: "native_fork",
            providerThreadRef: {
              driver: ProviderDriverKind.make("claudeAgent"),
              nativeId: "native-fork-source",
              strength: "strong",
            },
          },
          createdBy: "user",
          error: null,
          createdAt: now,
          updatedAt: now,
          consumedAt: null,
        },
      });
      yield* userMessage(forkId, forkRunId, "/compact");

      assert.isTrue((yield* store.getTurnStartContext(forkId, forkRunId)).hasConversation);
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect(
  "recent turn-start reads keep the newest runs and what turn start reads across history",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const start = DateTime.makeUnsafe("2026-11-01T00:00:00.000Z");
      const at = (minutes: number) => DateTime.add(start, { minutes });
      const threadId = ThreadId.make("thread:recent-turn-start");
      const providerThreadId = ProviderThreadId.make("provider-thread:recent-turn-start");
      const instanceId = ProviderInstanceId.make("codex");
      const driver = ProviderDriverKind.make("codex");
      const modelSelection = { instanceId, model: "test" };
      yield* store.apply({
        id: EventId.make("event:recent-turn-start:thread"),
        type: "thread.created",
        threadId,
        occurredAt: start,
        payload: {
          id: threadId,
          projectId: ProjectId.make("project:recent-turn-start"),
          title: "Long bot thread",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThreadId,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdBy: "user",
          creationSource: "web",
          createdAt: start,
          updatedAt: start,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const providerThread = {
        id: providerThreadId,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-1", strength: "strong" as const },
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 8,
        handoffIds: [],
        forkedFrom: null,
        createdAt: start,
        updatedAt: start,
      };
      yield* store.apply({
        id: EventId.make("event:recent-turn-start:provider-thread"),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId: instanceId,
        occurredAt: start,
        payload: providerThread,
      });
      // Run 8 is starting. Run 2 was interrupted, run 3's turn reported usage last, and a ready
      // handoff targets run 4; all three are older than the newest three runs.
      const putRun = Effect.fnUntraced(function* (
        ordinal: number,
        status: OrchestrationV2Run["status"],
        ended: number | null,
      ) {
        const runId = RunId.make(`run:recent-turn-start:${ordinal}`);
        const attemptId = RunAttemptId.make(`attempt:recent-turn-start:${ordinal}`);
        const nodeId = NodeId.make(`node:recent-turn-start:${ordinal}`);
        yield* store.apply({
          id: EventId.make(`event:recent-turn-start:run:${ordinal}:${status}`),
          type: "run.updated",
          threadId,
          runId,
          occurredAt: start,
          payload: {
            id: runId,
            threadId,
            ordinal,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:recent-turn-start:${ordinal}`),
            rootNodeId: nodeId,
            activeAttemptId: attemptId,
            status,
            requestedAt: at(ordinal * 10),
            startedAt: at(ordinal * 10),
            completedAt: ended === null ? null : at(ended),
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* store.apply({
          id: EventId.make(`event:recent-turn-start:attempt:${ordinal}`),
          type: "run-attempt.created",
          threadId,
          runId,
          nodeId,
          driver,
          occurredAt: start,
          payload: {
            id: attemptId,
            nativeThreadId: "native-1",
            runId,
            attemptOrdinal: 1,
            rootNodeId: nodeId,
            providerInstanceId: instanceId,
            providerThreadId,
            providerTurnId: ProviderTurnId.make(`turn:recent-turn-start:${ordinal}`),
            reason: "initial",
            status: ended === null ? "running" : "completed",
            startedAt: at(ordinal * 10),
            completedAt: ended === null ? null : at(ended),
          },
        });
        yield* store.apply({
          id: EventId.make(`event:recent-turn-start:turn:${ordinal}`),
          type: "provider-turn.updated",
          threadId,
          nodeId,
          driver,
          occurredAt: start,
          payload: {
            id: ProviderTurnId.make(`turn:recent-turn-start:${ordinal}`),
            providerThreadId,
            nodeId,
            runAttemptId: attemptId,
            nativeTurnRef: null,
            ordinal,
            status: ended === null ? "running" : "completed",
            startedAt: at(ordinal * 10),
            completedAt: ended === null ? null : at(ended),
            ...(ordinal === 3
              ? { tokenUsage: { usedTokens: 1200, updatedAt: DateTime.formatIso(at(34)) } }
              : {}),
          },
        });
      });
      for (const ordinal of [1, 3, 4, 5, 6, 7])
        yield* putRun(ordinal, "completed", ordinal * 10 + 5);
      yield* putRun(2, "interrupted", 25);
      yield* putRun(8, "starting", null);
      yield* store.apply({
        id: EventId.make("event:recent-turn-start:handoff"),
        type: "context-handoff.updated",
        threadId,
        runId: RunId.make("run:recent-turn-start:4"),
        occurredAt: start,
        payload: {
          id: ContextHandoffId.make("handoff:recent-turn-start"),
          threadId,
          targetRunId: RunId.make("run:recent-turn-start:4"),
          fromProviderThreadIds: [providerThreadId],
          toProviderThreadId: providerThreadId,
          coveredRunOrdinals: { from: 1, to: 3 },
          strategy: "delta_since_target_last_seen",
          status: "ready",
          summaryMessageId: null,
          summaryText: "",
          createdByProviderInstanceId: null,
          createdAt: start,
          updatedAt: start,
        },
      });

      const runId = RunId.make("run:recent-turn-start:8");
      const ordinals = (records: { readonly runs: ReadonlyArray<OrchestrationV2Run> }) =>
        records.runs.map((run) => run.ordinal);
      const full = yield* store.getTurnStartContext(threadId, runId);
      const { queries, trace } = traceSqlRouting();
      const recent = yield* trace(store.getTurnStartContext(threadId, runId, { recentRuns: 3 }));
      const plan = (marker: string) =>
        sql
          .unsafe<{ readonly detail: string }>(
            `EXPLAIN QUERY PLAN ${queries.find(({ query }) => query.includes(marker))!.query}`,
          )
          .pipe(Effect.map((rows) => rows.map((row) => row.detail).join("\n")));
      assert.include(
        yield* plan("'$.tokenUsage.updatedAt') DESC, turn.ordinal"),
        "provider_turns_usage_idx (provider_thread_id=?)",
      );
      assert.include(
        yield* plan("OR provider_turn_id IN"),
        "provider_turns_attempt_idx (run_attempt_id=?)",
      );
      assert.deepEqual(ordinals(recent), [2, 3, 4, 6, 7, 8]);
      assert.deepEqual(
        recent.providerTurns.map((turn) => turn.ordinal),
        [2, 3, 4, 6, 7, 8],
      );
      assert.deepEqual(
        latestNativeContextUsage(recent, providerThread),
        latestNativeContextUsage(full, providerThread),
      );
      assert.equal(latestNativeContextUsage(recent, providerThread)?.usage.usedTokens, 1200);

      // Run 5 ending after run 6 started could make it the latest, so nothing is left out.
      yield* putRun(5, "completed", 62);
      assert.deepEqual(
        ordinals(yield* store.getTurnStartContext(threadId, runId, { recentRuns: 3 })),
        ordinals(full),
      );
    }).pipe(Effect.provide(layerDatabase)),
);
