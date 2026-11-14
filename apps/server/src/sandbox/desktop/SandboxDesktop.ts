import {
  SandboxDesktopError,
  type SandboxDesktopInput,
  type SandboxDesktopResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { ComputeDriverRegistry } from "../compute/ComputeDriverRegistry.ts";

export class SandboxDesktop extends Context.Service<
  SandboxDesktop,
  {
    /** A fresh viewer URL for the thread's running machine; each viewer load asks again. */
    readonly open: (
      input: SandboxDesktopInput,
    ) => Effect.Effect<SandboxDesktopResult, SandboxDesktopError>;
  }
>()("t3/sandbox/desktop/SandboxDesktop") {}

export const layer = Layer.effect(
  SandboxDesktop,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const registry = yield* ComputeDriverRegistry;
    const refuse = (reason: SandboxDesktopError["reason"]) => new SandboxDesktopError({ reason });
    const unavailable = (cause: unknown) =>
      new SandboxDesktopError({ reason: "unavailable", cause });

    return SandboxDesktop.of({
      open: Effect.fn("SandboxDesktop.open")(function* ({ threadId, theme }) {
        const shell = yield* projections
          .getThreadShell(threadId)
          .pipe(Effect.mapError(unavailable));
        if (shell?.sandboxId === undefined) return yield* refuse("no-machine");
        const record = yield* projections
          .getSandbox(shell.sandboxId)
          .pipe(Effect.mapError(unavailable));
        if (record === null) return yield* refuse("no-machine");
        if (record.state !== "ready" || record.driverRef === null) {
          return yield* refuse("not-running");
        }
        const driver = yield* registry.get(record.driverId).pipe(Effect.mapError(unavailable));
        if (driver.desktop === undefined) return yield* refuse("unsupported");
        const url = yield* driver.desktop(record.driverRef, theme).pipe(
          Effect.mapError(
            (error) =>
              new SandboxDesktopError({
                reason: "unavailable",
                ...(error.setupHint === undefined ? {} : { detail: error.setupHint }),
                cause: error,
              }),
          ),
        );
        return { url };
      }),
    });
  }),
);
