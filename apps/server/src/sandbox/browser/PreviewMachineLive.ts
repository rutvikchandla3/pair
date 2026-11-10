import type { OrchestrationV2Sandbox, SandboxId, ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { PreviewMachine } from "../../preview/PreviewMachine.ts";
import { SANDBOX_ROOT } from "../../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";
import { SandboxWake } from "../lifecycle/SandboxWakeService.ts";
import { RunnerHub } from "../runnerHub/RunnerHub.ts";
import { MachineBrowser, MachineBrowserError } from "./MachineBrowser.ts";

const RUNNER_WAIT = Duration.minutes(2);

// Waiting for admission has no deadline; a boot has the lifecycle's, so this wait ends with it.
const booting = (record: OrchestrationV2Sandbox | null) =>
  record?.state === "provisioning" || record?.state === "waking";

/** A thread's tabs run on its machine's Chrome: decided from the projection, never from input. */
export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const browser = yield* MachineBrowser;
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  const hub = yield* RunnerHub;
  const wake = yield* SandboxWake;

  /**
   * Wakes a sleeping machine and waits for its runner's hello: 2 minutes, or longer while the
   * machine is still booting or waiting for a slot, which its thread shows meanwhile.
   */
  const awake = Effect.fn("PreviewMachine.awake")(function* (
    threadId: ThreadId,
    sandboxId: SandboxId,
  ) {
    const unavailable = () => new MachineBrowserError({ sandboxId, reason: "machine-unavailable" });
    yield* wake.wake({ threadId });
    const readRecord = projections.getSandbox(sandboxId).pipe(Effect.orElseSucceed(() => null));
    const record = yield* readRecord;
    if (record === null) return yield* unavailable();
    // A wake starts a new generation; the old boot's runner never counts.
    const hello = hub.status(sandboxId).pipe(
      Stream.filter(
        (status) => status._tag === "connected" && status.generation >= record.generation,
      ),
      Stream.runHead,
      Effect.timeoutOption(RUNNER_WAIT),
    );
    while (Option.isNone(yield* hello)) {
      if (!booting(yield* readRecord)) return yield* unavailable();
    }
    return yield* hosts.forPath(`${SANDBOX_ROOT}/${sandboxId}`).pipe(Effect.mapError(unavailable));
  });

  const forThread = Effect.fn("PreviewMachine.forThread")(function* (threadId: ThreadId) {
    const shell = yield* projections
      .getThreadShell(threadId)
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not read a thread's machine", { threadId, cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
    const sandboxId = shell?.sandboxId;
    if (sandboxId === undefined) return Option.none();
    return Option.some({
      sandboxId,
      endpoint: browser.endpoint(sandboxId),
      // A tab opens here first, so opening one wakes the machine; a reconnect never does.
      host: awake(threadId, sandboxId),
    });
  });

  return { forThread };
});

export const layer = Layer.effect(PreviewMachine, make);
