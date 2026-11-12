import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  type ChiefOfStaffError,
  type ChiefOfStaffEvent,
  MemberId,
  type ServerSettings as ServerSettingsShape,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ChiefOfStaffHost, VoiceAppServerError } from "./ChiefOfStaffHost.ts";
import * as ChiefOfStaffVoice from "./ChiefOfStaffVoice.ts";

const NATIVE_THREAD = "native-1";
const member = { memberId: MemberId.make("member-a"), scopes: [] };

interface FakeOptions {
  readonly storedThreadId?: string;
  readonly resumeFails?: boolean;
  /** How `thread/realtime/start` answers: an SDP, a request error, a realtime error or close, or Codex exiting. */
  readonly realtime?:
    | { readonly fail: string }
    | { readonly notifyError: string }
    | { readonly notifyClosed: true }
    | { readonly exit: true };
  readonly settings?: Partial<ServerSettingsShape["chiefOfStaff"]>;
}

type Notification = { readonly method: string; readonly params?: unknown };

/** One fake host and registry; every app-server it opens shares the request log and notification queue. */
const setup = (options: FakeOptions = {}) =>
  Effect.gen(function* () {
    const requests: Array<{ method: string; params: unknown }> = [];
    const saved: Array<[string, string]> = [];
    const issued: Array<McpSessionRegistry.McpClientCredentialRequest> = [];
    const revoked: Array<string> = [];
    const notifications = yield* Queue.unbounded<Notification>();
    const statusChanges = yield* Queue.unbounded<void>();
    const statusPulled = yield* Queue.unbounded<void>();
    const status = yield* Ref.make("status v1");
    const openApps = yield* Ref.make(0);
    const exited = yield* Deferred.make<void>();

    const notify = (method: string, params: Record<string, unknown> = {}) =>
      Queue.offer(notifications, { method, params: { threadId: NATIVE_THREAD, ...params } });

    const host = Layer.succeed(
      ChiefOfStaffHost,
      ChiefOfStaffHost.of({
        workspaceDir: Effect.succeed("/state/chief-of-staff/workspace"),
        openAppServer: () =>
          Effect.acquireRelease(
            Ref.update(openApps, (count) => count + 1),
            () => Ref.update(openApps, (count) => count - 1),
          ).pipe(
            Effect.as({
              request: (method: string, params?: unknown) =>
                Effect.gen(function* () {
                  requests.push({ method, params });
                  switch (method) {
                    case "thread/resume":
                      if (options.resumeFails) {
                        return yield* new VoiceAppServerError({ message: "no rollout found" });
                      }
                      return { thread: { id: NATIVE_THREAD } };
                    case "thread/start":
                      return { thread: { id: NATIVE_THREAD } };
                    case "thread/realtime/start": {
                      const realtime = options.realtime;
                      if (realtime && "fail" in realtime) {
                        return yield* new VoiceAppServerError({ message: realtime.fail });
                      }
                      if (realtime && "notifyError" in realtime) {
                        yield* notify("thread/realtime/error", { message: realtime.notifyError });
                        return {};
                      }
                      if (realtime && "notifyClosed" in realtime) {
                        yield* notify("thread/realtime/closed", { reason: "error" });
                        return {};
                      }
                      if (realtime && "exit" in realtime) {
                        yield* Deferred.succeed(exited, undefined);
                        return {};
                      }
                      yield* notify("thread/realtime/sdp", { sdp: "answer-sdp" });
                      yield* notify("thread/realtime/started");
                      return {};
                    }
                    case "thread/realtime/listVoices":
                      return {
                        voices: { defaultV2: "marin", v2: ["alloy"], v3: ["marin", "cedar"] },
                      };
                    default:
                      return {};
                  }
                }),
              notify: (method: string, params?: unknown) =>
                Effect.sync(() => void requests.push({ method, params })),
              notifications: Stream.fromQueue(notifications),
              exited: Deferred.await(exited),
            }),
          ),
        loadThreadId: () => Effect.succeed(options.storedThreadId),
        saveThreadId: (key, threadId) => Effect.sync(() => void saved.push([key, threadId])),
        statusSnapshot: () => Ref.get(status),
        statusChanges: Stream.fromQueue(statusChanges).pipe(
          Stream.tap(() => Queue.offer(statusPulled, undefined)),
        ),
      }),
    );
    const registry = Layer.succeed(
      McpSessionRegistry.McpSessionRegistry,
      McpSessionRegistry.McpSessionRegistry.of({
        endpoint: "http://127.0.0.1/mcp",
        issue: () => Effect.die("thread credentials are not used"),
        issueClient: (request) =>
          Effect.sync(() => {
            issued.push(request);
            const sessionId = `client-${issued.length}`;
            return {
              sessionId,
              endpoint: "http://127.0.0.1/mcp",
              authorizationHeader: `Bearer ${sessionId}`,
            };
          }),
        resolve: () => Effect.undefined,
        resolveClient: () => Effect.undefined,
        touch: () => Effect.void,
        revokeProviderSession: () => Effect.void,
        revokeThread: () => Effect.void,
        revokeClient: (sessionId) => Effect.sync(() => void revoked.push(sessionId)),
        revokeAll: Effect.void,
      }),
    );
    const voice = yield* Layer.build(
      ChiefOfStaffVoice.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            host,
            registry,
            ServerSettings.layerTest({
              chiefOfStaff: { enabled: true, voice: "marin", ...options.settings },
            }),
            NodeCrypto.layer,
          ),
        ),
      ),
    ).pipe(Effect.map((context) => Context.get(context, ChiefOfStaffVoice.ChiefOfStaffVoice)));
    return {
      voice,
      requests,
      saved,
      issued,
      revoked,
      notify,
      status,
      statusChanges,
      statusPulled,
      openApps,
    };
  });

/** Collects a session's events; returns once the subscription is live (its first event is the replayed state). */
const collect = (
  voice: ChiefOfStaffVoice.ChiefOfStaffVoice["Service"],
  sessionId: Parameters<ChiefOfStaffVoice.ChiefOfStaffVoice["Service"]["stop"]>[1]["sessionId"],
) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ChiefOfStaffEvent>();
    const fiber = yield* Effect.forkScoped(
      Stream.runForEach(voice.subscribe(member, { sessionId }), (event) =>
        Queue.offer(events, event),
      ),
    );
    return { first: yield* Queue.take(events), events, fiber };
  });

it.effect(
  "starts a WebRTC session on a backing thread wired to T3's MCP and ends it cleanly on stop",
  () =>
    Effect.gen(function* () {
      const fake = yield* setup();
      const result = yield* fake.voice.start(member, { sdpOffer: "offer-sdp" });
      assert.equal(result.sdpAnswer, "answer-sdp");

      assert.deepEqual(
        fake.requests.map((request) => request.method),
        ["initialize", "initialized", "thread/start", "thread/realtime/start"],
      );
      assert.deepInclude(fake.requests[0]?.params as object, {
        capabilities: { experimentalApi: true },
      });
      const thread = fake.requests[2]?.params as Record<string, unknown>;
      assert.equal(thread["approvalPolicy"], "never");
      assert.equal(thread["sandbox"], "read-only");
      assert.equal(thread["cwd"], "/state/chief-of-staff/workspace");
      assert.deepEqual((thread["config"] as Record<string, unknown>)["mcp_servers.t3-code"], {
        url: "http://127.0.0.1/mcp",
        http_headers: { Authorization: "Bearer client-1" },
        default_tools_approval_mode: "approve",
      });
      const realtime = fake.requests[3]?.params as Record<string, unknown>;
      assert.deepInclude(realtime, {
        threadId: NATIVE_THREAD,
        outputModality: "audio",
        version: "v3",
        transport: { type: "webrtc", sdp: "offer-sdp" },
        voice: "marin",
      });
      const initial = realtime["initialItems"] as ReadonlyArray<{ role: string; text: string }>;
      assert.equal(initial[0]?.role, "developer");
      assert.include(initial[0]?.text ?? "", "status v1");
      assert.deepEqual(fake.issued, [
        { label: "Chief of staff", access: "read-only", memberId: member.memberId },
      ]);
      assert.deepEqual(fake.saved, [[`${member.memberId}:codex`, NATIVE_THREAD]]);

      const { first, events } = yield* collect(fake.voice, result.sessionId);
      assert.deepEqual(first, { _tag: "state", state: "listening" });
      yield* fake.voice.stop(member, { sessionId: result.sessionId });
      assert.deepEqual(yield* Queue.take(events), {
        _tag: "state",
        state: "closed",
        closeReason: "stopped",
      });
      assert.equal(fake.requests.at(-1)?.method, "thread/realtime/stop");
      assert.deepEqual(fake.revoked, ["client-1"]);
      assert.equal(yield* Ref.get(fake.openApps), 0);
      const after = yield* Effect.exit(
        Stream.runCollect(fake.voice.subscribe(member, { sessionId: result.sessionId })),
      );
      assert.isTrue(Exit.isFailure(after));
    }).pipe(Effect.scoped),
);

it.effect.each([
  { name: "resumes the stored backing thread", resumeFails: false, saved: 0 },
  { name: "starts a new backing thread when the stored one is gone", resumeFails: true, saved: 1 },
])("$name", ({ resumeFails, saved }) =>
  Effect.gen(function* () {
    const fake = yield* setup({ storedThreadId: "old-thread", resumeFails });
    yield* fake.voice.start(member, { sdpOffer: "offer-sdp" });
    const methods = fake.requests.map((request) => request.method);
    assert.include(methods, "thread/resume");
    assert.equal(methods.includes("thread/start"), resumeFails);
    assert.deepInclude(fake.requests.find((r) => r.method === "thread/resume")?.params as object, {
      threadId: "old-thread",
      excludeTurns: true,
    });
    assert.lengthOf(fake.saved, saved);
  }).pipe(Effect.scoped),
);

it.effect("maps the realtime notifications into state, transcript and working events", () =>
  Effect.gen(function* () {
    const fake = yield* setup();
    const { sessionId } = yield* fake.voice.start(member, { sdpOffer: "offer-sdp" });
    const { events } = yield* collect(fake.voice, sessionId);
    yield* fake.notify("thread/realtime/transcript/delta", { role: "user", delta: "what's" });
    yield* fake.notify("thread/realtime/itemAdded", { item: { type: "handoff_request" } });
    yield* fake.notify("turn/started");
    yield* fake.notify("item/started", {
      item: { type: "mcpToolCall", id: "call-1", tool: "t3_thread_list", status: "inProgress" },
    });
    yield* fake.notify("item/completed", {
      item: { type: "mcpToolCall", id: "call-1", tool: "t3_thread_list", status: "completed" },
    });
    yield* fake.notify("thread/realtime/transcript/delta", { role: "assistant", delta: "Two" });
    yield* fake.notify("thread/realtime/transcript/done", { role: "assistant", text: "Two run." });
    yield* fake.notify("thread/realtime/transcript/delta", {
      threadId: "someone-else",
      role: "assistant",
      delta: "ignored",
    });
    yield* fake.notify("thread/realtime/closed", { reason: "expired" });
    const seen = yield* Stream.runCollect(
      Stream.fromQueue(events).pipe(
        Stream.takeUntil((event) => event._tag === "state" && event.state === "closed"),
      ),
    );
    assert.deepEqual(seen, [
      { _tag: "transcript", role: "user", text: "what's", final: false },
      { _tag: "state", state: "thinking" },
      {
        _tag: "working",
        id: "call-1",
        tool: "t3_thread_list",
        label: "Checking your threads",
        status: "started",
      },
      {
        _tag: "working",
        id: "call-1",
        tool: "t3_thread_list",
        label: "Checking your threads",
        status: "completed",
      },
      { _tag: "state", state: "speaking" },
      { _tag: "transcript", role: "assistant", text: "Two", final: false },
      { _tag: "state", state: "listening" },
      { _tag: "transcript", role: "assistant", text: "Two run.", final: true },
      { _tag: "state", state: "closed", closeReason: "ended" },
    ]);
    assert.notInclude(
      fake.requests.map((request) => request.method),
      "thread/realtime/stop",
    );
    assert.deepEqual(fake.revoked, ["client-1"]);
    assert.equal(yield* Ref.get(fake.openApps), 0);
  }).pipe(Effect.scoped),
);

it.effect("pushes changed thread status once per burst after the delay", () =>
  Effect.gen(function* () {
    const fake = yield* setup();
    yield* fake.voice.start(member, { sdpOffer: "offer-sdp" });
    const appended = () =>
      fake.requests.filter((request) => request.method === "thread/realtime/appendText");

    yield* Ref.set(fake.status, "status v2");
    yield* Queue.offer(fake.statusChanges, undefined);
    yield* Queue.offer(fake.statusChanges, undefined);
    yield* Queue.take(fake.statusPulled);
    yield* Queue.take(fake.statusPulled);
    yield* TestClock.adjust("1 second");
    assert.lengthOf(appended(), 0);
    yield* TestClock.adjust("1 second");
    assert.deepEqual(
      appended().map((request) => request.params),
      [{ threadId: NATIVE_THREAD, role: "developer", text: "status v2" }],
    );

    // A change that leaves the text as it was sends nothing.
    yield* Queue.offer(fake.statusChanges, undefined);
    yield* Queue.take(fake.statusPulled);
    yield* TestClock.adjust("2 seconds");
    assert.lengthOf(appended(), 1);
  }).pipe(Effect.scoped),
);

it.effect("a second start for the same member replaces the first", () =>
  Effect.gen(function* () {
    const fake = yield* setup();
    const first = yield* fake.voice.start(member, { sdpOffer: "offer-sdp" });
    const { events } = yield* collect(fake.voice, first.sessionId);
    const second = yield* fake.voice.start(member, { sdpOffer: "offer-sdp" });
    assert.notEqual(second.sessionId, first.sessionId);
    assert.deepEqual(yield* Queue.take(events), {
      _tag: "state",
      state: "closed",
      closeReason: "replaced",
    });
    assert.deepEqual(fake.revoked, ["client-1"]);
    assert.equal(yield* Ref.get(fake.openApps), 1);
    const { first: current } = yield* collect(fake.voice, second.sessionId);
    assert.deepEqual(current, { _tag: "state", state: "listening" });
  }).pipe(Effect.scoped),
);

it.effect("ends a session nobody listens to, but survives a quick resubscribe", () =>
  Effect.gen(function* () {
    const fake = yield* setup();
    const stopRequests = () =>
      fake.requests.filter((request) => request.method === "thread/realtime/stop").length;

    yield* fake.voice.start(member, { sdpOffer: "offer-sdp" });
    yield* TestClock.adjust("14 seconds");
    assert.lengthOf(fake.revoked, 0);
    yield* TestClock.adjust("1 second");
    assert.deepEqual(fake.revoked, ["client-1"]);
    assert.equal(stopRequests(), 1);
    assert.equal(yield* Ref.get(fake.openApps), 0);

    const { sessionId } = yield* fake.voice.start(member, { sdpOffer: "offer-sdp" });
    const first = yield* collect(fake.voice, sessionId);
    yield* TestClock.adjust("20 seconds");
    yield* Fiber.interrupt(first.fiber);
    yield* TestClock.adjust("9 seconds");
    const second = yield* collect(fake.voice, sessionId);
    yield* TestClock.adjust("20 seconds");
    assert.lengthOf(fake.revoked, 1);
    yield* Fiber.interrupt(second.fiber);
    yield* TestClock.adjust("10 seconds");
    assert.deepEqual(fake.revoked, ["client-1", "client-2"]);
    assert.equal(stopRequests(), 2);
    assert.equal(yield* Ref.get(fake.openApps), 0);
  }).pipe(Effect.scoped),
);

it.effect.each([
  {
    name: "a ChatGPT sign-in refused as needing an API key",
    realtime: { fail: "realtime conversation requires API key auth" },
    reason: "requires-api-key",
  },
  {
    name: "a proxy base URL without the realtime endpoint",
    realtime: { notifyError: "unexpected status 404 Not Found: https://proxy.local/v1/live" },
    reason: "realtime-endpoint-not-found",
  },
  // These two fail at once; waiting out the answer timeout would hang under the TestClock.
  {
    name: "Codex exiting before it answers",
    realtime: { exit: true },
    reason: "app-server-failed",
  },
  {
    name: "the provider closing the session before it answers",
    realtime: { notifyClosed: true },
    reason: "start-failed",
  },
] as const)("explains $name and cleans up", ({ realtime, reason }) =>
  Effect.gen(function* () {
    const fake = yield* setup({ realtime });
    const exit = yield* Effect.exit(fake.voice.start(member, { sdpOffer: "offer-sdp" }));
    if (!Exit.isFailure(exit)) return yield* Effect.die("Expected a refusal");
    const error = exit.cause.reasons[0];
    assert.equal(
      error?._tag === "Fail" ? (error.error as ChiefOfStaffError).reason : undefined,
      reason,
    );
    assert.deepEqual(fake.revoked, ["client-1"]);
    assert.equal(yield* Ref.get(fake.openApps), 0);
  }).pipe(Effect.scoped),
);

it.effect("refuses to start while turned off", () =>
  Effect.gen(function* () {
    const fake = yield* setup({ settings: { enabled: false } });
    const error = yield* Effect.flip(fake.voice.start(member, { sdpOffer: "offer-sdp" }));
    assert.equal(error.reason, "disabled");
    assert.lengthOf(fake.issued, 0);
  }).pipe(Effect.scoped),
);

it.effect("lists v3 voices with the default only when it is offered", () =>
  Effect.gen(function* () {
    const fake = yield* setup();
    assert.deepEqual(yield* fake.voice.listVoices, {
      voices: ["marin", "cedar"],
      defaultVoice: "marin",
    });
    assert.equal(yield* Ref.get(fake.openApps), 0);
  }).pipe(Effect.scoped),
);

it("lends the MCP credential only access the caller holds", () => {
  assert.equal(ChiefOfStaffVoice.effectiveToolAccess("read-only", []), "read-only");
  assert.equal(ChiefOfStaffVoice.effectiveToolAccess("auto", []), "read-only");
  assert.equal(
    ChiefOfStaffVoice.effectiveToolAccess("auto", ["orchestration:read", "orchestration:operate"]),
    "auto",
  );
});
