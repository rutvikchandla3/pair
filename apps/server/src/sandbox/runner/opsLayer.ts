import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as WorkspaceReadGuard from "../../workspace/WorkspaceReadGuard.ts";
import * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";
import * as GroupWatcher from "./GroupWatcher.ts";
import { RunnerConfig } from "./RunnerConfig.ts";

// The runner is root, but the clone and worktrees belong to the agent: root's git refuses them
// (safe.directory), and would leave root-owned objects in the agent's repository if it didn't.
const layerAgentSpawner = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { agent } = (yield* RunnerConfig).facts;
    if (agent.uid === null) return spawner;
    const uid = agent.uid;
    return ChildProcessSpawner.make((command) => {
      if (command._tag === "PipedCommand") {
        return Effect.fail(
          PlatformError.badArgument({
            module: "RunnerOps",
            method: "spawn",
            description: "piped commands are not supported in runner operations",
          }),
        );
      }
      const [file, args] = GroupWatcher.commandLine({
        command: command.command,
        args: command.args.map((arg) => (Redacted.isRedacted(arg) ? Redacted.value(arg) : arg)),
        uid,
      });
      const { options } = command;
      return spawner.spawn(
        ChildProcess.make(file, args, {
          ...options,
          env: { ...options.env, HOME: agent.homeDirectory },
          extendEnv: options.env === undefined || options.extendEnv === true,
        }),
      );
    });
  }),
);

// The runner has no clients to hold leases or host-power state to respect, so its scans always run.
const layerAlwaysActive = Layer.succeed(
  BackgroundPolicy.BackgroundPolicy,
  BackgroundPolicy.BackgroundPolicy.of({
    // @effect-diagnostics-next-line effectFnOpportunity:off -- constant answers for a runner with no clients.
    reportClientActivity: () => Effect.void,
    // @effect-diagnostics-next-line effectFnOpportunity:off -- constant answers for a runner with no clients.
    removeRpcClient: () => Effect.void,
    snapshot: Effect.die("The sandbox runner keeps no background policy snapshot."),
    // @effect-diagnostics-next-line effectFnOpportunity:off -- constant answers for a runner with no clients.
    shouldRunScopeWork: () => Effect.succeed(true),
    shouldRunOpportunisticWork: Effect.succeed(true),
  }),
);

/**
 * The server services coarse operations run, against the sandbox's own disk. Every path is local
 * here, the sandbox root included. No server config, settings or database.
 */
export const layer = Layer.mergeAll(
  CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer)),
  WorkspaceEntries.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(WorkspaceReadGuard.layerUnconfined),
  ),
  PortScanner.layerAllListeners.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(layerAlwaysActive),
  ),
).pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(WorkspaceHosts.layerLocalOnly),
  Layer.provide(layerAgentSpawner),
  Layer.provide(NodeCrypto.layer),
);
