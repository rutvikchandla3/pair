import type { Bot, BotsSnapshot, EnvironmentId } from "@t3tools/contracts";
import { Link, useParams } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronRightIcon,
  CloudIcon,
  PlusIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { useQuietThreadShells } from "../../state/entities";
import { botsEnvironment, useBotsNow, useBotsSnapshot } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { BotAvatar } from "../bots/BotAvatar";
import { BotStateGlyph } from "../bots/BotStateGlyph";
import { openBotDialog } from "../bots/botDialogStore";
import {
  botFacePose,
  botSidebarSessions,
  botStatusLine,
  openAsks,
  type BotSidebarSession,
  type ShellLookup,
} from "../bots/bots.logic";

const rowClass =
  "group/bot-row flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground hover:bg-sidebar-row-hover";
const botRowClass =
  "bot-face-hover flex min-h-11 min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-sidebar-foreground hover:bg-sidebar-row-hover";
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
  readonly archived?: boolean;
}) {
  const { session } = props.row;
  const archiveJob = useAtomCommand(botsEnvironment.archiveJob);
  const setArchived = async (archived: boolean) => {
    const result = await archiveJob({
      environmentId: props.environmentId,
      input: { jobId: session.jobId, archived },
    });
    toastCommandFailure(
      archived ? "Could not archive the job" : "Could not unarchive the job",
      result,
    );
    if (!archived || result._tag !== "Success") return;
    const id = toastManager.add({
      type: "success",
      title: "Job archived",
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(id);
          void setArchived(false);
        },
      },
    });
  };
  const action = props.row.jobArchived
    ? "Unarchive job"
    : props.row.jobFinished
      ? "Archive job"
      : null;
  const cloud = session.cloud;
  return (
    <div className="group/bot-session relative">
      <Link
        to="/$environmentId/$threadId"
        params={{
          environmentId: cloud?.environmentId ?? props.environmentId,
          threadId: session.threadId,
        }}
        aria-current={props.selectedThreadId === session.threadId ? "page" : undefined}
        className={cn(
          sessionRowClass,
          props.selectedThreadId === session.threadId && "bg-sidebar-row-active",
          props.archived && "text-sidebar-muted-foreground",
        )}
      >
        <span className="inline-flex w-3.5 shrink-0 justify-center">
          <BotStateGlyph
            glyph={props.row.glyph}
            className="size-3.5"
            {...(cloud === undefined ? {} : { label: `Can't reach ${cloud.label}` })}
          />
        </span>
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        {cloud === undefined ? null : (
          <CloudIcon
            aria-label={`Runs on ${cloud.label}`}
            className="size-3 shrink-0 text-sidebar-muted-foreground"
          >
            <title>{`Runs on ${cloud.label}`}</title>
          </CloudIcon>
        )}
        {props.row.finishedAt === null ? null : (
          <span
            className={cn(
              "inline-flex",
              action !== null &&
                "group-hover/bot-session:invisible group-has-[button:focus-visible]/bot-session:invisible",
            )}
          >
            <SessionTime timestamp={props.row.finishedAt} />
          </span>
        )}
      </Link>
      {action === null ? null : (
        <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center opacity-0 transition-opacity group-hover/bot-session:pointer-events-auto group-hover/bot-session:opacity-100 has-[button:focus-visible]:pointer-events-auto has-[button:focus-visible]:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label={`${action} ${session.title}`}
                  onClick={() => void setArchived(!props.row.jobArchived)}
                />
              }
            >
              {props.row.jobArchived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
            </TooltipTrigger>
            <TooltipPopup side="top">{action}</TooltipPopup>
          </Tooltip>
        </div>
      )}
    </div>
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
  const [expanded, setExpanded] = useState(false);
  const [revealedThreadId, setRevealedThreadId] = useState<string | null>(null);
  const askCount = openAsks(props.snapshot, props.bot.id).length;
  const pose = botFacePose(props.snapshot, props.bot, props.shells, props.now);
  const status = botStatusLine(props.snapshot, props.bot, props.shells, props.now);
  const charter = props.bot.charter.trim();
  const statusLabel = status.label === "Nothing running" && charter !== "" ? charter : status.label;
  const { rows, earlier, archived } = botSidebarSessions(
    props.snapshot,
    props.bot.id,
    props.shells,
    props.now,
  );
  // Opening a row that sits behind the disclosure expands it once, so the row keeps its highlight.
  const selectedHidden = [...earlier, ...archived].some(
    (row) => row.session.threadId === props.selectedThreadId,
  );
  if (selectedHidden && revealedThreadId !== props.selectedThreadId) {
    setRevealedThreadId(props.selectedThreadId);
    setExpanded(true);
  }
  const selected = props.selectedBotId === props.bot.id;
  // Rows are bots; only the bot you're in lists its sessions under it.
  const open =
    selected ||
    [...rows, ...earlier, ...archived].some(
      (row) => row.session.threadId === props.selectedThreadId,
    );
  return (
    <>
      <Link
        to="/bots/$environmentId/$botId"
        params={{ environmentId: props.environmentId, botId: props.bot.id }}
        // While questions wait, the row opens them as the header pill does; on the bot's own page it
        // keeps whatever is open.
        search={selected ? true : askCount > 0 ? { questions: true } : {}}
        aria-current={selected ? "page" : undefined}
        className={cn(botRowClass, selected && "bg-sidebar-row-active")}
      >
        <BotAvatar bot={props.bot} size="row" pose={pose} environmentId={props.environmentId} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-sm">{props.bot.name}</span>
          <span
            className={cn(
              "truncate text-xs",
              status.kind === "needs" ? "text-input-foreground" : "text-sidebar-muted-foreground",
            )}
          >
            {statusLabel}
          </span>
        </span>
        {askCount > 0 ? (
          <span
            aria-label={`${askCount} need you`}
            className="shrink-0 rounded-full bg-input-foreground/12 px-1.5 text-input-foreground text-xs tabular-nums"
          >
            {askCount}
          </span>
        ) : null}
      </Link>
      {!open
        ? null
        : rows.map((row) => (
            <SessionRow
              key={row.session.threadId}
              environmentId={props.environmentId}
              row={row}
              selectedThreadId={props.selectedThreadId}
            />
          ))}
      {!open || (earlier.length === 0 && archived.length === 0) ? null : (
        <>
          {expanded ? (
            <>
              {earlier.map((row) => (
                <SessionRow
                  key={row.session.threadId}
                  environmentId={props.environmentId}
                  row={row}
                  selectedThreadId={props.selectedThreadId}
                />
              ))}
              {earlier.length > 0 && archived.length > 0 ? (
                <div className="pe-2 ps-7.5 pt-2 pb-1 text-sidebar-muted-foreground text-xs">
                  Archived
                </div>
              ) : null}
              {archived.map((row) => (
                <SessionRow
                  key={row.session.threadId}
                  environmentId={props.environmentId}
                  row={row}
                  selectedThreadId={props.selectedThreadId}
                  archived
                />
              ))}
            </>
          ) : null}
          <button
            type="button"
            aria-expanded={expanded}
            className={cn(rowClass, "ps-7.5 text-sidebar-muted-foreground")}
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronRightIcon
              className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
            />
            {earlier.length > 0
              ? expanded
                ? "Hide earlier"
                : `${earlier.length} earlier`
              : expanded
                ? "Hide archived"
                : "Archived"}
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
