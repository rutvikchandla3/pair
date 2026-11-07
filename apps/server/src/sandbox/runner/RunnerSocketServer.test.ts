import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";

import { RunnerConfig, type RunnerConfigShape } from "./RunnerConfig.ts";
import * as RunnerSocketServer from "./RunnerSocketServer.ts";

/** Reads frames until the socket ends, as `RpcServer`'s socket loop does. */
const readUntilClosed = (socket: Socket.Socket) =>
  Effect.scoped(
    Effect.gen(function* () {
      const reader = yield* socket.reader;
      while (true) yield* reader.pull;
    }),
  );

describe("RunnerSocketServer", () => {
  it.effect.each([
    {
      url: "unix:/run/t3/runner.sock",
      expected: "ws+unix:/run/t3/runner.sock:/runner/v1/connect",
      compress: false,
    },
    {
      url: "http://127.0.0.1:3773",
      expected: "ws://127.0.0.1:3773/runner/v1/connect",
      compress: false,
    },
    {
      url: "https://team.example.com/",
      expected: "wss://team.example.com/runner/v1/connect",
      compress: true,
    },
  ])("dials $url as $expected", ({ url, expected, compress }) =>
    Effect.sync(() => {
      expect(RunnerSocketServer.connectUrl(url)).toEqual({ url: expected, compress });
    }),
  );

  it.effect("ends a socket after 45 s without a frame and redials", () =>
    Effect.gen(function* () {
      const dials = yield* Queue.unbounded<number>();
      let count = 0;
      const silent = Socket.make({
        reader: Effect.succeed({ pull: Effect.never, upgrade: () => Effect.void }),
        writer: Effect.succeed({ write: () => Effect.void, writeAll: () => Effect.void }),
      });
      const server = RunnerSocketServer.make(
        Effect.sync(() => {
          count += 1;
          Queue.offerUnsafe(dials, count);
          return silent;
        }),
        "test",
      );
      yield* server.run(readUntilClosed).pipe(Effect.forkScoped);
      expect(yield* Queue.take(dials)).toBe(1);
      yield* TestClock.adjust("44 seconds");
      expect(yield* Queue.size(dials)).toBe(0);
      // The timer fires at 45 s; the redial waits at most 250 ms after a session that connected.
      yield* TestClock.adjust("1250 millis");
      expect(yield* Queue.take(dials)).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("backs off failed dials, doubling to a 10 s cap", () =>
    Effect.gen(function* () {
      const dials = yield* Queue.unbounded<void>();
      const server = RunnerSocketServer.make(
        Queue.offer(dials, undefined).pipe(
          Effect.andThen(Effect.fail(new RunnerSocketServer.RunnerDialError({ cause: "refused" }))),
        ),
        "test",
      );
      yield* server.run(readUntilClosed).pipe(Effect.forkScoped);
      yield* Queue.take(dials);
      // Full jitter: each wait is at most the bound, so adjusting by it always redials.
      for (const bound of [250, 500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000]) {
        yield* TestClock.adjust(bound);
        yield* Queue.take(dials);
      }
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { status: 426, exitCode: 75, serverBuild: Option.some("server-build-2") },
    { status: 401, exitCode: 77, serverBuild: Option.none() },
  ])("exits $exitCode on a $status upgrade", ({ status, exitCode, serverBuild }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-state-" });
      const config: RunnerConfigShape = {
        url: "http://127.0.0.1:1",
        sandboxId: "sbx_00000000000000000000",
        runnerBuildId: "runner-build-1",
        enrollment: Option.some(Redacted.make("enroll-secret")),
        stateDir,
        facts: {
          agent: { uid: null, homeDirectory: "/home/t3", shell: "/bin/sh" },
          tmpDirectory: "/tmp",
          bundleDirectory: "/opt/pair-runner/runner-build-1",
          imageEnvironment: {},
        },
      };
      const exited = yield* Deferred.make<number>();
      const sent: Array<Readonly<Record<string, string>> | undefined> = [];
      const rejected = new RunnerSocketServer.RunnerUpgradeRejected({
        status,
        body: JSON.stringify({ protocolVersion: 1, runnerBuildId: "server-build-2" }),
      });
      const stub: Socket.WebSocketConstructor["Service"] = (_url, options) => {
        sent.push(
          typeof options === "object" && !Array.isArray(options) ? options.headers : undefined,
        );
        return {
          readyState: 0,
          addEventListener: (type, listener) => {
            if (type === "error")
              queueMicrotask(() =>
                listener({ type: "error", error: rejected } as Socket.WebSocketEvent),
              );
          },
          removeEventListener: () => undefined,
          close: () => undefined,
          send: () => undefined,
        };
      };
      yield* RunnerSocketServer.dialWebSocket(config).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Socket.WebSocketConstructor, stub),
            Layer.succeed(RunnerSocketServer.RunnerShutdown, {
              exit: (code) => Deferred.succeed(exited, code).pipe(Effect.andThen(Effect.never)),
            }),
            RunnerSocketServer.layerCredential.pipe(
              Layer.provide(Layer.succeed(RunnerConfig, config)),
            ),
          ),
        ),
        Effect.forkScoped,
      );
      expect(yield* Deferred.await(exited)).toBe(exitCode);
      expect(sent).toEqual([
        {
          Authorization: "Enroll enroll-secret",
          "X-Pair-Runner-Protocol": "1",
          "X-Pair-Runner-Build": "runner-build-1",
        },
      ]);
      const written = yield* fs
        .readFileString(path.join(stateDir, "server-build"))
        .pipe(Effect.option);
      expect(written).toEqual(serverBuild);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
