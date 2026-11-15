import {
  CommandId,
  type MemberId,
  type OrchestrationV2CreationSource,
  SandboxForkError,
  type SandboxForkInput,
  type ThreadId,
} from "@t3tools/contracts";
import { canCopyMachine } from "@t3tools/shared/sandbox";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { isForkableSourceRunStatus } from "../../orchestration-v2/ThreadForkService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as TeamState from "../../team/TeamState.ts";
import { ComputeDriverRegistry } from "../compute/ComputeDriverRegistry.ts";
import { SandboxCheckoutRoot, sandboxIdForLaunch } from "./CloudPreparation.ts";

export interface SandboxForkRequest extends SandboxForkInput {
  readonly actorId?: MemberId | undefined;
  readonly createdBy: "user" | "agent";
  readonly creationSource: OrchestrationV2CreationSource;
}

export class SandboxFork extends Context.Service<
  SandboxFork,
  {
    /**
     * Forks a cloud thread onto a new machine whose first boot copies the source machine's disk.
     * Replaying the same `commandId` lands on the same thread and machine.
     */
    readonly fork: (
      input: SandboxForkRequest,
    ) => Effect.Effect<
      { readonly threadId: ThreadId; readonly sequence: number },
      SandboxForkError
    >;
  }
>()("t3/sandbox/lifecycle/SandboxFork") {}

export const layer = Layer.effect(
  SandboxFork,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const registry = yield* ComputeDriverRegistry;
    const team = yield* Effect.serviceOption(TeamState.TeamState);
    const refuse = (reason: SandboxForkError["reason"]) => new SandboxForkError({ reason });
    const unavailable = (cause: unknown) => new SandboxForkError({ reason: "unavailable", cause });

    return SandboxFork.of({
      fork: Effect.fn("SandboxFork.fork")(function* (input) {
        const { thread: source, runs } = yield* threads
          .getThreadRecords(input.sourceThreadId, ["runs"])
          .pipe(Effect.mapError(unavailable));
        if (source.sandboxId === undefined) return yield* refuse("no-machine");
        // Fork stays the owner's tool; anyone else branches off instead.
        const holder = source.ownerId ?? Option.getOrUndefined(team)?.ownerId;
        if (input.actorId !== undefined && holder !== undefined && input.actorId !== holder) {
          return yield* refuse("not-owner");
        }
        const record = yield* projections
          .getSandbox(source.sandboxId)
          .pipe(Effect.mapError(unavailable));
        if (record === null || record.state === "destroyed" || record.driverRef === null) {
          return yield* refuse("machine-gone");
        }
        const driver = yield* registry.get(record.driverId).pipe(Effect.mapError(unavailable));
        if (!canCopyMachine(driver.kind)) return yield* refuse("unsupported");
        if (source.roots !== undefined) return yield* refuse("workspace");
        if (source.branch === null || source.worktreePath === null) {
          return yield* refuse("no-branch");
        }
        if (runs.some(ThreadManagement.isActiveRun)) return yield* refuse("turn-running");
        // The disk is copied as it is now, so the conversation forks from its latest settled turn.
        const sourceRun = runs
          .toSorted((left, right) => right.ordinal - left.ordinal)
          .find((run) => isForkableSourceRunStatus(run.status));
        if (sourceRun === undefined) return yield* refuse("no-turn");

        const checkoutRoot = yield* SandboxCheckoutRoot;
        const sourceRoot = checkoutRoot(record.id);
        const forkId = sandboxIdForLaunch(input.commandId);
        // The copied disk keeps the source's paths; the adopt step moves them under the fork's root.
        const worktreePath = source.worktreePath.startsWith(`${sourceRoot}/`)
          ? `${checkoutRoot(forkId)}${source.worktreePath.slice(sourceRoot.length)}`
          : source.worktreePath;
        const branch = input.branch ?? `${source.branch}-fork`;

        yield* threads
          .dispatch({
            type: "thread.fork",
            commandId: input.commandId,
            sourceThreadId: source.id,
            targetThreadId: input.threadId,
            sourcePoint: { type: "run", runId: sourceRun.id },
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
            createdBy: input.createdBy,
            creationSource: input.creationSource,
            ownMachine: { branch, worktreePath },
          })
          .pipe(Effect.mapError(unavailable));
        const provisioned = yield* threads
          .dispatch({
            type: "sandbox.provision",
            commandId: CommandId.make(`${input.commandId}:sandbox`),
            threadId: input.threadId,
            sandboxId: forkId,
            projectId: source.projectId,
            driverId: record.driverId,
            size: input.size,
            copyOf: record.id,
            ...(record.imageBuild === undefined ? {} : { imageBuild: record.imageBuild }),
          })
          .pipe(Effect.mapError(unavailable));
        return { threadId: input.threadId, sequence: provisioned.sequence };
      }),
    });
  }),
);
