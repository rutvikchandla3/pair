import type { Bot, BotsSnapshot, EnvironmentId } from "@t3tools/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { useQuietThreadShells } from "../../state/entities";
import { useBotsNow, useBotsSnapshot } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { BotAvatar } from "../bots/BotAvatar";
import { BotStateGlyph } from "../bots/BotStateGlyph";
import { openBotDialog } from "../bots/botDialogStore";
import {
  botSidebarSessions,
  botWorking,
  openAsks,
  type BotSidebarSession,
  type ShellLookup,
} from "../bots/bots.logic";

const rowClass =
  "group/bot-row flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground hover:bg-sidebar-row-hover";
const sessionRowClass =
  "group/bot-session-row flex h-7 min-w-0 items-center gap-1.5 rounded-md pe-2 ps-7.5 text-sm text-sidebar-foreground hover:bg-sidebar-row-hover";

function compact(label: string): string {
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

function SessionTime(props: { readonly timestamp: string }) {
  const nowMinute = useNowMinute();
  return (
    <span className="shrink-0 text-sidebar-muted-foreground text-xs tabular-nums">
      {compact(formatRelativeTimeLabel(props.timestamp, Date.parse(`${nowMinute}:00.000Z`)))}
    </span>
  );
}

function NewBotButton() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <Button
      size="icon-micro"
      variant="ghost-muted"
      aria-label="New bot"
      disabled={environmentId === null}
      onClick={() => {
        if (environmentId !== null) openBotDialog({ type: "new", environmentId });
      }}
    >
      <PlusIcon />
    </Button>
  );
}

function SessionRow(props: {
  readonly environmentId: EnvironmentId;
  readonly row: BotSidebarSession;
  readonly selectedThreadId: string | null;
}) {
  const { session } = props.row;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: props.environmentId, threadId: session.threadId }}
      aria-current={props.selectedThreadId === session.threadId ? "page" : undefined}
      className={cn(
        sessionRowClass,
        props.selectedThreadId === session.threadId && "bg-sidebar-row-active",
      )}
    >
      <span className="inline-flex w-3.5 shrink-0 justify-center">
        <BotStateGlyph glyph={props.row.glyph} className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
      {props.row.finishedAt === null ? null : <SessionTime timestamp={props.row.finishedAt} />}
    </Link>
  );
}

function BotGroup(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly snapshot: BotsSnapshot;
  readonly shells: ShellLookup;
  readonly now: number;
  readonly selectedBotId: string | null;
  readonly selectedThreadId: string | null;
}) {
  const [showEarlier, setShowEarlier] = useState(false);
  const askCount = openAsks(props.snapshot, props.bot.id).length;
  const working = botWorking(props.snapshot, props.bot, props.shells, props.now);
  const { rows, earlier } = botSidebarSessions(
    props.snapshot,
    props.bot.id,
    props.shells,
    props.now,
  );
  const selected = props.selectedBotId === props.bot.id;
  return (
    <>
      <Link
        to="/bots/$environmentId/$botId"
        params={{ environmentId: props.environmentId, botId: props.bot.id }}
        aria-current={selected ? "page" : undefined}
        className={cn(rowClass, selected && "bg-sidebar-row-active")}
      >
        <BotAvatar bot={props.bot} size="sm" />
        <span className="min-w-0 flex-1 truncate">{props.bot.name}</span>
        {askCount > 0 ? (
          <span
            aria-label={`${askCount} need you`}
            className="shrink-0 rounded-full bg-input-foreground/12 px-1.5 text-input-foreground text-xs tabular-nums"
          >
            {askCount}
          </span>
        ) : props.bot.paused ? (
          <span className="shrink-0 text-sidebar-muted-foreground text-xs">Paused</span>
        ) : working ? (
          <BotStateGlyph glyph="working" className="size-3.5" />
        ) : null}
      </Link>
      {rows.map((row) => (
        <SessionRow
          key={row.session.threadId}
          environmentId={props.environmentId}
          row={row}
          selectedThreadId={props.selectedThreadId}
        />
      ))}
      {earlier.length === 0 ? null : (
        <>
          {showEarlier
            ? earlier.map((row) => (
                <SessionRow
                  key={row.session.threadId}
                  environmentId={props.environmentId}
                  row={row}
                  selectedThreadId={props.selectedThreadId}
                />
              ))
            : null}
          <button
            type="button"
            aria-expanded={showEarlier}
            className={cn(rowClass, "ps-7.5 text-sidebar-muted-foreground")}
            onClick={() => setShowEarlier(!showEarlier)}
          >
            <ChevronRightIcon
              className={cn("size-3 shrink-0 transition-transform", showEarlier && "rotate-90")}
            />
            {showEarlier ? "Hide earlier" : `${earlier.length} earlier`}
          </button>
        </>
      )}
    </>
  );
}

/** The sidebar's Bots section: a header with +, then each bot with its sessions nested. */
export function SidebarBots() {
  const environmentId = usePrimaryEnvironmentId();
  const snapshot = useBotsSnapshot(environmentId);
  const shells = useQuietThreadShells();
  const params = useParams({ strict: false });
  const now = useBotsNow();

  if (environmentId === null || snapshot === null) return null;

  const shellMap: ShellLookup = new Map(
    shells
      .filter((shell) => shell.environmentId === environmentId)
      .map((shell) => [shell.id, shell] as const),
  );
  const selectedBotId =
    params.environmentId === environmentId && params.botId !== undefined ? params.botId : null;
  const selectedThreadId =
    params.environmentId === environmentId && params.threadId !== undefined
      ? params.threadId
      : null;

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
          onClick={() => openBotDialog({ type: "new", environmentId })}
        >
          <PlusIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">New bot</span>
        </button>
      ) : (
        snapshot.bots.map((bot) => (
          <BotGroup
            key={bot.id}
            environmentId={environmentId}
            bot={bot}
            snapshot={snapshot}
            shells={shellMap}
            now={now}
            selectedBotId={selectedBotId}
            selectedThreadId={selectedThreadId}
          />
        ))
      )}
    </div>
  );
}
