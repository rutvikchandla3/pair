import {
  AuthSessionId,
  MemberId,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentId,
  EventId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  OrchestrationV2AppThread,
  OrchestrationV2TurnItem,
  OrchestrationV2ThreadTranscript,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { threadTranscriptHeader } from "@t3tools/shared/threadTranscript";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Etag from "effect/http/Etag";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import * as OrchestrationHttp from "./http.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as TeamState from "../team/TeamState.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

class TranscriptTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}
const decodeTranscript = Schema.decodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2ThreadTranscript),
);

const now = DateTime.makeUnsafe("2026-09-29T00:00:00.000Z");
const environmentId = EnvironmentId.make("source-بيئة");
const output = "Full tool output. ".repeat(4_000);
const thread = Schema.decodeSync(OrchestrationV2AppThread)({
  id: "source-thread",
  projectId: "source-project",
  title: "Source 界\nconversation",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: "source-thread", parentThreadId: null, relationshipToParent: null },
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
});
const items = Schema.decodeUnknownSync(Schema.Array(OrchestrationV2TurnItem))(
  Array.from({ length: 200 }, (_, position) => ({
    id: `item-${position}`,
    threadId: "source-thread",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: position,
    type: "command_execution",
    status: "completed",
    title: "Read notes",
    input: "cat notes.md",
    output: position === 0 ? output : "Done",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  })),
);

// Serves the orchestration HTTP routes over real stores; `allowed` gates the read scope.
const serveOrchestrationHttp = (allowed: () => boolean, memberId = MemberId.make("member-owner")) =>
  Effect.gen(function* () {
    const runtime = ProviderReplayHarness.layerWithRegistry(
      { name: "thread-transcript" },
      ProviderAdapterRegistry.layerFromAdapters([]),
      { runEffectWorker: false },
    );
    const services = yield* Layer.build(
      Layer.mergeAll(
        runtime,
        ThreadManagementService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(runtime, CommandReceiptStore.layer, ServerSettings.layerTest({})),
          ),
        ),
        OrchestrationEventStore.layer,
        ProjectStore.layer,
        ProjectionStore.layer,
        TeamState.layerTest(),
      ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    );
    const eventSink = Context.get(services, EventSinkV2);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("create-source"),
          type: "thread.created",
          threadId: thread.id,
          occurredAt: now,
          payload: thread,
        },
      ],
    });
    const routes = HttpApiBuilder.layer(TranscriptTestApi).pipe(
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
      Layer.provide(
        Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
          Effect.suspend(() =>
            effect.pipe(
              Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                sessionId: AuthSessionId.make("test-session"),
                subject: "test",
                memberId,
                method: "bearer-access-token",
                scopes: new Set<AuthEnvironmentScope>(allowed() ? ["orchestration:read"] : []),
              }),
            ),
          ),
        ),
      ),
      Layer.provide(Layer.succeedContext(services)),
      Layer.provide(Layer.mock(ProjectEnrichmentService)({})),
      Layer.provide(HttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    return { services, eventSink, handler };
  });

it.effect("exports full history with size, scope, and missing-thread checks", () =>
  Effect.gen(function* () {
    let allowed = true;
    const { services, eventSink, handler } = yield* serveOrchestrationHttp(() => allowed);
    const read = (threadId: ThreadId) =>
      Effect.promise(() =>
        handler(
          new Request(`http://localhost/api/orchestration/threads/${threadId}/transcript`, {
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
          }),
        ),
      );

    const emptyResponse = yield* read(thread.id);
    expect(emptyResponse.status).toBe(200);
    expect(
      (yield* decodeTranscript(yield* Effect.promise(() => emptyResponse.json()))).items,
    ).toEqual([]);
    yield* eventSink.write({
      events: items.map((item) => ({
        id: EventId.make(`create-${item.id}`),
        type: "turn-item.updated" as const,
        threadId: thread.id,
        occurredAt: now,
        payload: item,
      })),
    });

    const response = yield* read(thread.id);
    expect(response.status).toBe(200);
    const transcript = yield* decodeTranscript(yield* Effect.promise(() => response.json()));
    expect(transcript.items).toHaveLength(200);
    expect(transcript.items[0]?.item).toMatchObject({ output });
    expect(transcript.items[0]?.visibility).toBe("local");
    expect(transcript.items[199]?.position).toBe(199);

    const emptyOutputRows = transcript.items.map((row, position) =>
      position === 0 ? { ...row, item: { ...row.item, output: "" } } : row,
    );
    const header = threadTranscriptHeader(environmentId, transcript);
    const baseSize =
      Buffer.byteLength(header, "utf8") +
      emptyOutputRows.reduce(
        (size, row) => size + Buffer.byteLength(`${JSON.stringify(row)}\n`, "utf8"),
        0,
      );
    const boundaryOutput = "界" + "x".repeat(PROVIDER_SEND_TURN_MAX_FILE_BYTES - baseSize - 3);
    for (const [suffix, expectedStatus] of [
      ["", 200],
      ["x", 400],
    ] as const) {
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`boundary-${expectedStatus}`),
            type: "turn-item.updated",
            threadId: thread.id,
            occurredAt: now,
            payload: {
              ...items.find((item) => item.type === "command_execution")!,
              output: boundaryOutput + suffix,
            },
          },
        ],
      });
      const response = yield* read(thread.id);
      expect(response.status).toBe(expectedStatus);
      if (expectedStatus === 400) {
        const error = yield* Context.get(services, ThreadManagementService.ThreadManagementService)
          .getThreadTranscript(thread.id)
          .pipe(
            Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(environmentId),
            }),
            Effect.flip,
          );
        expect(error).toBeInstanceOf(ThreadManagementService.ThreadTranscriptTooLargeError);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          _tag: "EnvironmentRequestInvalidError",
          reason: "thread_transcript_too_large",
        });
      }
    }

    expect((yield* read(ThreadId.make("missing"))).status).toBe(404);
    allowed = false;
    expect((yield* read(thread.id)).status).toBe(403);
  }),
);

it.effect("shows the session's member their own pins in the HTTP snapshots", () =>
  Effect.gen(function* () {
    const alice = MemberId.make("member-alice");
    const { eventSink, handler } = yield* serveOrchestrationHttp(() => true, alice);
    const ownersPin = DateTime.makeUnsafe("2026-09-29T01:00:00.000Z");
    const alicesPin = DateTime.makeUnsafe("2026-09-29T02:00:00.000Z");
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("owner-pins"),
          type: "thread.pinned",
          threadId: thread.id,
          occurredAt: ownersPin,
          payload: { ...thread, pinnedAt: ownersPin },
        },
      ],
    });
    const read = (path: string) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://localhost/api/orchestration/${path}`, {
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
          }),
        );
        return (await response.json()) as Record<string, unknown>;
      });
    const pins = Effect.gen(function* () {
      const shell = (yield* read("shell")) as {
        readonly threads: ReadonlyArray<{ readonly pinnedAt?: string | null }>;
      };
      const detail = (yield* read(`threads/${thread.id}`)) as {
        readonly projection: { readonly thread: { readonly pinnedAt?: string | null } };
      };
      return [shell.threads[0]?.pinnedAt ?? null, detail.projection.thread.pinnedAt ?? null];
    });
    expect(yield* pins).toEqual([null, null]);

    yield* eventSink.write({
      events: [
        {
          id: EventId.make("alice-pins"),
          type: "thread.pinned",
          threadId: thread.id,
          occurredAt: alicesPin,
          payload: { ...thread, pinnedAt: ownersPin },
          member: {
            memberId: alice,
            state: {
              pinnedAt: alicesPin,
              pinOrderKey: null,
              activeOrderKey: null,
              lastVisitedAt: null,
              snoozedUntil: null,
              snoozedAt: null,
              lastSnoozeWakeAt: null,
              opens: null,
              followedAt: null,
            },
          },
        },
      ],
    });
    expect(yield* pins).toEqual([DateTime.formatIso(alicesPin), DateTime.formatIso(alicesPin)]);
  }),
);

it.effect("leaves older settled threads out of the HTTP shell only when asked", () =>
  Effect.gen(function* () {
    const { eventSink, handler } = yield* serveOrchestrationHttp(() => true);
    yield* eventSink.write({
      events: Array.from({ length: 26 }, (_, index) => {
        const id = ThreadId.make(`settled-${index}`);
        return {
          id: EventId.make(`create-${id}`),
          type: "thread.created" as const,
          threadId: id,
          occurredAt: now,
          payload: {
            ...thread,
            id,
            lineage: { ...thread.lineage, rootThreadId: id },
            settledOverride: "settled" as const,
            settledAt: DateTime.makeUnsafe(Date.UTC(2026, 8, 1 + index)),
          },
        };
      }),
    });
    const shell = (query: string) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://localhost/api/orchestration/shell${query}`, {
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
          }),
        );
        return (await response.json()) as {
          readonly threads: ReadonlyArray<{ readonly id: string }>;
          readonly olderSettled?: { readonly counts: ReadonlyArray<unknown> };
        };
      });

    const full = yield* shell("");
    expect(full.threads).toHaveLength(27);
    expect(full.olderSettled).toBeUndefined();
    const cut = yield* shell("?omitOlderSettled=1");
    expect(cut.threads.map((row) => row.id).toSorted()).toEqual(
      [thread.id, ...Array.from({ length: 25 }, (_, index) => `settled-${index + 1}`)].toSorted(),
    );
    expect(cut.olderSettled?.counts).toEqual([{ projectId: thread.projectId, count: 1 }]);
  }),
);
