import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";

import * as NodePtyAdapter from "../../terminal/NodePtyAdapter.ts";
import * as HandleTable from "./HandleTable.ts";
import * as Handlers from "./handlers.ts";
import { RunnerConfig } from "./RunnerConfig.ts";
import { RunnerCredential } from "./RunnerSocketServer.ts";

export const TEST_RUNNER_BUILD_ID = "test-runner-build";

/** Keeps the credential in memory, so a test reads what `runner.hello` stored. */
const layerMemoryCredential = Layer.effect(
  RunnerCredential,
  Effect.gen(function* () {
    const current = yield* Ref.make(Redacted.make("Enroll test-enrollment"));
    return RunnerCredential.of({
      authorization: Ref.get(current),
      setSandboxToken: Effect.fn("RunnerCredential.setSandboxToken")(function* (token) {
        yield* Ref.set(current, Redacted.make(`Bearer ${Redacted.value(token)}`));
      }),
    });
  }),
);

/**
 * The runner's handlers in process, against real child processes, PTYs and files. Serve them
 * with `RpcTest.makeClient(RunnerRpcGroup)` or an `RpcServer` over an in-memory socket.
 */
export const layer = Layer.mergeAll(Handlers.layer, Handlers.opsLayer).pipe(
  Layer.provideMerge(HandleTable.layer),
  Layer.provideMerge(layerMemoryCredential),
  Layer.provide(
    Layer.succeed(RunnerConfig, {
      url: "unix:/nonexistent/runner.sock",
      sandboxId: "sbx_00000000000000000000",
      runnerBuildId: TEST_RUNNER_BUILD_ID,
      enrollment: Option.none(),
      stateDir: "/nonexistent/pair-runner",
    }),
  ),
  Layer.provide(NodePtyAdapter.layer),
  Layer.provideMerge(NodeServices.layer),
);
