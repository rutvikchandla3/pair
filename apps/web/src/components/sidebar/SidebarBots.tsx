import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { LoaderCircleIcon, PauseIcon, PlusIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { useQuietThreadShells } from "../../state/entities";
import { useBotsSnapshot, useBotsNow } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { BotAvatar } from "../bots/BotAvatar";
import { botSessions, needsYouCount, sessionState, type ShellLookup } from "../bots/bots.logic";

const rowClass =
  "group/bot-row flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground hover:bg-sidebar-row-hover";

function NewBotButton() {
  const navigate = useNavigate();
  return (
    <Button
      size="icon-micro"
      variant="ghost-muted"
      aria-label="New bot"
      onClick={() => void navigate({ to: "/bots", search: { new: 1 } })}
    >
      <PlusIcon />
    </Button>
  );
}

/** The sidebar's Bots section: a header with +, then one row per bot. */
export function SidebarBots() {
  const environmentId = usePrimaryEnvironmentId();
  const snapshot = useBotsSnapshot(environmentId);
  const shells = useQuietThreadShells();
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const now = useBotsNow();

  if (environmentId === null || snapshot === null) return null;

  const shellMap: ShellLookup = new Map(
    shells
      .filter((shell) => shell.environmentId === environmentId)
      .map((shell) => [shell.id, shell] as const),
  );
  const selectedBotId =
    params.environmentId === environmentId && params.botId !== undefined ? params.botId : null;

  return (
    <div className="mb-2 flex flex-col gap-px" role="presentation">
      <div className="flex h-8 items-center gap-2 px-2">
        <span className="shrink-0 font-medium text-sidebar-muted-foreground text-xs">Bots</span>
        <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/50" />
        <NewBotButton />
      </div>
      {snapshot.bots.length === 0 ? (
        <button
          type="button"
          className={cn(rowClass, "w-full text-left text-sidebar-muted-foreground")}
          onClick={() => void navigate({ to: "/bots" })}
        >
          <PlusIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">New bot</span>
        </button>
      ) : (
        snapshot.bots.map((bot) => {
          const needYou = needsYouCount(snapshot, bot.id, shellMap, now);
          const working =
            !bot.paused &&
            botSessions(snapshot, bot.id).some((session) => {
              const state = sessionState(session, shellMap.get(session.threadId) ?? null, now);
              return state.kind === "working" || state.kind === "quiet";
            });
          return (
            <Link
              key={bot.id}
              to="/bots/$environmentId/$botId"
              params={{ environmentId: environmentId as EnvironmentId, botId: bot.id }}
              search={{ tab: "briefing" }}
              aria-current={selectedBotId === bot.id ? "page" : undefined}
              className={cn(rowClass, selectedBotId === bot.id && "bg-sidebar-row-active")}
            >
              <BotAvatar bot={bot} size="sm" />
              <span className="min-w-0 flex-1 truncate">{bot.name}</span>
              {needYou > 0 ? (
                <span
                  aria-label={`${needYou} need you`}
                  className="shrink-0 rounded-full bg-input-foreground/12 px-1.5 text-input-foreground text-xs tabular-nums"
                >
                  {needYou}
                </span>
              ) : working ? (
                <LoaderCircleIcon
                  aria-label="Working"
                  className="size-3.5 shrink-0 text-sidebar-muted-foreground"
                />
              ) : bot.paused ? (
                <PauseIcon
                  aria-label="Paused"
                  className="size-3.5 shrink-0 text-sidebar-muted-foreground"
                />
              ) : null}
            </Link>
          );
        })
      )}
    </div>
  );
}
