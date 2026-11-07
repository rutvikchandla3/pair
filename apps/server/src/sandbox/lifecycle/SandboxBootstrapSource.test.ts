import { assert, it } from "@effect/vitest";
import { ComputeDriverId, type DockerSandboxDriver, SandboxId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  RunnerBundle,
  type RunnerBundleInfo,
  RunnerBundleUnavailableError,
} from "../runnerHub/RunnerBundle.ts";
import { RunnerEndpoint, RunnerRouteError } from "../runnerHub/RunnerEndpoint.ts";
import { RunnerHub } from "../runnerHub/RunnerHub.ts";
import * as SandboxBootstrapSource from "./SandboxBootstrapSource.ts";

const local: DockerSandboxDriver = {
  kind: "docker",
  id: ComputeDriverId.make("local"),
  label: "L",
};
const remote: DockerSandboxDriver = {
  kind: "docker",
  id: ComputeDriverId.make("remote"),
  label: "R",
  dockerHost: "tcp://docker.example:2375",
};
const sandboxId = SandboxId.make("sbx_0123456789abcdef0123");

it.effect("mints a grant only once the route and the runner build are known", () => {
  const minted: Array<number> = [];
  const layer = (bundle: Layer.Layer<RunnerBundle>) =>
    SandboxBootstrapSource.layer.pipe(
      Layer.provide(bundle),
      Layer.provide(ServerSettingsService.layerTest({ sandbox: { drivers: [local, remote] } })),
      Layer.provide(
        Layer.succeed(RunnerEndpoint, {
          planFor: (driver) =>
            driver.dockerHost === undefined
              ? Effect.succeed({ serverUrl: "unix:/srv/t3/runner-socket/runner.sock" })
              : Effect.fail(
                  new RunnerRouteError({ driverId: driver.id, reason: "runner-url-required" }),
                ),
        }),
      ),
      Layer.provide(
        Layer.mock(RunnerHub)({
          mintEnrollment: (_sandboxId, generation) =>
            Effect.sync(() => minted.push(generation)).pipe(Effect.as(Redacted.make("secret"))),
        }),
      ),
    );
  return Effect.gen(function* () {
    const source = yield* Effect.provide(
      Effect.service(SandboxBootstrapSource.SandboxBootstrapSource),
      layer(
        Layer.succeed(RunnerBundle, {
          current: Effect.fail(new RunnerBundleUnavailableError({ reason: "single-executable" })),
        }),
      ),
    );
    const routeError = yield* Effect.flip(
      source.forGeneration({ sandboxId, generation: 1, driverId: remote.id }),
    );
    assert.strictEqual(routeError._tag, "RunnerRouteError");
    const buildError = yield* Effect.flip(
      source.forGeneration({ sandboxId, generation: 1, driverId: local.id }),
    );
    assert.strictEqual(buildError._tag, "RunnerBundleUnavailableError");
    assert.deepStrictEqual(minted, []);

    const built = yield* Effect.provide(
      Effect.service(SandboxBootstrapSource.SandboxBootstrapSource),
      layer(
        Layer.mock(RunnerBundle)({
          current: Effect.succeed({ runnerBuildId: "build-1" } as RunnerBundleInfo),
        }),
      ),
    );
    const bootstrap = yield* built.forGeneration({ sandboxId, generation: 2, driverId: local.id });
    assert.strictEqual(bootstrap.serverUrl, "unix:/srv/t3/runner-socket/runner.sock");
    assert.strictEqual(bootstrap.runnerBuildId, "build-1");
    assert.strictEqual(Redacted.value(bootstrap.enrollmentSecret), "secret");
    assert.deepStrictEqual(minted, [2]);
  });
});
