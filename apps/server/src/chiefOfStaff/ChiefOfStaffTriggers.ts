import {
  CommandId,
  isListedThreadLineage,
  MemberId,
  MessageId,
  type OrchestrationV2ShellThreadStatus,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ServerConfig from "../config.ts";
import * as ProjectStoreV2 from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadAccess from "../team/ThreadAccess.ts";
import { ChiefOfStaffHost } from "./ChiefOfStaffHost.ts";
import { readHomeThreads } from "./homeThreads.ts";
import {
  triggerDigest,
  type TriggerDigestEvent,
  type TriggerKind,
} from "./chiefOfStaffProtocol.ts";

/** Collapses a burst of committed changes into one snapshot read. */
const DEBOUNCE = Duration.seconds(5);
const MIN_DIGEST_INTERVAL_MS = 60_000;
const HOUR_MS = 3_600_000;
const MAX_DIGESTS_PER_HOUR = 20;

/** The part of a shell the diff keeps, so a transition can be spotted without the whole row. */
export interface TrackedThread {
  readonly threadId: string;
  readonly title: string;
  readonly projectId: string;
  readonly status: OrchestrationV2ShellThreadStatus;
  readonly pendingKind: "approval" | "answer" | null;
  /** The access rule reads the shell's machine, owner and space. */
  readonly access: ThreadAccess.ThreadAccessTarget;
}

const pendingKindOf = (shell: OrchestrationV2ThreadShell): TrackedThread["pendingKind"] =>
  shell.pendingRuntimeRequest === null
    ? null
    : shell.pendingRuntimeRequest.kind === "user_input"
      ? "answer"
      : "approval";

const trackedThread = (shell: OrchestrationV2ThreadShell): TrackedThread => ({
  threadId: String(shell.id),
  title: shell.title,
  projectId: String(shell.projectId),
  status: shell.status,
  pendingKind: pendingKindOf(shell),
  access: shell,
});

export interface ThreadTransition {
  readonly thread: TrackedThread;
  readonly kind: TriggerKind;
}

/**
 * The transitions a member should hear about, from the previous snapshot to this one. A thread
 * absent from `previous` is new: it is not a transition, and its first appearance is the baseline.
 */
export const diffTransitions = (
  previous: ReadonlyMap<string, TrackedThread>,
  current: ReadonlyArray<TrackedThread>,
): ReadonlyArray<ThreadTransition> => {
  const transitions: ThreadTransition[] = [];
  for (const thread of current) {
    const before = previous.get(thread.threadId);
    if (before === undefined) continue;
    if (before.status === "running") {
      if (thread.status === "completed") transitions.push({ thread, kind: "finished" });
      else if (thread.status === "failed") transitions.push({ thread, kind: "failed" });
      else if (thread.status === "interrupted") transitions.push({ thread, kind: "interrupted" });
    }
    if (before.pendingKind === null && thread.pendingKind !== null) {
      transitions.push({ thread, kind: thread.pendingKind });
    }
  }
  return transitions;
};

interface RateState {
  lastSentAt: number;
  windowStartAt: number;
  windowCount: number;
  dropped: number;
}

export class ChiefOfStaffTriggers extends Context.Service<
  ChiefOfStaffTriggers,
  {
    /** Watches committed changes and wakes the relevant home threads. Tied to the server's scope. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One pass: read the snapshot, diff it and deliver. Exposed so the loop and tests share it. */
    readonly flush: () => Effect.Effect<void>;
  }
>()("t3/chiefOfStaff/ChiefOfStaffTriggers") {}

const make = Effect.gen(function* () {
  const host = yield* ChiefOfStaffHost;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStoreV2.ProjectStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const access = yield* ThreadAccess.optional;
  const random = yield* SecureRandom.SecureRandom;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Only the flush loop touches these, and it runs one pass at a time.
  let previous: Map<string, TrackedThread> | undefined;
  const rates = new Map<string, RateState>();

  const readHome = readHomeThreads.pipe(
    Effect.provideService(ServerConfig.ServerConfig, config),
    Effect.provideService(Path.Path, path),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
  );

  const projectTitles = Effect.fn("ChiefOfStaffTriggers.projectTitles")(function* (
    projectIds: ReadonlyArray<string>,
  ) {
    const unique = [...new Set(projectIds)];
    if (unique.length === 0) return new Map<string, string>();
    const shells = yield* projects.listShells({
      projectIds: unique.map((id) => ProjectId.make(id)),
    });
    return new Map(shells.map((shell) => [String(shell.id), shell.title]));
  });

  const rateFor = (memberId: string, now: number): RateState => {
    const existing = rates.get(memberId);
    if (existing !== undefined) return existing;
    const created: RateState = {
      lastSentAt: Number.NEGATIVE_INFINITY,
      windowStartAt: now,
      windowCount: 0,
      dropped: 0,
    };
    rates.set(memberId, created);
    return created;
  };

  const allowsDigest = (rate: RateState, now: number): boolean => {
    if (now - rate.lastSentAt < MIN_DIGEST_INTERVAL_MS) return false;
    if (now - rate.windowStartAt >= HOUR_MS) {
      rate.windowStartAt = now;
      rate.windowCount = 0;
    }
    return rate.windowCount < MAX_DIGESTS_PER_HOUR;
  };

  const deliver = Effect.fn("ChiefOfStaffTriggers.deliver")(function* (input: {
    readonly homeThreadId: string;
    readonly events: ReadonlyArray<TriggerDigestEvent>;
    readonly dropped: number;
  }) {
    const shell = yield* threads.getThreadShell(ThreadId.make(input.homeThreadId));
    if (shell === null || shell.archivedAt != null || shell.deletedAt != null) return false;
    yield* threads.sendToThread({
      projectId: shell.projectId,
      commandId: CommandId.make(yield* random.uuidV4()),
      threadId: shell.id,
      messageId: MessageId.make(yield* random.uuidV4()),
      text: triggerDigest(input.events, input.dropped),
      attachments: [],
      // Queued: a busy home thread finishes its turn before the digest arrives.
      mode: "queue",
      createdBy: "system",
      creationSource: "server",
    });
    return true;
  });

  const flush = Effect.fn("ChiefOfStaffTriggers.flush")(function* () {
    const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
    if (
      current === undefined ||
      !(current.chiefOfStaff.enabled && current.chiefOfStaff.proactive)
    ) {
      // Off, nothing is tracked; turning it back on starts from a fresh baseline.
      previous = undefined;
      return;
    }
    const snapshot = yield* threads
      .getShellSnapshot({ location: "active" })
      .pipe(Effect.orElseSucceed(() => undefined));
    if (snapshot === undefined) return;
    const next = new Map<string, TrackedThread>();
    for (const shell of snapshot.threads) {
      if (!isListedThreadLineage(shell.lineage)) continue;
      const tracked = trackedThread(shell);
      next.set(tracked.threadId, tracked);
    }
    const before = previous;
    previous = next;
    // The first snapshot after startup is the baseline: the past is not news.
    if (before === undefined) return;

    const transitions = diffTransitions(before, [...next.values()]);
    if (transitions.length === 0) return;

    const homes = yield* readHome;
    const homeThreadIds = new Set(homes.keys());
    const relevant = transitions.filter(({ thread }) => !homeThreadIds.has(thread.threadId));
    if (relevant.length === 0) return;

    const titles = yield* projectTitles(relevant.map(({ thread }) => thread.projectId)).pipe(
      Effect.orElseSucceed(() => new Map<string, string>()),
    );
    const now = yield* Clock.currentTimeMillis;
    for (const [threadId, memberIdOfHome] of homes) {
      const memberId = MemberId.make(memberIdOfHome);
      const memberTransitions = relevant.filter(
        ({ thread }) => access === undefined || access.allowsThread(memberId, thread.access),
      );
      if (memberTransitions.length === 0) continue;
      const rate = rateFor(memberId, now);
      if (!allowsDigest(rate, now)) {
        rate.dropped += memberTransitions.length;
        continue;
      }
      const events: ReadonlyArray<TriggerDigestEvent> = memberTransitions.map(
        ({ thread, kind }) => ({
          threadId: thread.threadId,
          title: thread.title,
          project: titles.get(thread.projectId),
          kind,
        }),
      );
      const sent = yield* deliver({
        homeThreadId: threadId,
        events,
        dropped: rate.dropped,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Chief of staff could not deliver an event digest", { cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
      if (sent) {
        rate.lastSentAt = now;
        rate.windowCount += 1;
        rate.dropped = 0;
      }
    }
  });

  return ChiefOfStaffTriggers.of({
    start: Effect.fn("ChiefOfStaffTriggers.start")(function* () {
      const dirty = yield* Queue.sliding<void>(1);
      yield* Effect.forkScoped(
        Stream.runForEach(host.statusChanges, () => Queue.offer(dirty, undefined)),
      );
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            yield* Queue.take(dirty);
            yield* Effect.sleep(DEBOUNCE);
            yield* Queue.clear(dirty);
            yield* flush();
          }),
        ),
      );
    }),
    flush,
  });
});

export const layer = Layer.effect(ChiefOfStaffTriggers, make);
