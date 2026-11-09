import {
  CommandId,
  type OrchestrationV2Sandbox,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../../serverActivation.ts";
import { ComputeDriverRegistry } from "../compute/ComputeDriverRegistry.ts";
import { listLiveSandboxes } from "../lifecycle/SandboxProjection.ts";
import { type RunnerDrop, RunnerHub, type RunnerHubFact } from "./RunnerHub.ts";

/** The runner boot id of a `lost` for a runner this server boot never saw. */
const UNATTACHED = "unattached";
/** A container that is stopping still reports running for a moment after its runner's socket ends. */
const DROP_SETTLE = Duration.seconds(5);
const STATUS_BOUND = Duration.seconds(10);

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
    const registry = yield* ComputeDriverRegistry;

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

    /**
     * A dropped runner whose machine is no longer running is lost now, not at the lease's end. A
     * running one keeps the lease, which covers network blips and runner restarts.
     */
    const verdict = Effect.fn("RunnerHubFacts.verdict")(
      function* (drop: RunnerDrop) {
        yield* Effect.sleep(DROP_SETTLE);
        const record = yield* projections.getSandbox(drop.sandboxId);
        if (
          record === null ||
          record.state !== "ready" ||
          record.generation !== drop.generation ||
          record.runnerLostAt !== null ||
          record.driverRef === null
        ) {
          return Option.none<RunnerHubFact>();
        }
        const driver = yield* registry.get(record.driverId);
        const backend = yield* driver.status(record.driverRef).pipe(Effect.timeout(STATUS_BOUND));
        if (backend.status === "running" || backend.status === "starting") {
          return Option.none<RunnerHubFact>();
        }
        return Option.some<RunnerHubFact>({ _tag: "lost", ...drop, reason: "lease-expired" });
      },
      (effect, drop) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("sandbox.runner-drop.status-failed", { cause }).pipe(
              Effect.as(Option.none<RunnerHubFact>()),
            ),
          ),
          Effect.annotateLogs({ sandboxId: drop.sandboxId, generation: drop.generation }),
        ),
    );
    // Verdicts run at once and dispatch in drop order.
    const loseStoppedRunners = hub.drops.pipe(
      Stream.mapEffect(verdict, { concurrency: "unbounded" }),
      Stream.runForEach((fact) => (Option.isSome(fact) ? dispatch(fact.value) : Effect.void)),
    );

    yield* forkParked(
      Effect.all([Stream.runForEach(hub.facts, dispatch), awaitReadyRunners, loseStoppedRunners], {
        concurrency: "unbounded",
        discard: true,
      }),
    );
  }),
);
