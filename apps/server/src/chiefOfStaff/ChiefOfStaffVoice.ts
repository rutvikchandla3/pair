import {
  type AuthEnvironmentScope,
  type AuthMcpClientAccess,
  type ChiefOfStaffCloseReason,
  ChiefOfStaffError,
  type ChiefOfStaffEvent,
  ChiefOfStaffSessionId,
  type ChiefOfStaffSessionInput,
  type ChiefOfStaffStartInput,
  type ChiefOfStaffStartResult,
  type ChiefOfStaffState,
  type ChiefOfStaffVoiceList,
  defaultInstanceIdForDriver,
  type MemberId,
  mcpClientScopes,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { buildCodexInitializeParams } from "../provider/CodexProvider.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ChiefOfStaffHost, type VoiceAppServer } from "./ChiefOfStaffHost.ts";
import {
  backingThreadParams,
  isForThread,
  mapNotification,
  realtimeFailure,
  realtimeStartParams,
} from "./chiefOfStaffProtocol.ts";

export interface ChiefOfStaffCaller {
  readonly memberId: MemberId;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}

export class ChiefOfStaffVoice extends Context.Service<
  ChiefOfStaffVoice,
  {
    readonly start: (
      caller: ChiefOfStaffCaller,
      input: ChiefOfStaffStartInput,
    ) => Effect.Effect<ChiefOfStaffStartResult, ChiefOfStaffError>;
    readonly stop: (
      caller: ChiefOfStaffCaller,
      input: ChiefOfStaffSessionInput,
    ) => Effect.Effect<void, ChiefOfStaffError>;
    readonly subscribe: (
      caller: ChiefOfStaffCaller,
      input: ChiefOfStaffSessionInput,
    ) => Stream.Stream<ChiefOfStaffEvent, ChiefOfStaffError>;
    readonly listVoices: Effect.Effect<ChiefOfStaffVoiceList, ChiefOfStaffError>;
  }
>()("t3/chiefOfStaff/ChiefOfStaffVoice") {}

const MCP_LABEL = "Chief of staff";
const STATUS_PUSH_DELAY = Duration.seconds(2);
const SDP_ANSWER_TIMEOUT = Duration.seconds(30);
const STOP_TIMEOUT = Duration.seconds(2);
/** Long enough for a WebSocket reconnect to resubscribe and keep the session. */
const DETACHED_GRACE = Duration.seconds(10);
const FIRST_SUBSCRIBER_TIMEOUT = Duration.seconds(15);

const NativeThread = Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) });
const decodeNativeThread = Schema.decodeUnknownEffect(NativeThread);
const VoicesResponse = Schema.Struct({
  voices: Schema.Struct({
    defaultV2: Schema.optional(Schema.String),
    v2: Schema.optional(Schema.Array(Schema.String)),
    v3: Schema.optional(Schema.Array(Schema.String)),
  }),
});
const decodeVoices = Schema.decodeUnknownEffect(VoicesResponse);

/** A caller lends the MCP credential only access it holds itself; anything wider reads only. */
export const effectiveToolAccess = (
  configured: AuthMcpClientAccess,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): AuthMcpClientAccess =>
  mcpClientScopes(configured).every((scope) => scopes.includes(scope)) ? configured : "read-only";

interface Session {
  readonly id: ChiefOfStaffSessionId;
  readonly memberId: MemberId;
  readonly state: Ref.Ref<ChiefOfStaffState>;
  readonly events: PubSub.PubSub<ChiefOfStaffEvent>;
  readonly close: (reason: ChiefOfStaffCloseReason, message?: string) => Effect.Effect<void>;
  /** Paid realtime time runs while nobody listens, so the last subscriber leaving ends the session. */
  readonly attach: Effect.Effect<void>;
  readonly detach: Effect.Effect<void>;
}

const appServerFailed = (message: string) => (error: { readonly message: string }) =>
  new ChiefOfStaffError({ reason: "app-server-failed", message: `${message}: ${error.message}` });

/** Why a session that closes before Codex answers the offer fails `start`. */
const closedBeforeConnected = (reason: ChiefOfStaffCloseReason, message: string | undefined) =>
  new ChiefOfStaffError({
    reason: reason === "failed" ? "app-server-failed" : "start-failed",
    message:
      message ??
      (reason === "ended"
        ? "Codex ended the voice session before it connected."
        : "The voice session was closed before it connected."),
  });

const initialize = (app: VoiceAppServer) =>
  app
    .request("initialize", {
      clientInfo: buildCodexInitializeParams().clientInfo,
      capabilities: { experimentalApi: true },
    })
    .pipe(
      Effect.andThen(app.notify("initialized")),
      Effect.mapError(appServerFailed("Codex did not start")),
    );

const make = Effect.gen(function* () {
  const host = yield* ChiefOfStaffHost;
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const random = yield* SecureRandom.SecureRandom;
  const sessions = yield* SynchronizedRef.make(new Map<MemberId, Session>());

  const readSettings = settings.getSettings.pipe(
    Effect.map((current) => current.chiefOfStaff),
    Effect.mapError(
      () => new ChiefOfStaffError({ reason: "start-failed", message: "Could not read settings." }),
    ),
  );
  const instanceIdOf = (configured: string) =>
    configured
      ? ProviderInstanceId.make(configured)
      : defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));

  const openThread = Effect.fn("ChiefOfStaffVoice.openThread")(function* (
    app: VoiceAppServer,
    key: string,
    params: ReturnType<typeof backingThreadParams>,
  ) {
    const stored = yield* host.loadThreadId(key);
    const resumed =
      stored === undefined
        ? undefined
        : yield* app
            .request("thread/resume", { threadId: stored, excludeTurns: true, ...params })
            .pipe(
              Effect.flatMap(decodeNativeThread),
              Effect.map(({ thread }) => thread.id),
              Effect.orElseSucceed(() => undefined),
            );
    if (resumed !== undefined) return resumed;
    const started = yield* app
      .request("thread/start", params)
      .pipe(
        Effect.flatMap(decodeNativeThread),
        Effect.mapError(appServerFailed("Codex could not open Chief of staff's thread")),
      );
    yield* host.saveThreadId(key, started.thread.id);
    return started.thread.id;
  });

  const start = Effect.fn("ChiefOfStaffVoice.start")(function* (
    caller: ChiefOfStaffCaller,
    input: ChiefOfStaffStartInput,
  ) {
    const config = yield* readSettings;
    if (!config.enabled) {
      return yield* new ChiefOfStaffError({
        reason: "disabled",
        message: "Chief of staff is turned off. Turn it on in Settings.",
      });
    }
    const previous = (yield* SynchronizedRef.get(sessions)).get(caller.memberId);
    if (previous !== undefined) yield* previous.close("replaced");

    const instanceId = instanceIdOf(config.providerInstanceId);
    const scope = yield* Scope.make();
    const id = ChiefOfStaffSessionId.make(yield* random.uuidV4());
    const state = yield* Ref.make<ChiefOfStaffState>("connecting");
    const events = yield* PubSub.unbounded<ChiefOfStaffEvent>();
    const closed = yield* Ref.make(false);
    const realtimeStarted = yield* Deferred.make<void>();
    const sdpAnswer = yield* Deferred.make<string, ChiefOfStaffError>();
    const subscribers = yield* Ref.make(0);
    const idleTimer = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);
    let app: VoiceAppServer | undefined;
    let nativeThreadId: string | undefined;

    const close: Session["close"] = Effect.fn("ChiefOfStaffVoice.close")(function* (
      reason,
      message,
    ) {
      if (yield* Ref.getAndSet(closed, true)) return;
      yield* Ref.set(state, "closed");
      yield* Deferred.fail(sdpAnswer, closedBeforeConnected(reason, message));
      yield* PubSub.publish(events, {
        _tag: "state",
        state: "closed",
        closeReason: reason,
        ...(message === undefined ? {} : { message }),
      });
      yield* SynchronizedRef.update(sessions, (current) => {
        if (current.get(caller.memberId)?.id !== id) return current;
        const next = new Map(current);
        next.delete(caller.memberId);
        return next;
      });
      if ((reason === "stopped" || reason === "replaced") && app && nativeThreadId) {
        yield* app
          .request("thread/realtime/stop", { threadId: nativeThreadId })
          .pipe(Effect.timeout(STOP_TIMEOUT), Effect.ignore);
      }
      yield* Scope.close(scope, Exit.void);
    }, Effect.uninterruptible);
    // A fiber of the session's own scope cannot wait for that scope to close.
    const closeFromSession = (reason: ChiefOfStaffCloseReason, message?: string) =>
      Effect.forkDetach(close(reason, message)).pipe(Effect.asVoid);

    const cancelIdle = Ref.getAndSet(idleTimer, undefined).pipe(
      Effect.flatMap((fiber) => (fiber === undefined ? Effect.void : Fiber.interrupt(fiber))),
    );
    const closeWhenIdle = Effect.fn("ChiefOfStaffVoice.closeWhenIdle")(function* (
      after: Duration.Duration,
    ) {
      yield* cancelIdle;
      if (yield* Ref.get(closed)) return;
      const timer = yield* Effect.forkIn(
        Effect.sleep(after).pipe(Effect.andThen(closeFromSession("stopped"))),
        scope,
      );
      yield* Ref.set(idleTimer, timer);
    });
    const attach = Ref.update(subscribers, (count) => count + 1).pipe(
      Effect.andThen(cancelIdle),
      Effect.uninterruptible,
    );
    const detach = Ref.updateAndGet(subscribers, (count) => count - 1).pipe(
      Effect.flatMap((count) => (count === 0 ? closeWhenIdle(DETACHED_GRACE) : Effect.void)),
      Effect.uninterruptible,
    );

    const publishMapped = Effect.fn("ChiefOfStaffVoice.publishMapped")(function* (
      method: string,
      params: unknown,
    ) {
      const current = yield* Ref.get(state);
      if (current === "closed") return;
      const mapped = mapNotification(current, method, params);
      yield* Ref.set(state, mapped.state);
      yield* PubSub.publishAll(events, mapped.events);
    });

    const onNotification = Effect.fn("ChiefOfStaffVoice.onNotification")(function* (notification: {
      readonly method: string;
      readonly params?: unknown;
    }) {
      if (nativeThreadId === undefined || !isForThread(notification.params, nativeThreadId)) return;
      const params = notification.params as Record<string, unknown> | undefined;
      switch (notification.method) {
        case "thread/realtime/sdp":
          yield* Deferred.succeed(sdpAnswer, String(params?.["sdp"] ?? ""));
          return;
        case "thread/realtime/error": {
          const failure = realtimeFailure(String(params?.["message"] ?? "unknown error"));
          if (!(yield* Deferred.fail(sdpAnswer, failure))) {
            yield* closeFromSession("failed", failure.message);
          }
          return;
        }
        case "thread/realtime/closed":
          yield* closeFromSession("ended");
          return;
        case "thread/realtime/started":
          yield* Deferred.succeed(realtimeStarted, undefined);
      }
      yield* publishMapped(notification.method, notification.params);
    });

    const pushStatus = Effect.fn("ChiefOfStaffVoice.pushStatus")(function* (
      opened: VoiceAppServer,
      threadId: string,
      initial: string,
    ) {
      const dirty = yield* Queue.sliding<void>(1);
      let last = initial;
      yield* Deferred.await(realtimeStarted);
      yield* Effect.forkScoped(
        Stream.runForEach(host.statusChanges, () => Queue.offer(dirty, undefined)),
      );
      return yield* Effect.forever(
        Effect.gen(function* () {
          yield* Queue.take(dirty);
          yield* Effect.sleep(STATUS_PUSH_DELAY);
          yield* Queue.clear(dirty);
          const text = yield* host.statusSnapshot(caller.memberId);
          if (text === last) return;
          last = text;
          yield* opened
            .request("thread/realtime/appendText", { threadId, role: "developer", text })
            .pipe(Effect.ignore);
        }),
      );
    });

    const open = Effect.gen(function* () {
      const credential = yield* Effect.acquireRelease(
        registry.issueClient({
          label: MCP_LABEL,
          access: effectiveToolAccess(config.toolAccess, caller.scopes),
          memberId: caller.memberId,
        }),
        (issued) => registry.revokeClient(issued.sessionId),
      );
      const opened = yield* host.openAppServer({
        instanceId,
        realtimeBaseUrl: config.realtimeBaseUrl,
      });
      app = opened;
      yield* initialize(opened);
      const threadId = yield* openThread(
        opened,
        `${caller.memberId}:${instanceId}`,
        backingThreadParams({
          cwd: yield* host.workspaceDir,
          model: config.model,
          mcpEndpoint: credential.endpoint,
          mcpAuthorizationHeader: credential.authorizationHeader,
        }),
      );
      nativeThreadId = threadId;
      yield* Effect.forkScoped(Stream.runForEach(opened.notifications, onNotification));
      yield* Effect.forkScoped(
        opened.exited.pipe(
          Effect.andThen(
            closeFromSession("failed", "Codex stopped while Chief of staff was talking."),
          ),
        ),
      );
      const status = yield* host.statusSnapshot(caller.memberId);
      yield* opened
        .request(
          "thread/realtime/start",
          realtimeStartParams({ threadId, sdpOffer: input.sdpOffer, voice: config.voice, status }),
        )
        .pipe(Effect.mapError((error) => realtimeFailure(error.message)));
      const answer = yield* Deferred.await(sdpAnswer).pipe(
        Effect.timeoutOrElse({
          duration: SDP_ANSWER_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new ChiefOfStaffError({
                reason: "start-failed",
                message: "Codex did not answer the voice connection in time.",
              }),
            ),
        }),
      );
      yield* Effect.forkScoped(pushStatus(opened, threadId, status));
      return answer;
    }).pipe(Effect.provideService(Scope.Scope, scope));

    const answer = yield* open.pipe(
      Effect.onError(() =>
        Ref.set(closed, true).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
      ),
    );
    const session: Session = {
      id,
      memberId: caller.memberId,
      state,
      events,
      close,
      attach,
      detach,
    };
    const replaced = yield* SynchronizedRef.modify(sessions, (current) => {
      const next = new Map(current);
      next.set(caller.memberId, session);
      return [current.get(caller.memberId), next] as const;
    });
    if (replaced !== undefined) yield* replaced.close("replaced");
    yield* closeWhenIdle(FIRST_SUBSCRIBER_TIMEOUT);
    return { sessionId: id, sdpAnswer: answer };
  });

  const sessionOf = (caller: ChiefOfStaffCaller, sessionId: ChiefOfStaffSessionId) =>
    SynchronizedRef.get(sessions).pipe(
      Effect.flatMap((current) => {
        const session = current.get(caller.memberId);
        return session?.id === sessionId
          ? Effect.succeed(session)
          : Effect.fail(
              new ChiefOfStaffError({
                reason: "session-not-found",
                message: "That Chief of staff conversation has already ended.",
              }),
            );
      }),
    );

  return ChiefOfStaffVoice.of({
    start,
    stop: Effect.fn("ChiefOfStaffVoice.stop")(function* (caller, input) {
      const session = yield* sessionOf(caller, input.sessionId).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (session !== undefined) yield* session.close("stopped");
    }),
    subscribe: (caller, input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const session = yield* sessionOf(caller, input.sessionId);
          const subscription = yield* PubSub.subscribe(session.events);
          const current: ChiefOfStaffEvent = {
            _tag: "state",
            state: yield* Ref.get(session.state),
          };
          yield* session.attach;
          return Stream.concat(Stream.make(current), Stream.fromSubscription(subscription)).pipe(
            Stream.ensuring(session.detach),
          );
        }),
      ).pipe(Stream.takeUntil((event) => event._tag === "state" && event.state === "closed")),
    listVoices: Effect.gen(function* () {
      const config = yield* readSettings;
      const app = yield* host.openAppServer({
        instanceId: instanceIdOf(config.providerInstanceId),
        realtimeBaseUrl: config.realtimeBaseUrl,
      });
      yield* initialize(app);
      const { voices } = yield* app
        .request("thread/realtime/listVoices", {})
        .pipe(
          Effect.flatMap(decodeVoices),
          Effect.mapError(appServerFailed("Codex could not list voices")),
        );
      const list = voices.v3 && voices.v3.length > 0 ? voices.v3 : (voices.v2 ?? []);
      return {
        voices: list,
        ...(voices.defaultV2 !== undefined && list.includes(voices.defaultV2)
          ? { defaultVoice: voices.defaultV2 }
          : {}),
      };
    }).pipe(Effect.scoped, Effect.withSpan("ChiefOfStaffVoice.listVoices")),
  });
});

export const layer = Layer.effect(ChiefOfStaffVoice, make);
