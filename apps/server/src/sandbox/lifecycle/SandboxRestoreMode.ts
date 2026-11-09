import type { ComputeDriverId, SandboxRestoreModeMachine } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/** The machines the reconciler's last pass per driver stopped instead of destroying (04 §5). */
export class SandboxRestoreMode extends Context.Service<
  SandboxRestoreMode,
  {
    readonly record: (
      driverId: ComputeDriverId,
      machines: ReadonlyArray<SandboxRestoreModeMachine>,
    ) => Effect.Effect<void>;
    readonly machines: Effect.Effect<ReadonlyArray<SandboxRestoreModeMachine>>;
  }
>()("t3/sandbox/lifecycle/SandboxRestoreMode") {}

export const layer = Layer.effect(
  SandboxRestoreMode,
  Effect.gen(function* () {
    const byDriver = yield* Ref.make(
      new Map<ComputeDriverId, ReadonlyArray<SandboxRestoreModeMachine>>(),
    );
    return SandboxRestoreMode.of({
      record: Effect.fn("SandboxRestoreMode.record")(function* (
        driverId: ComputeDriverId,
        machines: ReadonlyArray<SandboxRestoreModeMachine>,
      ) {
        yield* Ref.update(byDriver, (current) => new Map(current).set(driverId, machines));
      }),
      machines: Effect.map(Ref.get(byDriver), (current) => [...current.values()].flat()),
    });
  }),
);
