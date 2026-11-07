import {
  CommandId,
  type OrchestrationV2Sandbox,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../../serverActivation.ts";
import { listLiveSandboxes } from "../lifecycle/SandboxProjection.ts";
import { RunnerHub, type RunnerHubFact } from "./RunnerHub.ts";

/** The runner boot id of a `lost` for a runner this server boot never saw. */
const UNATTACHED = "unattached";

/**
 * Turns runner facts into `sandbox.runner.attached` and `.lost` on the owner thread's stream. It
 * lives here, not in the hub, because sandbox effects call the hub and the hub must not need the
 * orchestrator.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const hub = yield* RunnerHub;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;

    const dispatch = Effect.fn("RunnerHubFacts.dispatch")(
      function* (fact: RunnerHubFact) {
        const record = yield* projections.getSandbox(fact.sandboxId);
        if (record === null) {
          return yield* Effect.logInfo("runner fact for an unknown sandbox dropped");
        }
        // Stale generations are harmless (04 §1); the decider would refuse them anyway.
        if (fact.generation < record.generation) {
          return yield* Effect.logInfo("runner fact for a stale generation dropped", {
            current: record.generation,
          });
        }
        const fields = {
          threadId: record.ownerThreadId,
          sandboxId: fact.sandboxId,
          generation: fact.generation,
          runnerBootId: fact.runnerBootId,
        };
        const id = `${fact.sandboxId}:${fact.generation}:${fact.runnerBootId}`;
        const command: OrchestrationV2ServerCommand =
          fact._tag === "attached"
            ? {
                type: "sandbox.runner.attached",
                commandId: CommandId.make(`sandbox-attached:${id}`),
                ...fields,
              }
            : {
                type: "sandbox.runner.lost",
                commandId: CommandId.make(`sandbox-lost:${id}`),
                ...fields,
              };
        // A receipt drops a replayed fact; one the decider already rejected was delivered too.
        yield* orchestrator
          .dispatch(command)
          .pipe(
            Effect.catchTags({ OrchestratorCommandPreviouslyRejectedError: () => Effect.void }),
          );
      },
      (effect, fact) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("sandbox.runner-fact.dispatch-failed", { cause }),
          ),
          Effect.annotateLogs({
            sandboxId: fact.sandboxId,
            generation: fact.generation,
            fact: fact._tag,
          }),
        ),
    );

    // After a restart the hub knows no runner: a ready sandbox whose runner does not dial back
    // within the lease is lost, as one that dropped would be.
    const awaitReturn = Effect.fn("RunnerHubFacts.awaitReturn")(function* (
      sandbox: OrchestrationV2Sandbox,
    ) {
      yield* hub.connection(sandbox.id).pipe(
        Effect.asVoid,
        Effect.catchTags({
          RunnerLostError: () => Effect.void,
          RunnerUnavailableError: () =>
            dispatch({
              _tag: "lost",
              sandboxId: sandbox.id,
              generation: sandbox.generation,
              runnerBootId: UNATTACHED,
              reason: "lease-expired",
            }),
        }),
      );
    });
    const awaitReadyRunners = listLiveSandboxes().pipe(
      Effect.flatMap((sandboxes) =>
        Effect.forEach(
          sandboxes.filter((sandbox) => sandbox.state === "ready" && sandbox.runnerLostAt === null),
          awaitReturn,
          { concurrency: "unbounded", discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("sandbox.runner-return.check-failed", { cause }),
      ),
    );

    yield* forkParked(
      Effect.all([Stream.runForEach(hub.facts, dispatch), awaitReadyRunners], {
        concurrency: "unbounded",
        discard: true,
      }),
    );
  }),
);
