import { expect, it } from "@effect/vitest";
import {
  ComputeDriverId,
  type OrchestrationV2Sandbox,
  type OrchestrationV2ThreadShell,
  ProjectId,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import { RUNNER_PROTOCOL_VERSION } from "@t3tools/contracts/runner";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { SANDBOX_ROOT, type WorkspaceHostId } from "../../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";
import * as WorkspaceHostTesting from "../../workspaceHost/WorkspaceHostTesting.ts";
import { SandboxWake } from "../lifecycle/SandboxWakeService.ts";
import { RunnerHub, type RunnerConnectionStatus } from "../runnerHub/RunnerHub.ts";
import { MachineBrowser } from "./MachineBrowser.ts";
import * as PreviewMachineLive from "./PreviewMachineLive.ts";

const sandboxId = SandboxId.make("sbx_cccccccccccccccccccc");
const threadId = ThreadId.make("thread-tab");
const at = DateTime.makeUnsafe("2026-11-11T00:00:00Z");

const sleeping: OrchestrationV2Sandbox = {
  id: sandboxId,
  projectId: ProjectId.make("project-tab"),
  ownerThreadId: threadId,
  ownerMemberId: null,
  driverId: ComputeDriverId.make("gce"),
  size: "default",
  state: "sleeping",
  generation: 1,
  driverRef: "vm",
  admission: null,
  runnerLostAt: null,
  sleepReason: "idle",
  failure: null,
  createdAt: at,
  updatedAt: at,
};

const connected = (generation: number): RunnerConnectionStatus => ({
  _tag: "connected",
  generation,
  runnerBootId: `boot-${generation}`,
  info: {
    runnerBootId: `boot-${generation}`,
    runnerBuildId: "build",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    arch: "x64",
    cpus: 2,
    memoryBytes: 1024,
    agent: { uid: 1000, homeDirectory: "/home/t3", shell: "/bin/bash" },
    tmpDirectory: "/tmp",
    bundleDirectory: "/opt/pair-runner/build",
    imageEnvironment: {},
    handles: [],
  },
});

/** `wake` moves a sleeping record to waking, as `sandbox.wake` does, admitted or not. */
const setup = Effect.fnUntraced(function* (
  initial: OrchestrationV2Sandbox,
  admission: OrchestrationV2Sandbox["admission"] = null,
) {
  const record = yield* Ref.make<OrchestrationV2Sandbox>(initial);
  // The previous boot's runner, still reported until the hub hears from the new one.
  const status = yield* SubscriptionRef.make<RunnerConnectionStatus>(connected(1));
  const wakes: Array<ThreadId> = [];
  const layer = Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: () => Effect.succeed({ sandboxId } as unknown as OrchestrationV2ThreadShell),
      getSandbox: () => Ref.get(record),
    }),
    Layer.mock(MachineBrowser)({ endpoint: () => Effect.succeed("ws://127.0.0.1:1/devtools") }),
    Layer.mock(RunnerHub)({ status: () => SubscriptionRef.changes(status) }),
    Layer.mock(SandboxWake)({
      wake: (input) =>
        Effect.sync(() => wakes.push(input.threadId)).pipe(
          Effect.andThen(
            Ref.update(record, (current): OrchestrationV2Sandbox =>
              current.state === "sleeping"
                ? { ...current, state: "waking", generation: current.generation + 1, admission }
                : current,
            ),
          ),
        ),
    }),
    WorkspaceHostTesting.layerFromContext,
  );
  const { machine, hosts } = yield* Effect.gen(function* () {
    return {
      machine: yield* PreviewMachineLive.make,
      hosts: yield* WorkspaceHosts.WorkspaceHosts,
    };
  }).pipe(Effect.provide(layer));
  const target = Option.getOrThrow(yield* machine.forThread(threadId));

  /** The new boot's runner says hello: its host registers, then the hub reports it. */
  const hello = Effect.fnUntraced(function* (generation: number) {
    yield* hosts
      .register(`${SANDBOX_ROOT}/${sandboxId}`, {
        ...hosts.local,
        id: sandboxId as string as WorkspaceHostId,
        kind: "sandbox",
      })
      .pipe(Scope.provide(yield* Scope.make()));
    yield* SubscriptionRef.set(status, connected(generation));
  });

  return { target, record, status, wakes, hello };
});

it.effect("a tab on a sleeping machine wakes it once and opens after its runner's hello", () =>
  Effect.gen(function* () {
    const { target, wakes, hello } = yield* setup(sleeping);
    const opening = yield* target.host.pipe(Effect.forkChild);
    // The old boot's runner does not count.
    yield* TestClock.adjust("1 minute");
    expect(opening.pollUnsafe()).toBeUndefined();
    expect(wakes).toEqual([threadId]);

    yield* hello(2);
    expect((yield* Fiber.join(opening)).id).toBe(sandboxId);
    expect(wakes).toEqual([threadId]);
  }),
);

it.effect("gives up after 2 minutes without a runner, saying the machine did not wake", () =>
  Effect.gen(function* () {
    const { target, status } = yield* setup({ ...sleeping, state: "ready" });
    yield* SubscriptionRef.set(status, { _tag: "lost", runnerBootId: "boot-1" });
    const opening = yield* target.host.pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("2 minutes");
    const error = yield* Fiber.join(opening);
    expect(error.reason).toBe("machine-unavailable");
    expect(error.message).toBe("The machine did not wake. Try again.");
  }),
);

it.effect("keeps waiting while the machine waits for a slot, and fails once it stops booting", () =>
  Effect.gen(function* () {
    const { target, record, hello } = yield* setup(sleeping, { reason: "team-cap", since: at });
    const opening = yield* target.host.pipe(Effect.forkChild);
    yield* TestClock.adjust("5 minutes");
    expect(opening.pollUnsafe()).toBeUndefined();
    yield* hello(2);
    expect((yield* Fiber.join(opening)).id).toBe(sandboxId);

    // A boot that fails stops the wait at the next check.
    const booting: OrchestrationV2Sandbox = { ...sleeping, state: "waking", generation: 3 };
    yield* Ref.set(record, booting);
    const failing = yield* target.host.pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("2 minutes");
    expect(failing.pollUnsafe()).toBeUndefined();
    yield* Ref.update(record, (current): OrchestrationV2Sandbox => ({
      ...current,
      state: "failed",
    }));
    yield* TestClock.adjust("2 minutes");
    expect((yield* Fiber.join(failing)).reason).toBe("machine-unavailable");
  }),
);
