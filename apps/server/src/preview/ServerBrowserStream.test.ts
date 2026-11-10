import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSessionId,
  MemberId,
  PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE,
  PreviewStreamHostSetup,
  SandboxId,
  ThreadId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { MachineBrowserError } from "../sandbox/browser/MachineBrowser.ts";
import * as PreviewBrowserHost from "./PreviewBrowserHost.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import * as ThreadAccess from "../team/ThreadAccess.ts";
import { routeLayer } from "./ServerBrowserStream.ts";

const platformLayer = NodeHttpPlatform.layer.pipe(Layer.provideMerge(NodeServices.layer));

const makeAuth = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  error?: EnvironmentAuth.ServerAuthCredentialError,
  live: {
    readonly sessionEnd?: Effect.Effect<void>;
    readonly access?: ThreadAccess.ThreadAccess["Service"];
  } = {},
) => {
  const requests: string[] = [];
  const layer = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
    authenticateWebSocketUpgrade: (request) => {
      requests.push(request.url);
      return error
        ? Effect.fail(error)
        : Effect.succeed({
            sessionId: AuthSessionId.make("stream-test"),
            subject: "stream-test",
            memberId: MemberId.make("member-test"),
            method: "bearer-access-token",
            scopes,
            storedScopes: scopes,
          });
    },
  });
  const sessions = Layer.mock(SessionStore.SessionStore)({
    cookieName: "t3_session",
    legacyCookieName: undefined,
    awaitInvalidation: () => live.sessionEnd ?? Effect.never,
  });
  // Thread access is the route's to ask, not these tests' to deny.
  const access = Layer.succeed(ThreadAccess.ThreadAccess)(live.access ?? ThreadAccess.makeTest());
  return { layer: Layer.mergeAll(layer, sessions, access), requests };
};

const mutations = [
  { type: "resize", width: 390, height: 844 },
  { type: "mouse", action: "down", x: 10, y: 10, button: "left", buttons: 1 },
  { type: "key", action: "down", key: "Enter" },
  { type: "text", text: "reader must not type" },
  { type: "wheel", deltaY: 100 },
  { type: "navigate", url: "https://example.com" },
  { type: "history", delta: -1 },
  { type: "reload" },
  { type: "probe", x: 10, y: 10 },
  { type: "takeControl" },
  { type: "releaseControl" },
  { type: "dialog", accept: true },
  { type: "viewport", setting: { _tag: "fill" } },
];

it.effect.each([
  { hasOperateScope: false, interactive: true },
  { hasOperateScope: true, interactive: true },
  { hasOperateScope: true, interactive: false },
])("streams frames and acks while gating page mutations (%s)", ({ hasOperateScope, interactive }) =>
  Effect.gen(function* () {
    const canOperate = hasOperateScope && interactive;
    const scopes = hasOperateScope
      ? [AuthOrchestrationReadScope, AuthPreviewOperateScope]
      : [AuthOrchestrationReadScope];
    const auth = makeAuth(scopes);
    const inputs: unknown[] = [];
    const attachments: Parameters<ServerBrowser.ServerBrowser["Service"]["attachViewer"]>[0][] = [];
    const acked = Promise.withResolvers<void>();
    const frame = new Uint8Array([255, 216, 255, 217]);
    const output = yield* Queue.make<ServerBrowser.ServerBrowserViewerOutput>();
    yield* Queue.offer(output, { _tag: "viewport", width: 1280, height: 800 });
    yield* Queue.offer(output, {
      _tag: "frame",
      data: frame,
      ack: Effect.sync(() => acked.resolve()),
    });
    const browser = ServerBrowser.ServerBrowser.of({
      clearProfile: () => Effect.void,
      profileReporter: Effect.succeed(() => Effect.void),
      openDownload: () => Effect.succeedNone,
      answerFileChooser: () => Effect.succeed(false),
      attachViewer: (input) =>
        Effect.sync(() => {
          attachments.push(input);
          return {
            output,
            input: (message) => Effect.sync(() => void inputs.push(message)),
          };
        }),
    });
    const services = yield* Layer.build(
      HttpRouter.serve(
        routeLayer.pipe(
          Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
          Layer.provide(platformLayer),
        ),
        { disableListenLog: true },
      ).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provide(auth.layer)),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");
    const resource = `/api/preview-stream/ws?threadId=thread&tabId=tab&wsTicket=one-use-ticket${interactive ? "" : "&interactive=false"}`;
    const received = Promise.withResolvers<void>();
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => new WebSocket(`${origin}${resource}`)),
      (socket) => Effect.sync(() => socket.close()),
    );
    socket.binaryType = "arraybuffer";
    const viewports: unknown[] = [];
    const frames: Uint8Array[] = [];
    socket.addEventListener("error", () => received.reject(new Error("stream failed")));
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        viewports.push(JSON.parse(event.data));
        return;
      }
      frames.push(new Uint8Array(event.data as ArrayBuffer));
      for (const message of mutations) socket.send(JSON.stringify(message));
      socket.send("malformed input");
      socket.send(JSON.stringify({ type: "ack" }));
      received.resolve();
    });
    yield* Effect.promise(() => received.promise);
    // The socket ack follows every mutation, providing a barrier without sleeps.
    yield* Effect.promise(() => acked.promise);
    expect(frames).toEqual([frame]);
    expect(viewports).toEqual([{ type: "viewport", width: 1280, height: 800 }]);
    expect(inputs).toEqual(canOperate ? [...mutations, null] : []);
    expect(attachments).toEqual([
      {
        threadId: "thread",
        tabId: "tab",
        maxWidth: 1280,
        maxHeight: 800,
        quality: 70,
        canOperate,
      },
    ]);
    expect(auth.requests).toEqual([resource]);
  }).pipe(Effect.scoped),
);

it.effect("sends replies ahead of stale frames and only the newest frame after an ack", () =>
  Effect.gen(function* () {
    const output = yield* Queue.make<ServerBrowser.ServerBrowserViewerOutput>();
    const released: number[] = [];
    const frame = (id: number): ServerBrowser.ServerBrowserViewerOutput => ({
      _tag: "frame",
      data: new Uint8Array([id]),
      ack: Effect.sync(() => void released.push(id)),
    });
    const browser = ServerBrowser.ServerBrowser.of({
      clearProfile: () => Effect.void,
      profileReporter: Effect.succeed(() => Effect.void),
      openDownload: () => Effect.succeedNone,
      answerFileChooser: () => Effect.succeed(false),
      attachViewer: () => Effect.succeed({ output, input: () => Effect.void }),
    });
    const services = yield* Layer.build(
      HttpRouter.serve(
        routeLayer.pipe(
          Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
          Layer.provide(platformLayer),
        ),
        { disableListenLog: true },
      ).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(makeAuth([AuthOrchestrationReadScope]).layer),
      ),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");
    const received: Array<number | string> = [];
    let next = Promise.withResolvers<void>();
    const socket = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new WebSocket(
            `${origin}/api/preview-stream/ws?threadId=thread&tabId=tab&wsTicket=one-use-ticket`,
          ),
      ),
      (socket) => Effect.sync(() => socket.close()),
    );
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      received.push(
        typeof event.data === "string"
          ? JSON.parse(event.data).type
          : new Uint8Array(event.data as ArrayBuffer)[0]!,
      );
      next.resolve();
    });

    yield* Queue.offer(output, frame(1));
    yield* Effect.promise(() => next.promise);
    next = Promise.withResolvers();
    yield* Queue.offerAll(output, [
      frame(2),
      frame(3),
      frame(4),
      { _tag: "probe", x: 0, y: 0, editable: false },
    ]);
    yield* Effect.promise(() => next.promise);
    expect(received).toEqual([1, "probe"]);
    expect(released).toEqual([2, 3]);

    next = Promise.withResolvers();
    socket.send(JSON.stringify({ type: "ack" }));
    yield* Effect.promise(() => next.promise);
    expect(received).toEqual([1, "probe", 4]);
    expect(released).toEqual([2, 3, 1]);
  }).pipe(Effect.scoped),
);

it.effect.each([
  { scopes: [], error: undefined, status: 403 },
  { scopes: [AuthOrchestrationOperateScope], error: undefined, status: 403 },
  { scopes: [], error: new EnvironmentAuth.ServerAuthMissingCredentialError({}), status: 401 },
])("rejects unauthorized stream connections before attaching a viewer (%s)", (testCase) =>
  Effect.gen(function* () {
    const auth = makeAuth(testCase.scopes, testCase.error);
    let attachments = 0;
    const browser = ServerBrowser.ServerBrowser.of({
      clearProfile: () => Effect.void,
      profileReporter: Effect.succeed(() => Effect.void),
      openDownload: () => Effect.succeedNone,
      answerFileChooser: () => Effect.succeed(false),
      attachViewer: () => {
        attachments++;
        return Effect.die("unauthorized viewer must not attach");
      },
    });
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          routeLayer.pipe(
            Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
            Layer.provide(platformLayer),
            Layer.provideMerge(auth.layer),
          ),
          { disableLogger: true },
        ),
      ),
      ({ dispose }) => Effect.promise(dispose),
    );
    const response = yield* Effect.promise(() =>
      handler.handler(
        new Request("http://t3.test/api/preview-stream/ws?threadId=thread&tabId=tab", {
          headers: { upgrade: "websocket" },
        }),
      ),
    );
    expect(response.status).toBe(testCase.status);
    expect(attachments).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("serves a tab's download only to an authorized session", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `${yield* fs.makeTempDirectoryScoped({ prefix: "t3-download-" })}/file`;
    yield* fs.writeFileString(path, "report contents");
    const requests: Array<unknown> = [];
    const browser = ServerBrowser.ServerBrowser.of({
      clearProfile: () => Effect.void,
      profileReporter: Effect.succeed(() => Effect.void),
      openDownload: (input) =>
        Effect.sync(() => {
          requests.push(input);
          return input.downloadId === "download-1"
            ? Option.some({ path, fileName: "Q3 report.csv" })
            : Option.none();
        }),
      answerFileChooser: () => Effect.succeed(false),
      attachViewer: () => Effect.die("unused"),
    });
    const serve = (scopes: ReadonlyArray<AuthEnvironmentScope>, url: string) =>
      Effect.gen(function* () {
        const handler = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              routeLayer.pipe(
                Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
                Layer.provide(platformLayer),
                Layer.provideMerge(makeAuth(scopes, undefined).layer),
              ),
              { disableLogger: true },
            ),
          ),
          ({ dispose }) => Effect.promise(dispose),
        );
        return yield* Effect.promise(() => handler.handler(new Request(url)));
      });
    const base = "http://t3.test/api/preview-stream/download?threadId=thread&tabId=tab";
    const denied = yield* serve([], `${base}&id=download-1`);
    expect(denied.status).toBe(403);
    expect(requests).toEqual([]);
    const response = yield* serve([AuthOrchestrationReadScope], `${base}&id=download-1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="Q3 report.csv"',
    );
    expect(yield* Effect.promise(() => response.text())).toBe("report contents");
    const missing = yield* serve([AuthOrchestrationReadScope], `${base}&id=other`);
    expect(missing.status).toBe(404);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("passes uploaded files to the page's open picker and needs operate scope", () =>
  Effect.gen(function* () {
    const answers: Array<{ chooserId: string; files: Array<{ name: string; text: string }> }> = [];
    const browser = ServerBrowser.ServerBrowser.of({
      clearProfile: () => Effect.void,
      profileReporter: Effect.succeed(() => Effect.void),
      openDownload: () => Effect.succeedNone,
      answerFileChooser: (input) =>
        Effect.sync(() => {
          answers.push({
            chooserId: input.chooserId,
            files: input.files.map((file) => ({ name: file.name, text: file.buffer.toString() })),
          });
          return input.chooserId === "chooser-1";
        }),
      attachViewer: () => Effect.die("unused"),
    });
    const upload = (scopes: ReadonlyArray<AuthEnvironmentScope>, chooser: string) =>
      Effect.gen(function* () {
        const handler = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              routeLayer.pipe(
                Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
                Layer.provide(platformLayer),
                Layer.provideMerge(makeAuth(scopes, undefined).layer),
              ),
              { disableLogger: true },
            ),
          ),
          ({ dispose }) => Effect.promise(dispose),
        );
        const body = new FormData();
        body.append("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
        return yield* Effect.promise(() =>
          handler.handler(
            new Request(
              `http://t3.test/api/preview-stream/upload?threadId=thread&tabId=tab&chooser=${chooser}`,
              { method: "POST", body },
            ),
          ),
        );
      });
    expect((yield* upload([AuthOrchestrationReadScope], "chooser-1")).status).toBe(403);
    expect(answers).toEqual([]);
    expect((yield* upload([AuthOrchestrationOperateScope], "chooser-1")).status).toBe(403);
    expect((yield* upload([AuthPreviewOperateScope], "chooser-1")).status).toBe(204);
    expect(answers).toEqual([
      { chooserId: "chooser-1", files: [{ name: "notes.txt", text: "hello" }] },
    ]);
    expect((yield* upload([AuthPreviewOperateScope], "stale")).status).toBe(409);
  }).pipe(Effect.scoped),
);

const decodeHostSetup = Schema.decodeUnknownEffect(Schema.fromJsonString(PreviewStreamHostSetup));

it.effect.each([
  {
    error: new PreviewBrowserHost.PreviewBrowserSandboxError({
      setupCommand: "sudo t3 browser setup",
    }),
    need: "sandbox",
  },
  {
    error: new PreviewBrowserHost.PreviewBrowserLibrariesError({
      setupCommand: "sudo t3 browser setup",
      libraries: ["libnss3.so"],
    }),
    need: "libraries",
  },
])("tells viewers the command that sets up the host ($need)", ({ error, need }) =>
  Effect.gen(function* () {
    const browser = ServerBrowser.ServerBrowser.of({
      clearProfile: () => Effect.void,
      profileReporter: Effect.succeed(() => Effect.void),
      openDownload: () => Effect.succeedNone,
      answerFileChooser: () => Effect.succeed(false),
      attachViewer: () => Effect.fail(new ServerBrowser.ServerBrowserLaunchError({ cause: error })),
    });
    const services = yield* Layer.build(
      HttpRouter.serve(
        routeLayer.pipe(
          Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
          Layer.provide(platformLayer),
        ),
        { disableListenLog: true },
      ).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(makeAuth([AuthOrchestrationReadScope]).layer),
      ),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");
    const closed = Promise.withResolvers<{ code: number; reason: string }>();
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const socket = new WebSocket(
          `${origin}/api/preview-stream/ws?threadId=thread&tabId=tab&wsTicket=one-use-ticket`,
        );
        socket.addEventListener("close", (event) =>
          closed.resolve({ code: event.code, reason: event.reason }),
        );
        return socket;
      }),
      (socket) => Effect.sync(() => socket.close()),
    );
    const { code, reason } = yield* Effect.promise(() => closed.promise);
    expect(code).toBe(PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE);
    expect(yield* decodeHostSetup(reason)).toEqual({
      need,
      command: "sudo t3 browser setup",
    });
  }).pipe(Effect.scoped),
);

it.effect.each([{ ends: "session" }, { ends: "access" }] as const)(
  "closes a live stream when its $ends ends",
  ({ ends }) =>
    Effect.gen(function* () {
      const member = MemberId.make("member-test");
      const threadId = ThreadId.make("thread");
      const sessionEnd = yield* Deferred.make<void>();
      const moves = yield* PubSub.unbounded<ThreadAccess.ThreadAccessMove>();
      const threads = new Map<ThreadId, ThreadAccess.ThreadAccessTarget>([
        [threadId, { ownerId: member }],
      ]);
      const output = yield* Queue.make<ServerBrowser.ServerBrowserViewerOutput>();
      yield* Queue.offer(output, { _tag: "viewport", width: 1280, height: 800 });
      const browser = ServerBrowser.ServerBrowser.of({
        clearProfile: () => Effect.void,
        profileReporter: Effect.succeed(() => Effect.void),
        openDownload: () => Effect.succeedNone,
        answerFileChooser: () => Effect.succeed(false),
        attachViewer: () => Effect.succeed({ output, input: () => Effect.void }),
      });
      const auth = makeAuth([AuthOrchestrationReadScope], undefined, {
        sessionEnd: Deferred.await(sessionEnd),
        access: ThreadAccess.makeTest({ serverOwnerId: member, threads, moves }),
      });
      const services = yield* Layer.build(
        HttpRouter.serve(
          routeLayer.pipe(
            Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
            Layer.provide(platformLayer),
          ),
          { disableListenLog: true },
        ).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provide(auth.layer)),
      );
      const server = Context.get(services, HttpServer.HttpServer);
      const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");
      const opened = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<number>();
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const socket = new WebSocket(
            `${origin}/api/preview-stream/ws?threadId=${threadId}&tabId=tab&wsTicket=one-use-ticket`,
          );
          socket.addEventListener("message", () => opened.resolve());
          socket.addEventListener("close", (event) => closed.resolve(event.code));
          return socket;
        }),
        (socket) => Effect.sync(() => socket.close()),
      );
      yield* Effect.promise(() => opened.promise);
      if (ends === "session") {
        yield* Deferred.succeed(sessionEnd, undefined);
      } else {
        const after = { ownerId: MemberId.make("member-other") };
        threads.set(threadId, after);
        yield* PubSub.publish(moves, { sequence: 1, threadId, before: { ownerId: member }, after });
      }
      const code = yield* Effect.promise(() => closed.promise);
      if (ends === "access") expect(code).toBe(4404);
    }).pipe(Effect.scoped),
);

it.effect("tells viewers when the thread's machine has no browser, without naming it", () =>
  Effect.gen(function* () {
    const browser = ServerBrowser.ServerBrowser.of({
      clearProfile: () => Effect.void,
      profileReporter: Effect.succeed(() => Effect.void),
      openDownload: () => Effect.succeedNone,
      answerFileChooser: () => Effect.succeed(false),
      attachViewer: () =>
        Effect.fail(
          new ServerBrowser.ServerBrowserLaunchError({
            cause: new MachineBrowserError({
              sandboxId: SandboxId.make("sbx_5ec7e75ec7e75ec7e75e"),
              reason: "not-installed",
            }),
          }),
        ),
    });
    const services = yield* Layer.build(
      HttpRouter.serve(
        routeLayer.pipe(
          Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
          Layer.provide(platformLayer),
        ),
        { disableListenLog: true },
      ).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(makeAuth([AuthOrchestrationReadScope]).layer),
      ),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");
    const closed = Promise.withResolvers<{ code: number; reason: string }>();
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const socket = new WebSocket(
          `${origin}/api/preview-stream/ws?threadId=thread&tabId=tab&wsTicket=one-use-ticket`,
        );
        socket.addEventListener("close", (event) =>
          closed.resolve({ code: event.code, reason: event.reason }),
        );
        return socket;
      }),
      (socket) => Effect.sync(() => socket.close()),
    );
    const { code, reason } = yield* Effect.promise(() => closed.promise);
    expect(code).toBe(PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE);
    expect(yield* decodeHostSetup(reason)).toEqual({
      need: "machine",
      command: "",
      reason: "not-installed",
    });
    expect(reason).not.toContain("sbx_");
  }).pipe(Effect.scoped),
);

it.effect("streams a machine tab's download from its machine's file system", () =>
  Effect.gen(function* () {
    const path = "/t3-sandbox/sandbox-a/browser/downloads/guid-1";
    const read: Array<string> = [];
    const fileSystem = FileSystem.makeNoop({
      stat: (statPath) =>
        statPath === path
          ? Effect.succeed({ size: ByteSize.bytes(15) } as FileSystem.File.Info)
          : Effect.fail(
              PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "stat" }),
            ),
      stream: (streamPath) => {
        read.push(streamPath);
        return Stream.make(new TextEncoder().encode("report contents"));
      },
    });
    let download = Option.some({ path, fileName: "report.csv", fileSystem });
    const browser = ServerBrowser.ServerBrowser.of({
      clearProfile: () => Effect.void,
      profileReporter: Effect.succeed(() => Effect.void),
      openDownload: () => Effect.sync(() => download),
      answerFileChooser: () => Effect.succeed(false),
      attachViewer: () => Effect.die("unused"),
    });
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          routeLayer.pipe(
            Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
            Layer.provide(platformLayer),
            Layer.provideMerge(makeAuth([AuthOrchestrationReadScope]).layer),
          ),
          { disableLogger: true },
        ),
      ),
      ({ dispose }) => Effect.promise(dispose),
    );
    const url = "http://t3.test/api/preview-stream/download?threadId=thread&tabId=tab&id=d";
    const response = yield* Effect.promise(() => handler.handler(new Request(url)));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("15");
    expect(yield* Effect.promise(() => response.text())).toBe("report contents");
    expect(read).toEqual([path]);
    // A machine that went to sleep has no file to serve.
    download = Option.some({ path: `${path}-gone`, fileName: "report.csv", fileSystem });
    expect((yield* Effect.promise(() => handler.handler(new Request(url)))).status).toBe(404);
  }).pipe(Effect.scoped),
);
