import { NonNegativeInt, SandboxId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { SandboxBootstrap } from "../compute/ComputeDriver.ts";

export class SandboxBootstrapUnavailableError extends Schema.TaggedError<SandboxBootstrapUnavailableError>()(
  "SandboxBootstrapUnavailableError",
  { sandboxId: SandboxId, generation: NonNegativeInt },
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
    }) => Effect.Effect<SandboxBootstrap, SandboxBootstrapUnavailableError>;
  }
>()("t3/sandbox/lifecycle/SandboxBootstrapSource") {}

/** Until the runner hub owns enrollment and bundles, every boot fails without a driver call. */
export const layerUnconfigured = Layer.succeed(
  SandboxBootstrapSource,
  SandboxBootstrapSource.of({
    forGeneration: Effect.fn("SandboxBootstrapSource.forGeneration")(function* (input) {
      return yield* new SandboxBootstrapUnavailableError(input);
    }),
  }),
);
