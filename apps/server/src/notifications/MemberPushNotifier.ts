import {
  isListedThreadLineage,
  type MemberId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  shouldNotifyMember,
  TEAM_IMAGE_DEEP_LINK,
  teamImageBuildNotification,
  type ThreadNotificationEvent,
  threadNotificationTitle,
} from "@t3tools/shared/threadNotificationRouting";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { holderOf, isMemberThreadEvent } from "../orchestration-v2/MemberThreadState.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as TeamImageService from "../sandbox/image/TeamImageService.ts";
import { forkParked } from "../serverActivation.ts";
import * as MemberPushDevices from "../team/MemberPushDevices.ts";
import * as Presence from "../team/Presence.ts";
import * as TeamState from "../team/TeamState.ts";

const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";

/** Where pushes are POSTed. Only tests and E2E harnesses replace it. */
export const MemberPushEndpoint = Context.Reference<string>("t3/notifications/MemberPushEndpoint", {
  defaultValue: () => EXPO_PUSH_SEND_URL,
});

/**
 * Sends a team server's thread notifications to its members' phones through Expo, routed as web
 * routes them, and tells a finished team image build's recipients. A single-member server sends
 * nothing unless it is cloud-only.
 */
export class MemberPushNotifier extends Context.Service<
  MemberPushNotifier,
  {
    readonly drain: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/notifications/MemberPushNotifier") {}

interface Notification extends ThreadNotificationEvent {
  readonly threadId: ThreadId;
  readonly threadTitle: string;
}

type WorkItem =
  | { readonly type: "event"; readonly event: OrchestrationV2DomainEvent }
  | { readonly type: "build"; readonly finished: TeamImageService.TeamImageBuildFinished };

const ExpoPushResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      status: Schema.String,
      details: Schema.optional(Schema.Struct({ error: Schema.optional(Schema.String) })),
    }),
  ),
});
const decodeExpoPushResponse = Schema.decodeUnknownEffect(ExpoPushResponse);

// Expo accepts at most 100 messages per request.
const EXPO_BATCH_SIZE = 100;
const HANDLED_LIMIT = 4_096;
const ARCHIVE_DEEP_LINK = "/settings/archive";

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const team = yield* TeamState.TeamState;
  const presence = yield* Presence.Presence;
  const devices = yield* MemberPushDevices.MemberPushDevices;
  const teamImages = yield* TeamImageService.TeamImageService;
  const http = yield* HttpClient.HttpClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const sessions = yield* Effect.serviceOption(SessionStore.SessionStore);
  const endpoint = yield* MemberPushEndpoint;
  const { cloudOnly } = yield* ServerConfig.ServerConfig;
  // Pair Cloud skips T3 Connect, so even its first member hears pushes from here.
  const pushes = cloudOnly ? Effect.succeed(true) : team.isTeamMode;

  // Each thread's holder as last seen, so a metadata update can tell an Assign apart.
  const holders = new Map<ThreadId, MemberId>();
  const seeded = yield* Ref.make(false);
  // Runs, requests, guest messages and user messages already notified, oldest first.
  const handled = new Set<string>();
  const firstSighting = (key: string) => {
    if (handled.has(key)) return false;
    handled.add(key);
    if (handled.size > HANDLED_LIMIT) handled.delete(handled.values().next().value!);
    return true;
  };

  const seedHolders = Effect.gen(function* () {
    if (yield* Ref.getAndSet(seeded, true)) return;
    const snapshot = yield* threads.getShellSnapshot();
    for (const shell of [...snapshot.threads, ...snapshot.archivedThreads]) {
      if (!holders.has(shell.id)) holders.set(shell.id, holderOf(shell, team.ownerId));
    }
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not read thread holders for push.", { cause }),
    ),
  );

  const readShell = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map(Option.fromNullishOr),
      Effect.catch((cause) =>
        Effect.logWarning("Could not read a thread for push.", { cause }).pipe(
          Effect.as(Option.none<OrchestrationV2ThreadShell>()),
        ),
      ),
    );

  const agentEvent = (
    shell: OrchestrationV2ThreadShell,
    kind: Notification["kind"],
  ): Notification => {
    const ownerId = holderOf(shell, team.ownerId);
    return {
      kind,
      actorId: null,
      prompterId: shell.latestRunAuthorId ?? ownerId,
      ownerId,
      threadId: shell.id,
      threadTitle: shell.title,
    };
  };

  const detect = Effect.fnUntraced(function* (
    event: OrchestrationV2DomainEvent,
  ): Effect.fn.Return<Notification | null> {
    switch (event.type) {
      case "run.updated": {
        const run = event.payload;
        if (run.status !== "completed" && run.status !== "failed") return null;
        if (!firstSighting(`run:${run.id}:${run.status}`)) return null;
        const shell = yield* readShell(event.threadId);
        if (Option.isNone(shell)) return null;
        const thread = shell.value;
        if (
          !isListedThreadLineage(thread.lineage) ||
          thread.archivedAt !== null ||
          thread.latestRunId !== run.id
        ) {
          return null;
        }
        if (run.status === "failed") {
          return agentEvent(
            thread,
            thread.lastErrorClass === "usage_limit"
              ? "limited"
              : thread.sandbox?.state === "failed"
                ? "machine-failed"
                : "failed",
          );
        }
        // As on web: only a settled thread whose run nobody stopped reports completion.
        if (
          thread.activeRunId !== null ||
          thread.pendingRuntimeRequest !== null ||
          thread.latestRunStopRequested === true
        ) {
          return null;
        }
        return agentEvent(thread, "completion");
      }
      case "runtime-request.updated": {
        const request = event.payload;
        if (request.status !== "pending" || request.kind === "auth_refresh") return null;
        if (!firstSighting(`request:${request.id}`)) return null;
        const shell = yield* readShell(event.threadId);
        if (Option.isNone(shell)) return null;
        // A subagent's request surfaces on the listed thread it belongs to.
        const listed = isListedThreadLineage(shell.value.lineage)
          ? shell
          : yield* readShell(shell.value.lineage.rootThreadId);
        if (
          Option.isNone(listed) ||
          !isListedThreadLineage(listed.value.lineage) ||
          listed.value.archivedAt !== null
        ) {
          return null;
        }
        return agentEvent(listed.value, request.kind === "user_input" ? "input" : "approval");
      }
      case "message.updated": {
        const message = event.payload;
        if (
          message.role !== "user" ||
          message.createdBy !== "user" ||
          message.idleCompaction !== undefined
        ) {
          return null;
        }
        if (!firstSighting(`message:${message.id}`)) return null;
        const shell = yield* readShell(event.threadId);
        if (Option.isNone(shell) || !isListedThreadLineage(shell.value.lineage)) return null;
        if (shell.value.archivedAt !== null) return null;
        const ownerId = holderOf(shell.value, team.ownerId);
        return {
          kind: "message",
          actorId: message.authorId ?? ownerId,
          prompterId: null,
          ownerId,
          threadId: shell.value.id,
          threadTitle: shell.value.title,
        };
      }
      case "thread.created":
      case "thread.metadata-updated":
      case "thread.archived":
      case "thread.guest-share-updated": {
        const thread = event.payload;
        const ownerId = holderOf(thread, team.ownerId);
        const previousOwnerId = holders.get(thread.id);
        holders.set(thread.id, ownerId);
        if (!isListedThreadLineage(thread.lineage)) return null;
        const base = { prompterId: null, ownerId, threadId: thread.id, threadTitle: thread.title };
        if (event.type === "thread.metadata-updated") {
          if (previousOwnerId === undefined || previousOwnerId === ownerId) return null;
          return { ...base, kind: "assigned", actorId: thread.ownerUpdatedBy ?? ownerId };
        }
        if (event.type === "thread.archived") {
          return thread.archivedBy === undefined
            ? null
            : { ...base, kind: "archived", actorId: thread.archivedBy };
        }
        if (event.type === "thread.guest-share-updated") {
          const fresh = (thread.guestShare?.messages ?? []).filter(
            (message) => message.status === "pending" && firstSighting(`guest:${message.id}`),
          );
          return fresh.length === 0 || thread.archivedAt !== null
            ? null
            : { ...base, kind: "request", actorId: null };
        }
        return null;
      }
      default:
        return null;
    }
  });

  /** One message to every live device of each member, however it was chosen. */
  const sendToMembers = Effect.fn("MemberPushNotifier.sendToMembers")(function* (
    memberIds: ReadonlySet<MemberId>,
    message: { readonly title: string; readonly body: string; readonly deepLink: string },
  ) {
    const live = yield* devices.listLive;
    const tokens = live.filter((device) => memberIds.has(device.memberId)).map((d) => d.token);
    const messages = tokens.map((to) => ({
      to,
      title: message.title,
      body: message.body,
      data: { deepLink: message.deepLink },
      sound: "default",
      channelId: "agent-alerts",
      priority: "high",
    }));
    for (let start = 0; start < messages.length; start += EXPO_BATCH_SIZE) {
      const batch = messages.slice(start, start + EXPO_BATCH_SIZE);
      const response = yield* http
        .execute(
          HttpClientRequest.post(endpoint).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyJsonUnsafe(batch),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((ok) => ok.json),
          Effect.flatMap(decodeExpoPushResponse),
          Effect.catch((cause) =>
            Effect.logWarning("Could not send push notifications.", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
      if (response === null) continue;
      yield* Effect.forEach(
        response.data,
        (ticket, index) => {
          const token = batch[index]?.to;
          return ticket.details?.error === "DeviceNotRegistered" && token !== undefined
            ? devices.removeToken(token)
            : Effect.void;
        },
        { discard: true },
      );
    }
  });

  const send = Effect.fn("MemberPushNotifier.send")(function* (notification: Notification) {
    const live = yield* devices.listLive;
    if (live.length === 0) return;
    const recipients = new Set<MemberId>();
    for (const memberId of new Set(live.map((device) => device.memberId))) {
      if (!shouldNotifyMember(notification, { memberId, teamMode: true })) continue;
      if (yield* presence.isViewing(memberId, notification.threadId)) continue;
      recipients.add(memberId);
    }
    if (recipients.size === 0) return;
    const environmentId = yield* environment.getEnvironmentId;
    const archiverName =
      notification.kind === "archived" && notification.actorId !== null
        ? ((yield* Ref.get(team.members)).get(notification.actorId)?.name ?? "Former member")
        : null;
    const deepLink =
      notification.kind === "archived"
        ? ARCHIVE_DEEP_LINK
        : `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(notification.threadId)}`;
    yield* sendToMembers(recipients, {
      title: threadNotificationTitle(notification.kind, archiverName),
      body: notification.threadTitle,
      deepLink,
    });
  });

  // A build has no thread to view, and its recipients are already chosen.
  const sendBuild = Effect.fn("MemberPushNotifier.sendBuild")(function* (
    finished: TeamImageService.TeamImageBuildFinished,
  ) {
    const message = teamImageBuildNotification(finished.build);
    if (message === null || finished.recipients.length === 0) return;
    yield* sendToMembers(new Set(finished.recipients), {
      ...message,
      deepLink: TEAM_IMAGE_DEEP_LINK,
    });
  });

  const handle = Effect.fnUntraced(function* (item: WorkItem) {
    if (item.type === "build") {
      if (yield* pushes) yield* sendBuild(item.finished);
      return;
    }
    const event = item.event;
    if (isMemberThreadEvent(event)) return;
    if (!(yield* pushes)) {
      // Holders go stale while solo; reseed if a second member joins.
      if (yield* Ref.get(seeded)) {
        holders.clear();
        yield* Ref.set(seeded, false);
      }
      return;
    }
    yield* seedHolders;
    const notification = yield* detect(event);
    if (notification !== null) yield* send(notification);
  });

  const worker = yield* makeDrainableWorker(handle);

  const start: MemberPushNotifier["Service"]["start"] = Effect.fn("MemberPushNotifier.start")(
    function* () {
      yield* forkParked(
        Effect.when(seedHolders, pushes).pipe(
          Effect.andThen(
            Stream.runForEach(threads.streamDomainEvents, (event) =>
              worker.enqueue({ type: "event", event }),
            ),
          ),
        ),
      );
      yield* forkParked(
        Stream.runForEach(teamImages.buildFinished, (finished) =>
          worker.enqueue({ type: "build", finished }),
        ),
      );
      if (Option.isSome(sessions)) {
        yield* forkParked(
          Stream.runForEach(sessions.value.streamChanges, (change) =>
            change.type === "clientRemoved" ? devices.removeSession(change.sessionId) : Effect.void,
          ),
        );
      }
    },
  );

  return MemberPushNotifier.of({ drain: worker.drain, start });
});

export const layer = Layer.effect(MemberPushNotifier, make);
