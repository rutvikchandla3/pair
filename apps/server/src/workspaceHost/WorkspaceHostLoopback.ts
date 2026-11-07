import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { SandboxId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RunnerGrants from "../sandbox/runnerHub/RunnerGrants.ts";
import * as RunnerHub from "../sandbox/runnerHub/RunnerHub.ts";
import * as RunnerHubTesting from "../sandbox/runnerHub/RunnerHubTesting.ts";
import { SANDBOX_ROOT } from "./WorkspaceHost.ts";
import * as WorkspaceHosts from "./WorkspaceHosts.ts";
import { layerFromContext } from "./WorkspaceHostTesting.ts";

// The loopback test host lives apart from `WorkspaceHostTesting`, which most server tests import:
// it pulls in the runner, the hub and the database.
/** The loopback host's runner, for what a test drives or inspects on the runner's side. */
export class LoopbackRunner extends Context.Service<
  LoopbackRunner,
  {
    readonly sandboxId: SandboxId;
    readonly runner: RunnerHubTesting.TestRunner;
    readonly socket: RunnerHubTesting.TestRunnerConnection;
  }
>()("t3/workspaceHost/WorkspaceHostLoopback/LoopbackRunner") {}

const LOOPBACK_SANDBOX_ID = SandboxId.make("sbx_00000000000000000100");

/**
 * WorkspaceHosts whose `root` is a sandbox host: every call is encoded with the runner protocol,
 * carried over an in-memory socket pair and served by an in-process runner backed by the local
 * disk (02 §7). The hub registers the boot under `/t3-sandbox/<id>` as in production; this layer
 * also registers `root`, so tests use their own temp folders. Paths outside `root` stay local.
 */
export const layerLoopback = (root: string) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const hosts = yield* WorkspaceHosts.WorkspaceHosts;
      const hub = yield* RunnerHub.RunnerHub;
      const runner = yield* RunnerHubTesting.makeRunner(
        yield* hub.mintEnrollment(LOOPBACK_SANDBOX_ID, 1),
      );
      const socket = yield* runner.connect();
      yield* hub.connection(LOOPBACK_SANDBOX_ID);
      const host = yield* hosts.forPath(`${SANDBOX_ROOT}/${LOOPBACK_SANDBOX_ID}`);
      yield* hosts.register(root, host);
      return Context.make(LoopbackRunner, { sandboxId: LOOPBACK_SANDBOX_ID, runner, socket });
    }).pipe(Effect.orDie),
  ).pipe(
    Layer.provideMerge(RunnerHub.layer),
    Layer.provideMerge(layerFromContext),
    Layer.provide(RunnerGrants.layer),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(NodeCrypto.layer),
    Layer.orDie,
  );
