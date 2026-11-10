import { assert, it } from "@effect/vitest";
import { ComputeDriverId, type DockerSandboxDriver } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../../serverSettings.ts";
import * as ComputeDriverRegistry from "./ComputeDriverRegistry.ts";
import * as ComputeDriverTesting from "./ComputeDriverTesting.ts";

const local = ComputeDriverId.make("local");
const localDocker: DockerSandboxDriver = { kind: "docker", id: local, label: "Local Docker" };

const withRegistry = <A, E, R>(
  use: (lifecycle: {
    readonly built: Array<string>;
    readonly closed: Array<string>;
  }) => Effect.Effect<A, E, R>,
) => {
  const built: Array<string> = [];
  const closed: Array<string> = [];
  const registry = ComputeDriverRegistry.layer({
    docker: (config) =>
      Effect.gen(function* () {
        built.push(config.label);
        yield* Effect.addFinalizer(() => Effect.sync(() => closed.push(config.label)));
        return (yield* ComputeDriverTesting.make(config.id)).driver;
      }),
  });
  return use({ built, closed }).pipe(
    Effect.provide(
      registry.pipe(
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            sandbox: { drivers: [localDocker], defaultDriverId: local },
          }),
        ),
      ),
    ),
  );
};

it.effect("reuses a driver until its config changes, then closes the old one", () =>
  withRegistry(({ built, closed }) =>
    Effect.gen(function* () {
      const registry = yield* ComputeDriverRegistry.ComputeDriverRegistry;
      const settings = yield* ServerSettingsService;

      const first = yield* registry.get(local);
      assert.strictEqual(yield* registry.get(local), first);
      assert.deepStrictEqual(built, ["Local Docker"]);
      assert.strictEqual(yield* registry.runningCap(local), first.capabilities.defaultRunningCap);

      // A cap edit is read at admission; rebuilding would fail the driver's in-flight calls.
      yield* settings.updateSettings({
        sandbox: { drivers: { [local]: { ...localDocker, runningCap: 2 } } },
      });
      assert.strictEqual(yield* registry.runningCap(local), 2);
      assert.strictEqual(yield* registry.get(local), first);
      assert.deepStrictEqual(closed, []);

      yield* settings.updateSettings({
        sandbox: { drivers: { [local]: { ...localDocker, label: "Build host" } } },
      });
      const rebuilt = yield* registry.get(local);
      assert.notStrictEqual(rebuilt, first);
      assert.deepStrictEqual(built, ["Local Docker", "Build host"]);
      assert.deepStrictEqual(closed, ["Local Docker"]);
      assert.deepStrictEqual(yield* registry.list, [rebuilt]);
    }),
  ),
);

it.effect("fails a removed driver that is still the default and closes it", () =>
  withRegistry(({ closed }) =>
    Effect.gen(function* () {
      const registry = yield* ComputeDriverRegistry.ComputeDriverRegistry;
      const settings = yield* ServerSettingsService;
      yield* registry.get(local);

      const next = yield* settings.updateSettings({ sandbox: { drivers: { [local]: null } } });
      assert.isUndefined(next.sandbox?.defaultDriverId);

      const error = yield* Effect.flip(registry.get(local));
      assert.instanceOf(error, ComputeDriverRegistry.ComputeDriverNotConfiguredError);
      assert.deepStrictEqual(closed, ["Local Docker"]);
      assert.deepStrictEqual(yield* registry.list, []);
    }),
  ),
);
