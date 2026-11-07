import { NonNegativeInt, SandboxId, type ComputeDriverId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../../serverSettings.ts";
import type { SandboxBootstrap } from "../compute/ComputeDriver.ts";
import { RunnerEndpoint, type RunnerRouteError } from "../runnerHub/RunnerEndpoint.ts";
import { RunnerBundle, type RunnerBundleUnavailableError } from "../runnerHub/RunnerBundle.ts";
import { RunnerHub } from "../runnerHub/RunnerHub.ts";

export class SandboxBootstrapUnavailableError extends Schema.TaggedError<SandboxBootstrapUnavailableError>()(
  "SandboxBootstrapUnavailableError",
  { sandboxId: SandboxId, generation: NonNegativeInt, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `No runner bootstrap is available for sandbox ${this.sandboxId} generation ${this.generation}.`;
  }
}

/** Mints what a booting generation needs to enroll its runner (decision 5). */
export class SandboxBootstrapSource extends Context.Service<
  SandboxBootstrapSource,
  {
    readonly forGeneration: (input: {
      readonly sandboxId: SandboxId;
      readonly generation: number;
      readonly driverId: ComputeDriverId;
    }) => Effect.Effect<
      SandboxBootstrap,
      SandboxBootstrapUnavailableError | RunnerRouteError | RunnerBundleUnavailableError
    >;
  }
>()("t3/sandbox/lifecycle/SandboxBootstrapSource") {}

export const layer = Layer.effect(
  SandboxBootstrapSource,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const endpoint = yield* RunnerEndpoint;
    const hub = yield* RunnerHub;
    const bundle = yield* RunnerBundle;

    const forGeneration: SandboxBootstrapSource["Service"]["forGeneration"] = Effect.fn(
      "SandboxBootstrapSource.forGeneration",
    )(function* ({ sandboxId, generation, driverId }) {
      const unavailable = (cause?: unknown) =>
        new SandboxBootstrapUnavailableError({
          sandboxId,
          generation,
          ...(cause === undefined ? {} : { cause }),
        });
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      const driver = current.sandbox?.drivers.find((entry) => entry.id === driverId);
      if (driver === undefined) return yield* unavailable();
      // Route and build first: a boot that cannot dial must not spend a grant.
      const plan = yield* endpoint.planFor(driver);
      const { runnerBuildId } = yield* bundle.current;
      const enrollmentSecret = yield* hub
        .mintEnrollment(sandboxId, generation)
        .pipe(Effect.mapError(unavailable));
      return { sandboxId, generation, runnerBuildId, serverUrl: plan.serverUrl, enrollmentSecret };
    });

    return SandboxBootstrapSource.of({ forGeneration });
  }),
);
