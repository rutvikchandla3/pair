import { CommandId, type MemberId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import { SandboxActivity } from "./SandboxActivity.ts";
import { sandboxAttachedThread } from "./SandboxDecisions.ts";
import { SandboxWake } from "./SandboxWakeService.ts";

export const layer = Layer.effect(
  SandboxWake,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const activity = yield* SandboxActivity;
    const intake =
      yield* Effect.context<
        Effect.Services<ReturnType<typeof ThreadMessageIntake.dispatchSandboxCommand>>
      >();

    const wakeThread = Effect.fn("SandboxWake.wakeThread")(
      function* (threadId: ThreadId, actorId: MemberId | undefined, unlessResting: boolean) {
        const shell = yield* projections.getThreadShell(threadId);
        if (shell?.sandboxId === undefined) return;
        if (unlessResting) {
          const { archived, settled } = sandboxAttachedThread(shell);
          if (archived || settled) return;
        }
        const record = yield* projections.getSandbox(shell.sandboxId);
        if (record?.state !== "sleeping") return;
        // `sandbox.request-wake`'s id, so every trigger in one generation makes one wake.
        yield* ThreadMessageIntake.dispatchSandboxCommand({
          type: "sandbox.wake",
          commandId: CommandId.make(
            `sandbox-wake:${record.id}:${record.ownerThreadId}:${record.generation}`,
          ),
          threadId,
          sandboxId: record.id,
          ...(actorId === undefined ? {} : { actorId }),
        }).pipe(Effect.provideContext(intake));
      },
      (effect, threadId) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not wake a thread's machine", { threadId, cause }),
          ),
        ),
    );

    return SandboxWake.of({
      wake: Effect.fn("SandboxWake.wake")(function* ({ threadId, actorId }) {
        yield* wakeThread(threadId, actorId, false);
      }),
      viewed: Effect.fn("SandboxWake.viewed")(function* ({ threadId, actorId }) {
        if (!(yield* activity.view(threadId))) return;
        yield* wakeThread(threadId, actorId, true);
      }),
    });
  }),
);
