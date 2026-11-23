import {
  type EnvironmentThreadShell,
  type PendingSubagentRequest,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { isTeamModeMembers } from "@t3tools/client-runtime/state/team";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import type { AnyRouter } from "@tanstack/react-router";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type {
  EnvironmentId,
  MemberId,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { monitorHoldsWakeCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import type { ClientSettings } from "@t3tools/contracts/settings";
import {
  shouldNotifyMember,
  threadNotificationTitle,
  type ThreadNotificationKind as RoutedNotificationKind,
} from "@t3tools/shared/threadNotificationRouting";
import * as Option from "effect/Option";
import type { AtomRegistry } from "effect/reactivity";
import {
  ArchiveIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  GitCompareArrowsIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  ShieldQuestionIcon,
  UserRoundCheckIcon,
} from "lucide-react";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { isWindowsPlatform } from "../lib/utils";
import { readBotThreadIds } from "../state/bots";
import { environmentSummaries } from "../state/presentation";
import { environmentShell } from "../state/shell";
import { teamEnvironment } from "../state/team";
import { environmentThreadShells } from "../state/threads";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  threadNotificationTag,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveBackgroundThreadRequest } from "./backgroundThreadAnnouncement";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";
import {
  createThreadNotificationGate,
  type ThreadNotificationKind,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";
import { toastManager } from "./ui/toast";
import {
  type LineageNotificationKind,
  lineageNotificationKind,
} from "./lineage/lineageNotifications";

interface NotificationState extends ThreadNotificationObservation {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly thread: EnvironmentThreadShell;
  readonly status: SidebarThreadStatus;
  /** Who archived it, when another member than the holder did; set when it leaves the list. */
  readonly archivedBy: MemberId | null;
}

type PresentedKind = ThreadNotificationKind | LineageNotificationKind;

function routedKind(kind: PresentedKind, status: SidebarThreadStatus): RoutedNotificationKind {
  if (kind !== "input") return kind;
  return status === "approval" ||
    status === "limited" ||
    status === "failed" ||
    status === "request"
    ? status
    : "input";
}

type ToastId = ReturnType<typeof toastManager.add>;

interface WatchedEnvironment {
  unsubscribe: () => void;
  previous: Map<ThreadId, NotificationState>;
  reconnecting: boolean;
  readonly gate: ReturnType<typeof createThreadNotificationGate<ThreadId, NotificationState>>;
}

/**
 * Turns thread status transitions in every connected environment into sounds, in-app toasts,
 * and desktop notifications, and keeps the dock badge in step with the unread ones.
 */
export function startThreadNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const pending = new Map<
    string,
    { environmentId: EnvironmentId; threadId: ThreadId; notification: Notification }
  >();
  const watched = new Map<EnvironmentId, WatchedEnvironment>();

  const trackNotification = (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    notification: Notification,
  ) => {
    pending.get(notification.tag)?.notification.close();
    pending.set(notification.tag, { environmentId, threadId, notification });
    setNotificationBadge(pending.size);
  };
  // Toast ids by thread key, so hiding or opening a thread can close its open toasts.
  const openToasts = new Map<string, Array<ToastId>>();
  const forgetToast = (key: string, toastId: ToastId) => {
    const remaining = (openToasts.get(key) ?? []).filter((id) => id !== toastId);
    if (remaining.length === 0) openToasts.delete(key);
    else openToasts.set(key, remaining);
  };
  const closeToasts = (shouldClose: (key: string) => boolean) => {
    for (const [key, toastIds] of openToasts) {
      if (!shouldClose(key)) continue;
      for (const toastId of toastIds) toastManager.close(toastId);
      openToasts.delete(key);
    }
  };
  const activeThread = () =>
    (router.state.matches.at(-1)?.params ?? {}) as {
      environmentId?: EnvironmentId;
      threadId?: ThreadId;
    };
  const closeOpenedThreadToasts = () => {
    const { environmentId, threadId } = activeThread();
    if (environmentId === undefined || threadId === undefined) return;
    const opened = threadKey({ environmentId, threadId });
    closeToasts((key) => key === opened);
  };
  // A notification shown before the tag filter turned on must not stay on screen. While hiding,
  // one whose thread left the live list (archived) cannot be judged, so it closes too.
  const closeHiddenPending = () => {
    const hidden = registry.get(environmentThreadShells.hiddenThreadKeysAtom);
    const live = registry.get(environmentThreadShells.anyEnvironmentHidingAtom)
      ? new Set(registry.get(environmentThreadShells.threadRefsAtom).map(threadKey))
      : null;
    const shouldClose = (key: string) => hidden.has(key) || (live !== null && !live.has(key));
    closeToasts(shouldClose);
    const count = pending.size;
    for (const [tag, entry] of pending) {
      if (!shouldClose(threadKey(entry))) continue;
      entry.notification.close();
      pending.delete(tag);
    }
    if (count !== pending.size) setNotificationBadge(pending.size);
  };
  const clearPending = () => {
    for (const { notification } of pending.values()) notification.close();
    pending.clear();
    setNotificationBadge(0);
  };

  // Attribution facts are absent when they are the holder, so each falls back to the holder.
  const isRouted = (
    environmentId: EnvironmentId,
    state: NotificationState,
    kind: PresentedKind,
  ) => {
    const members = registry.get(teamEnvironment.membersValueAtom(environmentId));
    let serverOwnerId: MemberId | null = null;
    for (const member of members.values()) if (member.isOwner) serverOwnerId = member.id;
    const { thread } = state;
    const ownerId = state.raw.ownerId ?? serverOwnerId;
    return shouldNotifyMember(
      {
        kind: routedKind(kind, state.status),
        actorId:
          kind === "message"
            ? (thread.latestUserMessageAuthorId ?? ownerId)
            : kind === "assigned"
              ? (thread.ownerUpdatedBy ?? ownerId)
              : kind === "archived"
                ? (state.archivedBy ?? ownerId)
                : null,
        prompterId: thread.latestRunAuthorId ?? ownerId,
        ownerId,
        // A branch's offers are its holder's.
        senderId: ownerId,
      },
      {
        memberId: registry.get(teamEnvironment.currentMemberIdAtom(environmentId)),
        teamMode: isTeamModeMembers(members),
      },
    );
  };

  const present = (environmentId: EnvironmentId, state: NotificationState, kind: PresentedKind) => {
    const { thread, status } = state;
    if (
      registry
        .get(environmentThreadShells.hiddenThreadKeysAtom)
        .has(threadKey({ environmentId, threadId: thread.id }))
    )
      return;
    const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
    const active = activeThread();
    const archiverName =
      kind === "archived" && state.archivedBy !== null
        ? (registry.get(teamEnvironment.membersValueAtom(environmentId)).get(state.archivedBy)
            ?.name ?? "Former member")
        : null;
    const title = threadNotificationTitle(routedKind(kind, status), archiverName);
    if (hasNotificationSound(mode)) {
      void playNotificationSound(kind === "completion" ? "completion" : "input", () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    // An archived thread is gone from the chat list; Settings → Archived shows it with Unarchive.
    const open = () =>
      kind === "archived"
        ? router.navigate({ to: "/settings/archived" })
        : router.navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: thread.id },
          });
    if (
      inAppNotificationsEnabled &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      (active.environmentId !== environmentId || active.threadId !== thread.id)
    ) {
      const toastKey = threadKey({ environmentId, threadId: thread.id });
      const toastId: ToastId = toastManager.add({
        onRemove: (): void => forgetToast(toastKey, toastId),
        type:
          kind === "completion"
            ? "success"
            : kind === "message" ||
                kind === "assigned" ||
                kind === "archived" ||
                kind === "offer" ||
                kind === "offer-applied" ||
                kind === "offer-declined"
              ? "info"
              : status === "failed"
                ? "error"
                : "warning",
        title,
        description: thread.title,
        data: {
          hideCopyButton: true,
          leadingIcon:
            kind === "completion" ? (
              <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
            ) : kind === "message" ? (
              <MessageSquareIcon aria-hidden className="size-4 text-info-foreground" />
            ) : kind === "assigned" ? (
              <UserRoundCheckIcon aria-hidden className="size-4 text-info-foreground" />
            ) : kind === "archived" ? (
              <ArchiveIcon aria-hidden className="size-4 text-info-foreground" />
            ) : kind === "offer" || kind === "offer-applied" || kind === "offer-declined" ? (
              <GitCompareArrowsIcon aria-hidden className="size-4 text-info-foreground" />
            ) : kind === "offer-returned" ? (
              <GitCompareArrowsIcon aria-hidden className="size-4 text-warning-foreground" />
            ) : status === "approval" ? (
              <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
            ) : status === "limited" ? (
              <CircleAlertIcon aria-hidden className="size-4 text-warning-foreground" />
            ) : status === "failed" ? (
              <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
            ) : (
              <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
            ),
        },
        actionProps: {
          children: kind === "archived" ? "Open archive" : "Open thread",
          onClick: () => {
            toastManager.close(toastId);
            void open();
          },
        },
      });
      openToasts.set(toastKey, [...(openToasts.get(toastKey) ?? []), toastId]);
      return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      (document.visibilityState === "visible" && document.hasFocus()) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    try {
      const notification = new Notification(title, {
        body: thread.title,
        tag: threadNotificationTag(environmentId, thread.id),
        silent: true,
        // Windows drops clicks after a toast moves into Notification Center.
        requireInteraction: kind === "completion" && isWindowsPlatform(navigator.platform),
      });
      trackNotification(environmentId, thread.id, notification);
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow().catch(() => undefined);
        void open();
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  };

  const observeThreads = (
    environmentId: EnvironmentId,
    entry: WatchedEnvironment,
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
    removedBy: ReadonlyMap<ThreadId, MemberId>,
  ) => {
    const previous = entry.previous;
    const next = new Map<ThreadId, NotificationState>();
    // A parent here also hears of what its tasks on linked environments ask.
    const subagentRequests = registry.get(
      environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
    );
    const delegatedUnderParent = registry.get(environmentThreadShells.delegatedUnderParentAtom);
    const changed: Array<[NotificationState | undefined, NotificationState]> = [];
    // Bot home threads and sessions never notify; their Asks and finished jobs do.
    const botThreadIds = readBotThreadIds(environmentId);
    for (const rawThread of threads) {
      if (botThreadIds.has(rawThread.id)) continue;
      if (
        isShownUnderParent(
          { environmentId, threadId: rawThread.id },
          rawThread.lineage,
          delegatedUnderParent,
        )
      ) {
        continue;
      }
      const prior = previous.get(rawThread.id);
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      if (
        !entry.reconnecting &&
        prior?.raw === rawThread &&
        prior.subagentRequest === subagentRequest
      ) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread, subagentRequest);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const needsAttention =
        status === "input" ||
        status === "request" ||
        status === "approval" ||
        status === "failed" ||
        status === "limited";
      const requestId = needsAttention ? resolveBackgroundThreadRequest(thread).requestId : null;
      // Queued messages become the latest run while a request stays pending, so a request
      // with an id is keyed by that id alone and announces once.
      const attention = !needsAttention
        ? null
        : requestId !== null
          ? `${status}:${requestId}`
          : `${thread.latestRun?.runId ?? ""}:${status}`;
      const completed = status === "ready" && thread.latestRun?.status === "completed";
      const settled = completed && !monitorHoldsWakeCompletion(rawThread);
      const parsedCompletedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      const completedAt = Number.isFinite(parsedCompletedAt) ? parsedCompletedAt : null;
      const messageAt = Date.parse(thread.latestUserAuthoredMessageAt ?? "");
      const state: NotificationState = {
        raw: rawThread,
        subagentRequest,
        thread,
        status,
        attention,
        requestId,
        settled,
        completedAt: settled ? completedAt : null,
        backgroundWake: rawThread.latestRunBackgroundWake === true,
        messageAt: Number.isFinite(messageAt) ? messageAt : null,
        ownerId: rawThread.ownerId ?? null,
        archivedBy: null,
      };
      next.set(thread.id, state);
      changed.push([prior, state]);
    }
    const archived: Array<NotificationState> = [];
    for (const [threadId, prior] of previous) {
      const archivedBy = removedBy.get(threadId);
      if (!next.has(threadId) && archivedBy !== undefined) archived.push({ ...prior, archivedBy });
    }
    const reconnecting = entry.reconnecting;
    entry.reconnecting = false;
    entry.previous = next;
    entry.gate.retain(new Set(next.keys()));
    for (const prior of archived) entry.gate.archived(prior.thread.id, prior);
    for (const [prior, state] of changed) {
      entry.gate.observe(state.thread.id, prior, state, {
        archived: state.thread.archivedAt !== null,
        quiet: state.raw.latestRunStopRequested === true,
      });
      const lineageKind =
        prior === undefined || reconnecting
          ? null
          : lineageNotificationKind(prior.raw.branchLink, state.raw.branchLink);
      if (lineageKind !== null && isRouted(environmentId, state, lineageKind)) {
        present(environmentId, state, lineageKind);
      }
    }
  };

  const watchEnvironment = (environmentId: EnvironmentId): WatchedEnvironment => {
    const entry: WatchedEnvironment = {
      previous: new Map(),
      reconnecting: false,
      unsubscribe: () => {},
      gate: createThreadNotificationGate<ThreadId, NotificationState>((_threadId, kind, state) => {
        if (isRouted(environmentId, state, kind)) present(environmentId, state, kind);
      }),
    };
    let threads: ReadonlyArray<OrchestrationV2ThreadShell> | null = null;
    let removedBy: ReadonlyMap<ThreadId, MemberId> = new Map();
    const unsubscribeShell = registry.subscribe(
      environmentShell.stateValueAtom(environmentId),
      (shell) => {
        threads =
          shell.status === "live" && Option.isSome(shell.snapshot)
            ? shell.snapshot.value.threads
            : null;
        removedBy = shell.removedBy;
        if (threads !== null) {
          observeThreads(environmentId, entry, threads, removedBy);
          return;
        }
        entry.reconnecting = true;
        entry.gate.pause();
      },
      { immediate: true },
    );
    const reobserve = () => {
      if (threads !== null) observeThreads(environmentId, entry, threads, removedBy);
    };
    const unsubscribeRequests = registry.subscribe(
      environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
      reobserve,
    );
    const unsubscribeDelegated = registry.subscribe(
      environmentThreadShells.delegatedUnderParentAtom,
      reobserve,
    );
    entry.unsubscribe = () => {
      unsubscribeShell();
      unsubscribeRequests();
      unsubscribeDelegated();
      entry.gate.clear();
    };
    return entry;
  };

  const syncEnvironments = () => {
    const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
    const enabled = notificationMode !== "off" || inAppNotificationsEnabled;
    if (!enabled) closeToasts(() => true);
    const environmentIds = enabled ? registry.get(environmentSummaries.environmentIdsAtom) : [];
    const activeIds = new Set(environmentIds);
    for (const [environmentId, entry] of watched) {
      if (activeIds.has(environmentId)) continue;
      entry.unsubscribe();
      watched.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (!watched.has(environmentId)) watched.set(environmentId, watchEnvironment(environmentId));
    }
  };

  const pruneRemovedEnvironments = () => {
    const activeIds = new Set(registry.get(environmentSummaries.environmentIdsAtom));
    const count = pending.size;
    for (const [tag, entry] of pending) {
      if (activeIds.has(entry.environmentId)) continue;
      entry.notification.close();
      pending.delete(tag);
    }
    if (count !== pending.size) setNotificationBadge(pending.size);
  };

  // Listeners that only exist for some notification modes, rebuilt when the mode changes.
  let appliedMode: ClientSettings["notificationMode"] | null = null;
  let stopModeListeners = () => {};
  const applyMode = () => {
    const nextMode = getClientSettings().notificationMode;
    if (nextMode === appliedMode) return;
    appliedMode = nextMode;
    stopModeListeners();
    clearPending();
    const stops: Array<() => void> = [];
    if (hasDesktopNotifications(nextMode)) {
      const unsubscribeBadgeClear = window.desktopBridge?.onNotificationBadgeClear(clearPending);
      window.addEventListener("focus", clearPending);
      stops.push(() => {
        unsubscribeBadgeClear?.();
        window.removeEventListener("focus", clearPending);
        clearPending();
      });
    }
    if (hasNotificationSound(nextMode)) {
      document.addEventListener("pointerdown", unlockNotificationAudio);
      document.addEventListener("keydown", unlockNotificationAudio);
      stops.push(() => {
        document.removeEventListener("pointerdown", unlockNotificationAudio);
        document.removeEventListener("keydown", unlockNotificationAudio);
      });
    }
    stopModeListeners = () => {
      for (const stop of stops) stop();
    };
  };

  const onSettings = () => {
    applyMode();
    syncEnvironments();
  };
  const unsubscribeSettings = subscribeClientSettings(onSettings);
  const unsubscribeEnvironmentIds = registry.subscribe(
    environmentSummaries.environmentIdsAtom,
    () => {
      pruneRemovedEnvironments();
      syncEnvironments();
    },
  );
  const unsubscribeHidden = [
    registry.subscribe(environmentThreadShells.hiddenThreadKeysAtom, closeHiddenPending),
    registry.subscribe(environmentThreadShells.anyEnvironmentHidingAtom, closeHiddenPending),
    registry.subscribe(environmentThreadShells.threadRefsAtom, closeHiddenPending),
  ];
  const unsubscribeRoute = router.subscribe("onResolved", closeOpenedThreadToasts);
  onSettings();

  return () => {
    unsubscribeSettings();
    unsubscribeEnvironmentIds();
    for (const unsubscribe of unsubscribeHidden) unsubscribe();
    unsubscribeRoute();
    for (const entry of watched.values()) entry.unsubscribe();
    watched.clear();
    stopModeListeners();
    closeToasts(() => true);
  };
}
