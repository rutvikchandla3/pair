import { useEffect, useEffectEvent, useRef } from "react";
import { BOT_WAKE_BATCH_MS } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { getClientSettings } from "../../hooks/useSettings";
import { useBotsSnapshot } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { hasDesktopNotifications } from "../../threadNotifications";

const ASK_COALESCE_MS = Math.max(60_000, BOT_WAKE_BATCH_MS);

function canPresentDesktopNotification(): boolean {
  if (!hasDesktopNotifications(getClientSettings().notificationMode)) return false;
  if (document.visibilityState === "visible" && document.hasFocus()) return false;
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

/** Bots' own notifications: new Asks (coalesced) and finished or stopped jobs. */
export function BotNotifications() {
  const environmentId = usePrimaryEnvironmentId();
  const snapshot = useBotsSnapshot(environmentId);
  const navigate = useNavigate();
  const previous = useRef<{
    readonly openAskIds: ReadonlySet<string>;
    readonly jobStatuses: ReadonlyMap<string, string>;
  } | null>(null);
  const askBatch = useRef<{ botId: string; questions: string[]; timer: number | null } | null>(
    null,
  );

  const openBot = (botId: string, jobId?: string) => {
    if (environmentId === null) return;
    void navigate({
      to: "/bots/$environmentId/$botId",
      params: { environmentId, botId },
      search: { tab: "briefing", ...(jobId === undefined ? {} : { job: jobId }) },
    });
  };

  const notify = (tag: string, title: string, body: string, onClick: () => void) => {
    if (!canPresentDesktopNotification()) return;
    try {
      const notification = new Notification(title, { body, tag, silent: true });
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow().catch(() => undefined);
        onClick();
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  };

  const flushAsks = (botName: string, botId: string) => {
    const batch = askBatch.current;
    askBatch.current = null;
    if (batch === null || batch.questions.length === 0) return;
    const title =
      batch.questions.length === 1
        ? `${botName} asks: ${batch.questions[0]}`
        : `${botName} asks ${batch.questions.length} things`;
    notify(`bot-ask:${botId}`, title, batch.questions.slice(0, 3).join(" · "), () =>
      openBot(botId),
    );
  };

  const onSnapshot = useEffectEvent((next: NonNullable<ReturnType<typeof useBotsSnapshot>>) => {
    const prior = previous.current;
    const openAsks = next.asks.filter((ask) => ask.status === "open");
    previous.current = {
      openAskIds: new Set(openAsks.map((ask) => ask.id)),
      jobStatuses: new Map(next.jobs.map((job) => [job.id, job.status])),
    };
    // The first snapshot is history, not news.
    if (prior === null) return;

    for (const ask of openAsks) {
      if (prior.openAskIds.has(ask.id)) continue;
      const bot = next.bots.find((candidate) => candidate.id === ask.botId);
      const name = bot?.name ?? "Your bot";
      const batch = askBatch.current;
      if (batch === null || batch.botId !== ask.botId) {
        if (batch?.timer != null) window.clearTimeout(batch.timer);
        askBatch.current = { botId: ask.botId, questions: [ask.question], timer: null };
      } else {
        batch.questions.push(ask.question);
      }
      const current = askBatch.current;
      if (current?.timer != null) window.clearTimeout(current.timer);
      if (current !== null) {
        current.timer = window.setTimeout(() => flushAsks(name, current.botId), ASK_COALESCE_MS);
      }
    }

    for (const job of next.jobs) {
      const was = prior.jobStatuses.get(job.id);
      if (was !== "working" || (job.status !== "done" && job.status !== "stopped")) continue;
      const bot = next.bots.find((candidate) => candidate.id === job.botId);
      const name = bot?.name ?? "Your bot";
      notify(
        `bot-job:${job.id}`,
        `${name} ${job.status === "stopped" ? "stopped" : "finished"} J-${job.number} · ${job.title}`,
        job.headline,
        () => openBot(job.botId, job.id),
      );
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- imperatively shows desktop notifications as new Asks and finished jobs arrive
  useEffect(() => {
    if (environmentId === null || snapshot === null) return;
    onSnapshot(snapshot);
  }, [snapshot, environmentId]);

  return null;
}
