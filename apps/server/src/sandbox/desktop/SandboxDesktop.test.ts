import { assert, it } from "@effect/vitest";
import {
  ComputeDriverId,
  type OrchestrationV2Sandbox,
  type OrchestrationV2ThreadShell,
  ProjectId,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { ComputeDriverError, type ComputeDriver } from "../compute/ComputeDriver.ts";
import { ComputeDriverRegistry } from "../compute/ComputeDriverRegistry.ts";
import * as SandboxDesktop from "./SandboxDesktop.ts";

const sandboxId = SandboxId.make("sbx_eeeeeeeeeeeeeeeeeeee");
const threadId = ThreadId.make("thread-desktop");
const driverId = ComputeDriverId.make("boat");
const at = DateTime.makeUnsafe("2026-11-14T00:00:00Z");

const ready: OrchestrationV2Sandbox = {
  id: sandboxId,
  projectId: ProjectId.make("project-desktop"),
  ownerThreadId: threadId,
  ownerMemberId: null,
  driverId,
  size: "default",
  state: "ready",
  generation: 1,
  driverRef: "pair-machine-g1",
  admission: null,
  runnerLostAt: null,
  sleepReason: null,
  failure: null,
  createdAt: at,
  updatedAt: at,
};

const open = (input: {
  readonly onMachine: boolean;
  readonly record: OrchestrationV2Sandbox | null;
  readonly desktop: ComputeDriver["Service"]["desktop"];
}) =>
  Effect.gen(function* () {
    const service = yield* SandboxDesktop.SandboxDesktop;
    return yield* Effect.result(service.open({ threadId, theme: "dark" }));
  }).pipe(
    Effect.provide(
      SandboxDesktop.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadShell: () =>
                Effect.succeed(
                  (input.onMachine ? { sandboxId } : {}) as OrchestrationV2ThreadShell,
                ),
              getSandbox: () => Effect.succeed(input.record),
            }),
            Layer.mock(ComputeDriverRegistry)({
              get: () =>
                Effect.succeed(
                  (input.desktop === undefined
                    ? {}
                    : { desktop: input.desktop }) as ComputeDriver["Service"],
                ),
            }),
          ),
        ),
      ),
    ),
  );

it.effect("opens a running machine's desktop, and says why it cannot otherwise", () =>
  Effect.gen(function* () {
    const asked: Array<string> = [];
    const desktop = (driverRef: string, theme: "light" | "dark") =>
      Effect.sync(() => {
        asked.push(`${driverRef}:${theme}`);
        return "https://desktop.example/stream#token=t";
      });

    const opened = yield* open({ onMachine: true, record: ready, desktop });
    assert.strictEqual(
      opened._tag === "Success" ? opened.success.url : null,
      "https://desktop.example/stream#token=t",
    );
    assert.deepStrictEqual(asked, ["pair-machine-g1:dark"]);

    const refusals = [
      [{ onMachine: false, record: ready, desktop }, "no-machine"],
      [{ onMachine: true, record: null, desktop }, "no-machine"],
      [
        { onMachine: true, record: { ...ready, state: "sleeping" as const }, desktop },
        "not-running",
      ],
      [{ onMachine: true, record: { ...ready, driverRef: null }, desktop }, "not-running"],
      [{ onMachine: true, record: ready, desktop: undefined }, "unsupported"],
    ] as const;
    for (const [input, reason] of refusals) {
      const result = yield* open(input);
      assert.strictEqual(result._tag === "Failure" ? result.failure.reason : null, reason);
    }
    assert.strictEqual(asked.length, 1);

    const failed = yield* open({
      onMachine: true,
      record: ready,
      desktop: () =>
        Effect.fail(
          new ComputeDriverError({
            driverId,
            operation: "desktop",
            reason: "auth",
            retryable: false,
            setupHint: "Give the key the desktop action.",
          }),
        ),
    });
    assert.strictEqual(
      failed._tag === "Failure" ? failed.failure.message : null,
      "Give the key the desktop action.",
    );
  }),
);
