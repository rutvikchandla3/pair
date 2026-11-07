import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { RunnerRpcGroup } from "@t3tools/contracts/runner";

import * as NodePtyAdapter from "../../terminal/NodePtyAdapter.ts";
import * as HandleTable from "./HandleTable.ts";
import * as Handlers from "./handlers.ts";
import { RunnerConfig, readRunnerConfig, type RunnerConfigShape } from "./RunnerConfig.ts";
import * as RunnerSocketServer from "./RunnerSocketServer.ts";

/** One frame carries at most a 256 KiB chunk (03 3.1); the hub uses the same cap. */
const MAX_FRAME_BYTES = 256 * 1024 + 1024;

const RunnerServerLayer = (config: RunnerConfigShape) =>
  RpcServer.layer(RunnerRpcGroup).pipe(
    Layer.provide([Handlers.layer, Handlers.opsLayer]),
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(RunnerSocketServer.layer),
    Layer.provide(RpcSerialization.layerSchemaBinary({ maxFrameSize: MAX_FRAME_BYTES })),
    Layer.provide(HandleTable.layer),
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
