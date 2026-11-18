import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useNowMinuteMs } from "../../lib/clock";
import { useBotsSnapshot } from "../../state/bots";
import { botStatusLine } from "./botsModel";
import { useBotSessionStates } from "./useBotSessions";

/**
 * A bot's name and status line when the open thread is that bot's home thread; null on any other
 * thread, so the thread header falls back to its own title and subtitle.
 */
export function useBotHomeHeader(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): { readonly name: string; readonly status: string } | null {
  const snapshot = useBotsSnapshot(environmentId);
  const nowMs = useNowMinuteMs();
  const bot =
    snapshot === null || threadId === null
      ? null
      : (snapshot.bots.find((candidate) => candidate.homeThreadId === threadId) ?? null);
  const sessions =
    snapshot === null || bot === null
      ? []
      : snapshot.sessions.filter((session) => session.botId === bot.id);
  const states = useBotSessionStates({
    environmentId,
    sessions,
    botName: bot?.name ?? "",
    nowMs,
  });
  if (snapshot === null || bot === null) return null;
  const status = botStatusLine({
    bot,
    asks: snapshot.asks.filter((ask) => ask.botId === bot.id),
    jobs: snapshot.jobs.filter((job) => job.botId === bot.id),
    sessions,
    sessionStates: states,
  });
  return { name: bot.name, status: status.text };
}
