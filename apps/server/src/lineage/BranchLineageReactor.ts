import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { BranchLineageService } from "./BranchLineageService.ts";

/**
 * Keeps lineage records current after commits elsewhere: a checkpoint (ahead, behind, the open
 * Update), the source's state, and who can still reach it. Off the hot path: one worker, and only
 * threads already in a lineage get any work.
 */
export class BranchLineageReactor extends Context.Service<
  BranchLineageReactor,
  {
    readonly drain: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/lineage/BranchLineageReactor") {}

type Work =
  | { readonly type: "checkpoint"; readonly threadId: ThreadId }
  | { readonly type: "source"; readonly threadId: ThreadId }
  | { readonly type: "access"; readonly threadId: ThreadId };

const SOURCE_EVENTS: ReadonlySet<OrchestrationV2DomainEvent["type"]> = new Set([
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.settled",
  "thread.unsettled",
  "thread.metadata-updated",
  "thread.pull-request-synced",
]);

const make = Effect.gen(function* () {
  const service = yield* BranchLineageService;
  const projections = yield* ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const inLineage = Effect.fn("BranchLineageReactor.inLineage")(function* (threadId: ThreadId) {
    if ((yield* projections.getBranchLineage(threadId)) !== null) return true;
    if ((yield* projections.listBranchesOf(threadId)).length > 0) return true;
    return (yield* projections.listOffersForSource(threadId, 1)).length > 0;
  });

  const handle = Effect.fnUntraced(function* (work: Work) {
    switch (work.type) {
      case "checkpoint":
        if (yield* inLineage(work.threadId)) yield* service.afterCheckpoint(work.threadId);
        return;
      case "source":
        yield* service.sourceChanged(work.threadId);
        return;
      case "access":
        yield* service.accessChanged(work.threadId);
        return;
    }
  });

  const worker = yield* makeDrainableWorker((work: Work) =>
    handle(work).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not update a lineage after a change", { work, cause }),
      ),
    ),
  );

  const route = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    if (event.type === "checkpoint.captured") {
      if (event.payload.runId !== null)
        yield* worker.enqueue({ type: "checkpoint", threadId: event.threadId });
      return;
    }
    if (SOURCE_EVENTS.has(event.type)) {
      yield* worker.enqueue({ type: "source", threadId: event.threadId });
      return;
    }
    if (event.type === "sandbox.access-changed" && event.payload.removed.length > 0) {
      const attached = yield* projections
        .listSandboxThreads(event.payload.sandboxId)
        .pipe(Effect.orElseSucceed(() => []));
      for (const row of attached) yield* worker.enqueue({ type: "access", threadId: row.threadId });
    }
  });

  const start = Effect.fn("BranchLineageReactor.start")(function* () {
    yield* forkParked(Stream.runForEach(threads.streamDomainEvents, route));
  });

  return BranchLineageReactor.of({ drain: worker.drain, start });
});

export const layer = Layer.effect(BranchLineageReactor, make);
