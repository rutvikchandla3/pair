// @effect-diagnostics nodeBuiltinImport:off -- sandbox paths are POSIX on every server.
import * as NodePath from "node:path";

import type {
  MemberId,
  OrchestrationV2Sandbox,
  OrchestrationV2StoredEvent,
  SandboxAccessAudience,
  SandboxAccessChange,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { listSandboxes } from "../sandbox/lifecycle/SandboxProjection.ts";
import {
  SANDBOX_ROOT,
  sandboxIdFromPath,
  WorkspaceHostUnavailableError,
} from "../workspaceHost/WorkspaceHost.ts";
import * as TeamState from "./TeamState.ts";

/** One machine's audience as the rule reads it. A record with no `access` is `team`. */
export interface SandboxAccessEntry {
  readonly ownerMemberId: MemberId | null;
  readonly audience: SandboxAccessAudience;
  readonly memberIds: ReadonlySet<MemberId>;
}

/** What the rule needs from the server, built once so a check allocates nothing. */
export interface ThreadAccessRoster {
  readonly cloudOnly: boolean;
  /** Holds what has no owner (solo servers), as `holderOf` says. */
  readonly serverOwnerId: MemberId;
  readonly isActive: (memberId: MemberId) => boolean;
}

export interface ThreadAccessTarget {
  readonly sandboxId?: SandboxId | undefined;
  readonly ownerId?: MemberId | null | undefined;
}

/**
 * Whether a member can open a machine's threads. No role is in the rule: an admin or the
 * server's owner gets only what they were given. Off a cloud-only server it is not consulted.
 */
export const sandboxAllows = (
  roster: ThreadAccessRoster,
  entry: SandboxAccessEntry | undefined,
  memberId: MemberId,
): boolean => {
  if (!roster.cloudOnly) return true;
  if (!roster.isActive(memberId) || entry === undefined) return false;
  return (
    entry.audience === "team" ||
    (entry.ownerMemberId ?? roster.serverOwnerId) === memberId ||
    entry.memberIds.has(memberId)
  );
};

/** A thread with no machine is its owner's alone, and everyone's when it has no owner. */
export const threadAllows = (
  roster: ThreadAccessRoster,
  thread: ThreadAccessTarget,
  entry: SandboxAccessEntry | undefined,
  memberId: MemberId,
): boolean => {
  if (!roster.cloudOnly) return true;
  if (thread.sandboxId !== undefined && entry !== undefined) {
    return sandboxAllows(roster, entry, memberId);
  }
  if (!roster.isActive(memberId)) return false;
  if (thread.sandboxId === undefined) return thread.ownerId == null || thread.ownerId === memberId;
  // A machine the index has never seen: only the thread's holder.
  return (thread.ownerId ?? roster.serverOwnerId) === memberId;
};

const entryOf = (record: OrchestrationV2Sandbox): SandboxAccessEntry => ({
  ownerMemberId: record.ownerMemberId,
  audience: record.access?.audience ?? "team",
  memberIds: new Set(record.access?.memberIds),
});

/** Every machine's audience, kept by `EventSink`. Only `ThreadAccess` reads it. */
export class ThreadAccessIndex extends Context.Service<
  ThreadAccessIndex,
  {
    readonly entries: ReadonlyMap<SandboxId, SandboxAccessEntry>;
    /** `EventSink` only: runs after a commit and before any stream can publish it. */
    readonly observeCommitted: (
      events: ReadonlyArray<OrchestrationV2StoredEvent>,
    ) => Effect.Effect<void>;
    readonly changes: Stream.Stream<SandboxAccessChange>;
  }
>()("t3/team/ThreadAccess/ThreadAccessIndex") {}

export const layerIndex = Layer.effect(
  ThreadAccessIndex,
  Effect.gen(function* () {
    const entries = new Map<SandboxId, SandboxAccessEntry>();
    for (const record of yield* listSandboxes().pipe(Effect.orDie)) {
      entries.set(record.id, entryOf(record));
    }
    const changes = yield* PubSub.unbounded<SandboxAccessChange>();
    return ThreadAccessIndex.of({
      entries,
      // Runs on every commit; the commit that calls it owns the span.
      observeCommitted: Effect.fnUntraced(function* (events) {
        for (const { event } of events) {
          if (event.type === "sandbox.updated") {
            entries.set(event.payload.id, entryOf(event.payload));
          } else if (event.type === "sandbox.access-changed") {
            yield* PubSub.publish(changes, event.payload);
          }
        }
      }),
      changes: Stream.fromPubSub(changes),
    });
  }),
);

/** Who can open which cloud session. Members only: guests and tokens keep their own rules. */
export class ThreadAccess extends Context.Service<
  ThreadAccess,
  {
    readonly allowsSandbox: (memberId: MemberId, sandboxId: SandboxId) => boolean;
    readonly allowsThread: (memberId: MemberId, thread: ThreadAccessTarget) => boolean;
    /** Fails as a missing thread does, so a refusal does not confirm the thread exists. */
    readonly assertThread: (
      memberId: MemberId,
      threadId: ThreadId,
    ) => Effect.Effect<void, ProjectionStore.ProjectionStoreV2Error>;
    /** Fails as a path on a machine that is not there does. Paths outside the sandbox root pass. */
    readonly assertPath: (
      memberId: MemberId,
      path: string,
    ) => Effect.Effect<void, WorkspaceHostUnavailableError>;
    /** One item per committed `sandbox.access-changed`, after `allowsSandbox` reflects it. */
    readonly changes: Stream.Stream<SandboxAccessChange>;
  }
>()("t3/team/ThreadAccess") {}

export const layer = Layer.effect(
  ThreadAccess,
  Effect.gen(function* () {
    const index = yield* ThreadAccessIndex;
    const team = yield* TeamState.TeamState;
    const { cloudOnly } = yield* ServerConfig.ServerConfig;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const roster: ThreadAccessRoster = {
      cloudOnly,
      serverOwnerId: team.ownerId,
      isActive: (memberId) => Ref.getUnsafe(team.members).get(memberId)?.removedAt === null,
    };
    const allowsSandbox = (memberId: MemberId, sandboxId: SandboxId) =>
      sandboxAllows(roster, index.entries.get(sandboxId), memberId);
    const allowsThread = (memberId: MemberId, thread: ThreadAccessTarget) =>
      threadAllows(
        roster,
        thread,
        thread.sandboxId === undefined ? undefined : index.entries.get(thread.sandboxId),
        memberId,
      );

    const assertThread = Effect.fn("ThreadAccess.assertThread")(function* (
      memberId: MemberId,
      threadId: ThreadId,
    ) {
      if (!cloudOnly) return;
      const thread = yield* projections.getThread(threadId);
      if (allowsThread(memberId, thread)) return;
      yield* Effect.logWarning("access_denied", {
        memberId,
        threadId,
        sandboxId: thread.sandboxId,
      });
      return yield* new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId });
    });

    const assertPath = Effect.fn("ThreadAccess.assertPath")(function* (
      memberId: MemberId,
      path: string,
    ) {
      if (!cloudOnly) return;
      const resolved = NodePath.posix.resolve(path);
      if (resolved !== SANDBOX_ROOT && !resolved.startsWith(`${SANDBOX_ROOT}/`)) return;
      const sandboxId = sandboxIdFromPath(resolved);
      if (sandboxId !== undefined && allowsSandbox(memberId, sandboxId)) return;
      yield* Effect.logWarning("access_denied", { memberId, sandboxId });
      return yield* new WorkspaceHostUnavailableError(sandboxId === undefined ? {} : { sandboxId });
    });

    return ThreadAccess.of({
      allowsSandbox,
      allowsThread,
      assertThread,
      assertPath,
      changes: index.changes,
    });
  }),
).pipe(Layer.provide(layerIndex));
