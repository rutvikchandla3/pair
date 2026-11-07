import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import { RUNNER_PROTOCOL_VERSION, RunnerRpcGroup } from "@t3tools/contracts/runner";

const env = { PATH: "/usr/local/bin:/usr/bin:/bin" };

const listen = Effect.acquireRelease(
  Effect.callback<NodeWS.WebSocketServer>((resume) => {
    const server = new NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.once("listening", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      for (const client of server.clients) client.terminate();
      server.close(() => resume(Effect.void));
    }),
);

// Live: a real `t3 runner` subprocess dials a real socket, and the test kills it by its PID.
it.live("enrolls, serves a spawn, and takes its process group down when it dies", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-live-" });
    yield* fs.writeFileString(path.join(stateDir, "enroll"), "enroll-secret\n");

    const server = yield* listen;
    const accepted = yield* Deferred.make<{
      readonly ws: NodeWS.WebSocket;
      readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
    }>();
    server.once("connection", (ws, request) => {
      Deferred.doneUnsafe(accepted, Effect.succeed({ ws, headers: request.headers }));
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no server address");

    const runner = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [path.join(import.meta.dirname, "../../bin.ts"), "runner"],
        {
          env: {
            ...env,
            PAIR_RUNNER_URL: `http://127.0.0.1:${address.port}`,
            PAIR_SANDBOX_ID: "sbx_00000000000000000000",
            PAIR_RUNNER_BUILD: "live-build",
            PAIR_RUNNER_DIR: stateDir,
            PAIR_AGENT_USER: NodeOS.userInfo().username,
          },
          stdout: "ignore",
          stderr: "inherit",
        },
      ),
    );

    const { ws, headers } = yield* Deferred.await(accepted);
    expect(headers.authorization).toBe("Enroll enroll-secret");
    expect(headers["x-pair-runner-protocol"]).toBe(String(RUNNER_PROTOCOL_VERSION));
    expect(headers["x-pair-runner-build"]).toBe("live-build");
    expect(yield* fs.exists(path.join(stateDir, "enroll"))).toBe(false);

    const socket = yield* Socket.fromWebSocket(Effect.succeed(ws));
    const protocol = yield* RpcClient.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
      Effect.provideService(Socket.Socket, socket),
      Effect.provide(RpcSerialization.layerSchemaBinary({ maxFrameSize: 256 * 1024 + 1024 })),
    );
    const client = yield* RpcClient.make(RunnerRpcGroup).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    );

    const info = yield* client["runner.hello"]({
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      serverBootId: "live-server",
      leaseMs: 120_000,
      limits: {
        windowBytes: 262_144,
        windowChunks: 16,
        handleBufferBytes: 4_194_304,
        ptyBufferBytes: 1_048_576,
        sandboxBufferBytes: 67_108_864,
      },
      sandboxToken: Redacted.make("sandbox-token"),
    });
    expect(info).toMatchObject({ runnerBuildId: "live-build", handles: [] });
    const tokenPath = path.join(stateDir, "token");
    expect(yield* fs.readFileString(tokenPath)).toBe("sandbox-token");
    expect(((yield* fs.stat(tokenPath)).mode & 0o777).toString(8)).toBe("600");

    const fifo = path.join(stateDir, "held");
    expect(
      (yield* client["process.run"]({ command: "mkfifo", args: [fifo], cwd: stateDir, env }))
        .exitCode,
    ).toBe(0);
    // The test's own reader, outside the runner; its cat exits once no writer holds the FIFO.
    const reader = yield* spawner.spawn(ChildProcess.make("cat", [fifo], { env }));
    const spawned = yield* client["process.spawn"]({
      command: "/bin/sh",
      args: ["-c", 'exec >"$FIFO"; printf ready; exec sleep 1000'],
      cwd: stateDir,
      env: { ...env, FIFO: fifo },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      extraFds: [],
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        try {
          process.kill(-spawned.pid, "SIGKILL");
        } catch {}
      }),
    );
    expect(yield* reader.stdout.pipe(Stream.decodeText, Stream.take(1), Stream.mkString)).toBe(
      "ready",
    );

    process.kill(runner.pid, "SIGKILL");
    expect(yield* reader.exitCode).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
