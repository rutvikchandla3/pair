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
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { isThreadPayloadEvent } from "../orchestration-v2/MemberThreadState.ts";
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

const TEAM_ENTRY: SandboxAccessEntry = {
  ownerMemberId: null,
  audience: "team",
  memberIds: new Set(),
};

/** A thread's session as `threadAllows` reads it, so a thread with no known machine compares too. */
export const sessionEntryOf = (
  thread: ThreadAccessTarget,
  entry: SandboxAccessEntry | undefined,
): SandboxAccessEntry => {
  if (thread.sandboxId !== undefined && entry !== undefined) return entry;
  if (thread.sandboxId === undefined && thread.ownerId == null) return TEAM_ENTRY;
  return { ownerMemberId: thread.ownerId ?? null, audience: "members", memberIds: new Set() };
};

/**
 * Whether an agent in session `from` may list, read or message session `to`: only when every
 * member who can open `from` can open `to`, so a prompt cannot reach past its readers. `team`
 * reaches only `team`. The owner always counts; a listed member only while active.
 */
export const sessionReaches = (
  roster: ThreadAccessRoster,
  from: SandboxAccessEntry,
  to: SandboxAccessEntry,
): boolean => {
  if (!roster.cloudOnly || from === to || to.audience === "team") return true;
  if (from.audience === "team") return false;
  if (!sandboxAllows(roster, to, from.ownerMemberId ?? roster.serverOwnerId)) return false;
  for (const memberId of from.memberIds) {
    if (roster.isActive(memberId) && !sandboxAllows(roster, to, memberId)) return false;
  }
  return true;
};

/** A guest link lets someone outside the list in, so on a `members` session only its owner may. */
const guestInviteAllowed = (
  roster: ThreadAccessRoster,
  session: SandboxAccessEntry,
  memberId: MemberId,
): boolean =>
  !roster.cloudOnly ||
  session.audience === "team" ||
  (session.ownerMemberId ?? roster.serverOwnerId) === memberId;

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
    /** Each thread's machine and owner, once `trackThreads` has run. Deleted threads stay. */
    readonly threads: ReadonlyMap<ThreadId, ThreadAccessTarget>;
    /** Loads `threads` and keeps it current. Cloud-only servers only; others never read it. */
    readonly trackThreads: Effect.Effect<void>;
    /**
     * `EventSink`'s publish lane: a commit holds it from before COMMIT until it has published.
     * Taking it once after a read means every commit that read saw is indexed.
     */
    readonly lane: Semaphore.Semaphore;
    /** `EventSink` only: runs after a commit and before any stream can publish it. */
    readonly observeCommitted: (
      events: ReadonlyArray<OrchestrationV2StoredEvent>,
    ) => Effect.Effect<void>;
    readonly changes: Stream.Stream<SandboxAccessChange>;
    readonly subscribeChanges: Effect.Effect<
      PubSub.Subscription<SandboxAccessChange>,
      never,
      Scope.Scope
    >;
  }
>()("t3/team/ThreadAccess/ThreadAccessIndex") {}

export const layerIndex = Layer.effect(
  ThreadAccessIndex,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const entries = new Map<SandboxId, SandboxAccessEntry>();
    for (const record of yield* listSandboxes().pipe(Effect.orDie)) {
      entries.set(record.id, entryOf(record));
    }
    const threads = new Map<ThreadId, ThreadAccessTarget>();
    let tracking = false;
    const changes = yield* PubSub.unbounded<SandboxAccessChange>();
    return ThreadAccessIndex.of({
      entries,
      threads,
      trackThreads: Effect.gen(function* () {
        if (tracking) return;
        // Track first, so a commit the load misses is observed; the load never overwrites one.
        tracking = true;
        const rows = yield* sql<{
          readonly thread_id: ThreadId;
          readonly sandbox_id: SandboxId | null;
          readonly owner_id: MemberId | null;
        }>`
          SELECT thread_id,
            json_extract(payload_json, '$.sandboxId') AS sandbox_id,
            json_extract(payload_json, '$.ownerId') AS owner_id
          FROM orchestration_v2_projection_threads
        `.pipe(Effect.orDie);
        for (const row of rows) {
          if (threads.has(row.thread_id)) continue;
          threads.set(row.thread_id, {
            ...(row.sandbox_id === null ? {} : { sandboxId: row.sandbox_id }),
            ownerId: row.owner_id,
          });
        }
      }).pipe(Effect.withSpan("ThreadAccessIndex.trackThreads")),
      lane: yield* Semaphore.make(1),
      // Runs on every commit; the commit that calls it owns the span.
      observeCommitted: Effect.fnUntraced(function* (events) {
        for (const { event } of events) {
          if (event.type === "sandbox.updated") {
            entries.set(event.payload.id, entryOf(event.payload));
          } else if (event.type === "sandbox.access-changed") {
            yield* PubSub.publish(changes, event.payload);
          } else if (tracking && isThreadPayloadEvent(event)) {
            const { id, sandboxId, ownerId } = event.payload;
            const known = threads.get(id);
            if (
              known === undefined ||
              known.sandboxId !== sandboxId ||
              (known.ownerId ?? null) !== (ownerId ?? null)
            ) {
              threads.set(id, { sandboxId, ownerId });
            }
          }
        }
      }),
      changes: Stream.fromPubSub(changes),
      subscribeChanges: PubSub.subscribe(changes),
    });
  }),
);

/** Who can open which cloud session. Members only: guests and tokens keep their own rules. */
export class ThreadAccess extends Context.Service<
  ThreadAccess,
  {
    /** The server is cloud-only, so the rule is consulted. Elsewhere every check passes. */
    readonly enforced: boolean;
    readonly allowsSandbox: (memberId: MemberId, sandboxId: SandboxId) => boolean;
    readonly allowsThread: (memberId: MemberId, thread: ThreadAccessTarget) => boolean;
    /** `guestInviteAllowed` for the thread's session. */
    readonly mayInviteGuest: (memberId: MemberId, thread: ThreadAccessTarget) => boolean;
    /** `sessionReaches` from the agent's thread, which the index must know. */
    readonly agentReaches: (agentThreadId: ThreadId, thread: ThreadAccessTarget) => boolean;
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
    /** A thread's machine and owner as last committed; undefined for one never seen. */
    readonly threadTarget: (threadId: ThreadId) => ThreadAccessTarget | undefined;
    /**
     * Waits until every commit already visible to the database is indexed. A read that goes to
     * the database runs this after reading and before checking what it read.
     */
    readonly caughtUp: Effect.Effect<void>;
    /** One item per committed `sandbox.access-changed`, after `allowsSandbox` reflects it. */
    readonly changes: Stream.Stream<SandboxAccessChange>;
    readonly subscribeChanges: Effect.Effect<
      PubSub.Subscription<SandboxAccessChange>,
      never,
      Scope.Scope
    >;
  }
>()("t3/team/ThreadAccess") {}

/**
 * `ThreadAccess` for a reader built where a test layer may leave it out. Off a cloud-only server
 * that reads as nothing enforced; on one it is a defect, never "everyone sees everything".
 */
export const optional = Effect.gen(function* () {
  const access = yield* Effect.serviceOption(ThreadAccess);
  if (Option.isSome(access)) return access.value;
  if ((yield* ServerConfig.ServerConfig).cloudOnly) {
    return yield* Effect.die(new Error("A cloud-only server needs ThreadAccess."));
  }
  return undefined;
});

export const layer = Layer.effect(
  ThreadAccess,
  Effect.gen(function* () {
    const index = yield* ThreadAccessIndex;
    const team = yield* TeamState.TeamState;
    const { cloudOnly } = yield* ServerConfig.ServerConfig;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    if (cloudOnly) yield* index.trackThreads;
    const roster: ThreadAccessRoster = {
      cloudOnly,
      serverOwnerId: team.ownerId,
      isActive: (memberId) => Ref.getUnsafe(team.members).get(memberId)?.removedAt === null,
    };
    const caughtUp = index.lane.withPermits(1)(Effect.void);
    const allowsSandbox = (memberId: MemberId, sandboxId: SandboxId) =>
      sandboxAllows(roster, index.entries.get(sandboxId), memberId);
    const allowsThread = (memberId: MemberId, thread: ThreadAccessTarget) =>
      threadAllows(
        roster,
        thread,
        thread.sandboxId === undefined ? undefined : index.entries.get(thread.sandboxId),
        memberId,
      );
    const sessionOf = (thread: ThreadAccessTarget) =>
      sessionEntryOf(
        thread,
        thread.sandboxId === undefined ? undefined : index.entries.get(thread.sandboxId),
      );
    const agentReaches = (agentThreadId: ThreadId, thread: ThreadAccessTarget) => {
      if (!cloudOnly) return true;
      const agent = index.threads.get(agentThreadId);
      return agent !== undefined && sessionReaches(roster, sessionOf(agent), sessionOf(thread));
    };

    const assertThread = Effect.fn("ThreadAccess.assertThread")(function* (
      memberId: MemberId,
      threadId: ThreadId,
    ) {
      if (!cloudOnly) return;
      const thread = yield* projections.getThread(threadId);
      // The read can see a commit the index has not yet observed.
      yield* caughtUp;
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
      enforced: cloudOnly,
      allowsSandbox,
      allowsThread,
      mayInviteGuest: (memberId, thread) => guestInviteAllowed(roster, sessionOf(thread), memberId),
      agentReaches,
      assertThread,
      assertPath,
      threadTarget: (threadId) => index.threads.get(threadId),
      caughtUp,
      changes: index.changes,
      subscribeChanges: index.subscribeChanges,
    });
  }),
).pipe(Layer.provide(layerIndex));

/**
 * A thread's machine and owner, waiting for commits in flight only when the index has not seen it:
 * a known thread costs a map lookup, and only an unknown one waits before it is refused.
 */
export const resolveThreadTarget = (
  access: ThreadAccess["Service"],
  threadId: ThreadId,
): Effect.Effect<ThreadAccessTarget | undefined> => {
  const known = access.threadTarget(threadId);
  return known === undefined
    ? Effect.map(access.caughtUp, () => access.threadTarget(threadId))
    : Effect.succeed(known);
};

export interface ThreadAccessTestOptions {
  readonly serverOwnerId: MemberId;
  readonly machines?: ReadonlyMap<SandboxId, SandboxAccessEntry>;
  readonly threads?: ReadonlyMap<ThreadId, ThreadAccessTarget>;
  readonly changes?: PubSub.PubSub<SandboxAccessChange>;
}

/**
 * For tests. Without options, a server that is not cloud-only, where every check passes; with
 * them, the rule enforced over fixed machines and threads, every member active.
 */
export const makeTest = (options?: ThreadAccessTestOptions): ThreadAccess["Service"] => {
  if (options === undefined) {
    return {
      enforced: false,
      allowsSandbox: () => true,
      allowsThread: () => true,
      mayInviteGuest: () => true,
      agentReaches: () => true,
      assertThread: () => Effect.void,
      assertPath: () => Effect.void,
      threadTarget: () => undefined,
      caughtUp: Effect.void,
      changes: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<SandboxAccessChange>(), PubSub.subscribe),
    };
  }
  const { machines = new Map(), threads = new Map(), changes } = options;
  const roster: ThreadAccessRoster = {
    cloudOnly: true,
    serverOwnerId: options.serverOwnerId,
    isActive: () => true,
  };
  const allowsSandbox = (memberId: MemberId, sandboxId: SandboxId) =>
    sandboxAllows(roster, machines.get(sandboxId), memberId);
  const allowsThread = (memberId: MemberId, thread: ThreadAccessTarget) =>
    threadAllows(
      roster,
      thread,
      thread.sandboxId === undefined ? undefined : machines.get(thread.sandboxId),
      memberId,
    );
  const sessionOf = (target: ThreadAccessTarget) =>
    sessionEntryOf(
      target,
      target.sandboxId === undefined ? undefined : machines.get(target.sandboxId),
    );
  return {
    enforced: true,
    allowsSandbox,
    allowsThread,
    mayInviteGuest: (memberId, thread) => guestInviteAllowed(roster, sessionOf(thread), memberId),
    agentReaches: (agentThreadId, thread) => {
      const agent = threads.get(agentThreadId);
      return agent !== undefined && sessionReaches(roster, sessionOf(agent), sessionOf(thread));
    },
    assertThread: (memberId, threadId) => {
      const thread = threads.get(threadId);
      return thread !== undefined && allowsThread(memberId, thread)
        ? Effect.void
        : Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }));
    },
    assertPath: () => Effect.die("unused"),
    threadTarget: (threadId) => threads.get(threadId),
    caughtUp: Effect.void,
    changes: changes === undefined ? Stream.empty : Stream.fromPubSub(changes),
    subscribeChanges:
      changes === undefined
        ? Effect.flatMap(PubSub.unbounded<SandboxAccessChange>(), PubSub.subscribe)
        : PubSub.subscribe(changes),
  };
};

export const layerTest = (options?: ThreadAccessTestOptions) =>
  Layer.succeed(ThreadAccess)(makeTest(options));
