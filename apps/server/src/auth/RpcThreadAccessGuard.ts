import {
  type MemberId,
  RpcThreadAccess,
  type RpcThreadTarget,
  rpcThreadTargets,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as RpcSchema from "effect/rpc/RpcSchema";

import * as ThreadAccess from "../team/ThreadAccess.ts";
import { sandboxOfPath } from "../workspaceHost/WorkspaceHosts.ts";
import { failEnvironmentNotFound } from "./http.ts";

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const isSandboxId = Schema.is(SandboxId);

interface Verdict {
  readonly allowed: boolean;
  readonly sandboxId: SandboxId | undefined;
}

/** Every server that is not cloud-only, and tests that do not exercise access. */
export const allow: RpcThreadAccess["Service"] = (effect) => effect;
export const passThrough = Layer.succeed(RpcThreadAccess)(allow);

const ALLOWED: Verdict = { allowed: true, sandboxId: undefined };
const REFUSED: Verdict = { allowed: false, sandboxId: undefined };

/**
 * One member's socket: every RPC in `RPC_THREAD_TARGETS` must name only threads, machines and
 * paths the member can open, and a stream ends when a machine it reads is no longer theirs. Only
 * a server where `ThreadAccess` is enforced (cloud-only) checks anything (11 §4).
 */
export const layer = (memberId: MemberId) =>
  Layer.effect(
    RpcThreadAccess,
    Effect.gen(function* () {
      const access = yield* ThreadAccess.ThreadAccess;
      if (!access.enforced) return allow;

      const machine = (sandboxId: string): Verdict =>
        isSandboxId(sandboxId)
          ? { allowed: access.allowsSandbox(memberId, sandboxId), sandboxId }
          : REFUSED;
      const thread = (target: ThreadAccess.ThreadAccessTarget): Verdict => ({
        allowed: access.allowsThread(memberId, target),
        sandboxId: target.sandboxId,
      });

      /** Undefined when only the index after a catch-up can answer. */
      const knownVerdict = (target: RpcThreadTarget): Verdict | undefined => {
        if ("path" in target) {
          const sandboxId = sandboxOfPath(target.path);
          if (sandboxId === "local") return ALLOWED;
          return sandboxId === undefined ? REFUSED : machine(sandboxId);
        }
        if ("sandboxId" in target) return machine(target.sandboxId);
        if ("newThreadId" in target) {
          const threadId = decodeThreadId(target.newThreadId);
          // A member learns a thread id only once it is published, by when the index has it.
          const known = Option.isSome(threadId) ? access.threadTarget(threadId.value) : undefined;
          return known === undefined ? ALLOWED : thread(known);
        }
        const threadId = decodeThreadId(target.threadId);
        if (Option.isNone(threadId)) return REFUSED;
        const known = access.threadTarget(threadId.value);
        return known === undefined ? undefined : thread(known);
      };

      const verdict = (target: RpcThreadTarget): Effect.Effect<Verdict> => {
        const known = knownVerdict(target);
        if (known !== undefined || !("threadId" in target)) return Effect.succeed(known ?? REFUSED);
        return Effect.map(access.caughtUp, () => knownVerdict(target) ?? REFUSED);
      };

      const refuse = (
        method: string,
        target: RpcThreadTarget | undefined,
        sandboxId: SandboxId | undefined,
      ) =>
        Effect.logWarning("access_denied", { memberId, method, ...target, sandboxId }).pipe(
          Effect.andThen(failEnvironmentNotFound("thread_not_found")),
        );

      return RpcThreadAccess.of((effect, { rpc, payload }) => {
        const targets = rpcThreadTargets(rpc._tag, payload);
        if (targets === undefined || targets.length === 0) return effect;
        return Effect.gen(function* () {
          // Subscribed before the checks run: a change that lands between the two still ends it.
          const streaming = RpcSchema.isStreamSchema(rpc.successSchema);
          const changes = streaming ? yield* access.subscribeChanges : undefined;
          const moves = streaming ? yield* access.subscribeMoves : undefined;
          for (const target of targets) {
            const { allowed, sandboxId } = yield* verdict(target);
            if (!allowed) return yield* refuse(rpc._tag, target, sandboxId);
          }
          if (changes === undefined || moves === undefined) return yield* effect;
          // A machine's audience, a thread's owner or a thread's machine can each take a target
          // away; every target is re-read from memory on any of them.
          const recheck = Effect.suspend(() => {
            for (const target of targets) {
              const { allowed, sandboxId } = knownVerdict(target) ?? REFUSED;
              if (!allowed) return refuse(rpc._tag, target, sandboxId);
            }
            return Effect.void;
          });
          const revoked = Effect.raceFirst(
            Effect.forever(PubSub.take(changes).pipe(Effect.andThen(recheck))),
            Effect.forever(PubSub.take(moves).pipe(Effect.andThen(recheck))),
          );
          return yield* Effect.raceFirst(effect, revoked);
        });
      });
    }),
  );
