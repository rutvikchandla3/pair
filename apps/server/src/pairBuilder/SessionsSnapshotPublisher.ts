import {
  isListedThreadLineage,
  type MemberId,
  type OrchestrationV2ConversationMessage,
  type ThreadId,
} from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type * as Members from "../persistence/Members.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as TeamState from "../team/TeamState.ts";
import { buildSessionsSnapshot } from "./SessionsSnapshot.ts";

// A burst of changes (create, name, start streaming) sends one snapshot.
const DEBOUNCE_MS = 250;
const MIN_INTERVAL_MS = 1_000;
const HEARTBEAT = Duration.seconds(30);
const REQUEST_TIMEOUT = Duration.seconds(5);
const RETRY_BASE = Duration.seconds(1);
const RETRY_MAX = Duration.seconds(30);

const retryDelay = (failures: number) =>
  Duration.min(RETRY_MAX, Duration.times(RETRY_BASE, 2 ** Math.min(failures - 1, 16)));

/**
 * Posts the workspace project's sessions to the Pair Builder (`PAIR_BUILDER_EVENTS_URL`), so its
 * chat list, task status and idle parking follow the threads. Best effort: it never blocks a
 * change, and a Builder that is down only delays the next snapshot.
 */
export class SessionsSnapshotPublisher extends Context.Service<
  SessionsSnapshotPublisher,
  {
    /** Publishes for the scope's lifetime; does nothing outside host mode or without an events URL. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/pairBuilder/SessionsSnapshotPublisher") {}

/** What a person typed, with composer references reduced to their labels. */
const visibleText = (message: OrchestrationV2ConversationMessage) =>
  replaceComposerContextReferences(message.text, (reference) => reference.label).trim();

const creatorOf = (
  members: ReadonlyMap<MemberId, Members.MemberRecord>,
  ownerId: MemberId | null | undefined,
) => {
  const member = ownerId == null ? undefined : members.get(ownerId);
  return member?.pairBuilderUserId == null
    ? null
    : { id: member.pairBuilderUserId, name: member.name };
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const teamState = yield* TeamState.TeamState;
  const sessions = yield* SessionStore.SessionStore;
  const http = yield* HttpClient.HttpClient;
  // A thread's first message never changes once sent, so each is read once.
  const firstMessages = new Map<ThreadId, string>();

  // Once per listed thread per snapshot, inside the snapshot's span.
  const firstMessageOf = Effect.fnUntraced(function* (threadId: ThreadId) {
    const cached = firstMessages.get(threadId);
    if (cached !== undefined) return cached;
    const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageRoles: ["user"],
    });
    const first = messages
      .filter((message) => message.createdBy === "user" && message.notification === undefined)
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
      )[0];
    const text = first === undefined ? "" : visibleText(first);
    if (text.length > 0) firstMessages.set(threadId, text);
    return text;
  });

  const buildSnapshot = Effect.fn("SessionsSnapshotPublisher.buildSnapshot")(function* (
    host: ServerConfig.PairBuilderHostConfig,
  ) {
    const project = yield* projects.getByWorkspaceRoot(host.workspaceRoot);
    const shells = Option.isNone(project)
      ? []
      : yield* threads
          .getShellSnapshot({ projectId: project.value.id })
          .pipe(
            Effect.map((snapshot) =>
              [...snapshot.threads, ...snapshot.archivedThreads].filter((shell) =>
                isListedThreadLineage(shell.lineage),
              ),
            ),
          );
    const listed = new Set(shells.map((shell) => shell.id));
    for (const threadId of firstMessages.keys()) {
      if (!listed.has(threadId)) firstMessages.delete(threadId);
    }
    const members = yield* Ref.get(teamState.members);
    return buildSessionsSnapshot({
      sandboxId: host.sandboxId,
      sentAt: yield* DateTime.now,
      connections: yield* sessions.connectionCount,
      threads: yield* Effect.forEach(shells, (shell) =>
        firstMessageOf(shell.id).pipe(
          Effect.map((firstMessage) => ({
            shell,
            firstMessage,
            createdBy: creatorOf(members, shell.ownerId),
          })),
        ),
      ),
    });
  });

  const deliver = Effect.fn("SessionsSnapshotPublisher.deliver")(function* (
    host: ServerConfig.PairBuilderHostConfig,
    events: NonNullable<ServerConfig.PairBuilderHostConfig["events"]>,
  ) {
    const snapshot = yield* buildSnapshot(host);
    yield* http
      .execute(
        HttpClientRequest.post(events.url).pipe(
          HttpClientRequest.bearerToken(events.token),
          HttpClientRequest.bodyJsonUnsafe(snapshot),
        ),
      )
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
  });

  // Runs for the server's lifetime, so a span around it would never end; each delivery has one.
  const publish = Effect.fnUntraced(function* (
    host: ServerConfig.PairBuilderHostConfig,
    events: NonNullable<ServerConfig.PairBuilderHostConfig["events"]>,
    changes: Queue.Queue<void>,
  ) {
    let failures = 0;
    let lastAttemptAt = Number.NEGATIVE_INFINITY;
    while (true) {
      if (failures > 0) {
        // Retries send whatever is current by then, so changes meanwhile need no extra send.
        yield* Effect.sleep(retryDelay(failures));
      } else {
        const changed = yield* Queue.take(changes).pipe(Effect.timeoutOption(HEARTBEAT));
        if (Option.isSome(changed)) {
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.sleep(
            Duration.millis(Math.max(DEBOUNCE_MS, lastAttemptAt + MIN_INTERVAL_MS - now)),
          );
        }
      }
      // The snapshot is built now, so it covers every change that woke this loop.
      yield* Queue.clear(changes);
      lastAttemptAt = yield* Clock.currentTimeMillis;
      const delivered = yield* deliver(host, events).pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.as(true),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : failures === 0
              ? Effect.logWarning(
                  "Could not send the sessions snapshot to Pair Builder; retrying with backoff.",
                  { cause },
                ).pipe(Effect.as(false))
              : Effect.succeed(false),
        ),
      );
      if (delivered && failures > 0) {
        yield* Effect.logInfo("Pair Builder accepts sessions snapshots again.", { failures });
      }
      failures = delivered ? 0 : failures + 1;
    }
  });

  const start: SessionsSnapshotPublisher["Service"]["start"] = Effect.gen(function* () {
    const host = config.pairBuilder;
    if (host?.events === undefined) return;
    const events = host.events;
    const changes = yield* Queue.sliding<void>(1);
    const notify = Queue.offer(changes, undefined);
    yield* notify;
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, () => notify).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Sessions snapshots stopped following thread changes.", { cause }),
        ),
      ),
    );
    // Connections count toward idle parking, so sockets opening and closing are changes too.
    yield* forkParked(Stream.runForEach(sessions.streamChanges, () => notify));
    yield* forkParked(publish(host, events, changes));
  });

  return SessionsSnapshotPublisher.of({ start });
});

export const layer = Layer.effect(SessionsSnapshotPublisher, make);
