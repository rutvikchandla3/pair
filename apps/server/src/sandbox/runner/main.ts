import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import type * as Socket from "effect/socket/Socket";
import * as SocketServer from "effect/socket/SocketServer";
import { RunnerRpcGroup } from "@t3tools/contracts/runner";
import { encodedChunkBytes, withOutputWindow } from "@t3tools/shared/rpcOutputWindow";

import * as NodePtyAdapter from "../../terminal/NodePtyAdapter.ts";
import * as HandleTable from "./HandleTable.ts";
import * as Handlers from "./handlers.ts";
import * as OpsHandlers from "./opsHandlers.ts";
import * as OpsLayer from "./opsLayer.ts";
import { RunnerConfig, readRunnerConfig, type RunnerConfigShape } from "./RunnerConfig.ts";
import * as RunnerSocketServer from "./RunnerSocketServer.ts";

/** One frame carries at most a 256 KiB chunk (03 3.1); the hub uses the same cap. */
const MAX_FRAME_BYTES = 256 * 1024 + 1024;

const RUNNER_STREAM_TAGS: ReadonlySet<string> = new Set(
  Array.from(RunnerRpcGroup.requests.values())
    .filter((rpc) => RpcSchema.isStreamSchema(rpc.successSchema))
    .map((rpc) => rpc._tag),
);

/**
 * The runner's RPC protocol over its `SocketServer`: each socket is a lease session of the handle
 * table, and every stream method runs ahead of acks only by the window `runner.hello` set.
 */
export const layerProtocol = Layer.effect(
  RpcServer.Protocol,
  Effect.gen(function* () {
    const table = yield* HandleTable.HandleTable;
    const server = yield* SocketServer.SocketServer;
    const protocol = yield* RpcServer.makeProtocolSocketServer.pipe(
      Effect.provideService(
        SocketServer.SocketServer,
        SocketServer.SocketServer.of({
          address: server.address,
          run: Effect.fn("RunnerProtocol.run")(function* <R, E, _>(
            handler: (socket: Socket.Socket) => Effect.Effect<_, E, R>,
          ) {
            return yield* server.run((socket) => table.session(handler(socket)));
          }),
        }),
      ),
    );
    return withOutputWindow(protocol, {
      isWindowed: (tag) => RUNNER_STREAM_TAGS.has(tag),
      get maxChunks() {
        return table.limits().windowChunks;
      },
      get maxBytes() {
        return table.limits().windowBytes;
      },
      sizeOf: encodedChunkBytes,
    });
  }),
);

const RunnerServerLayer = (config: RunnerConfigShape) =>
  RpcServer.layer(RunnerRpcGroup).pipe(
    Layer.provide([Handlers.layer, OpsHandlers.layer]),
    Layer.provide(layerProtocol),
    Layer.provide(RunnerSocketServer.layer),
    Layer.provide(RpcSerialization.layerSchemaBinary({ maxFrameSize: MAX_FRAME_BYTES })),
    Layer.provide(HandleTable.layer),
    Layer.provide(OpsLayer.layer),
    Layer.provide(RunnerSocketServer.layerCredential),
    Layer.provide(NodePtyAdapter.layer),
    Layer.provide(Layer.succeed(RunnerConfig, config)),
    Layer.provide(NodeServices.layer),
  );

/** Serves until the process ends, or until a dial asks for an exit code the bootstrap acts on. */
export const runRunner = Effect.fn("runRunner")(function* () {
  const config = yield* readRunnerConfig().pipe(Effect.provide(NodeServices.layer));
  const exitCode = yield* Deferred.make<number>();
  const shutdown = RunnerSocketServer.RunnerShutdown.of({
    exit: Effect.fn("RunnerShutdown.exit")(function* (code) {
      yield* Deferred.succeed(exitCode, code);
      return yield* Effect.never;
    }),
  });
  return yield* Effect.raceFirst(
    Layer.launch(
      RunnerServerLayer(config).pipe(
        Layer.provide(Layer.succeed(RunnerSocketServer.RunnerShutdown, shutdown)),
      ),
    ),
    Deferred.await(exitCode),
  );
});
