import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MoreHorizontalIcon, PauseIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { useQuietThreadShells } from "../../state/entities";
import { botsEnvironment, useBotsNow, useBotsSnapshot } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { ComposerHandleContext } from "../../composerHandleContext";
import { Spinner } from "../ui/spinner";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { BotAvatar } from "./BotAvatar";
import { BotBriefing } from "./BotBriefing";
import { BotJobPanel } from "./BotJobPanel";
import { BotPlaybook } from "./BotPlaybook";
import { BotSettingsDialog } from "./BotSettingsDialog";
import { botSummary, botSessions, sessionState, type ShellLookup } from "./bots.logic";

export type BotTab = "briefing" | "chat" | "playbook";

const TABS: ReadonlyArray<{ readonly value: BotTab; readonly label: string }> = [
  { value: "briefing", label: "Briefing" },
  { value: "chat", label: "Chat" },
  { value: "playbook", label: "Playbook" },
];

const EMBEDDED_PANEL: SideChatParentPanel = {
  openToolDiff: () => {},
  runShellCommand: () => {},
};

function TabSegmented(props: {
  readonly tab: BotTab;
  readonly onChange: (tab: BotTab) => void;
  readonly playbook: boolean;
}) {
  return (
    <div className="inline-flex items-center rounded-lg bg-muted p-0.5">
      {TABS.filter((entry) => props.playbook || entry.value !== "playbook").map((entry) => (
        <button
          key={entry.value}
          type="button"
          className={cn(
            "rounded-md px-2.5 py-1 text-sm",
            entry.value === props.tab
              ? "bg-background font-medium text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => props.onChange(entry.value)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

/** A bot's page: header, tabs, and the tab bodies; the job panel overlays the Briefing. */
export function BotPage(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly tab: BotTab;
  readonly jobId: string | null;
  readonly onTabChange: (tab: BotTab) => void;
  readonly onOpenJob: (jobId: string) => void;
  readonly onCloseJob: () => void;
}) {
  const snapshot = useBotsSnapshot(props.environmentId);
  const navigate = useNavigate();
  const shells = useQuietThreadShells();
  const shellMap: ShellLookup = new Map(
    shells
      .filter((shell) => shell.environmentId === props.environmentId)
      .map((shell) => [shell.id, shell] as const),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [visitMark, setVisitMark] = useState<{
    readonly botId: string;
    readonly lastSeenAt: string | null;
  } | null>(null);
  const bot = snapshot?.bots.find((candidate) => candidate.id === props.botId) ?? null;
  // Capture the visit mark once, before markSeen moves it, so the Briefing's counts hold still.
  if (bot !== null && visitMark?.botId !== bot.id) {
    setVisitMark({ botId: bot.id, lastSeenAt: bot.lastSeenAt });
  }
  const now = useBotsNow();
  const pause = useAtomCommand(botsEnvironment.pause);
  const resume = useAtomCommand(botsEnvironment.resume);
  const remove = useAtomCommand(botsEnvironment.remove);
  const markSeen = useAtomCommand(botsEnvironment.markSeen, { reportFailure: false });
  const seen = useRef(false);

  // Mark seen once per visit, after the first render.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one bots.markSeen call per page visit
  useEffect(() => {
    if (bot === null || seen.current) return;
    seen.current = true;
    void markSeen({
      environmentId: props.environmentId,
      input: { botId: bot.id },
    });
  }, [bot, markSeen, props.environmentId]);

  if (snapshot === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (bot === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <p className="text-muted-foreground text-sm">This bot no longer exists.</p>
        <Button variant="outline" onClick={() => void navigate({ to: "/bots" })}>
          Back to bots
        </Button>
      </div>
    );
  }

  const lastSeenAt = visitMark?.botId === bot.id ? visitMark.lastSeenAt : bot.lastSeenAt;
  const summary = botSummary(snapshot, bot.id, shellMap, now);
  const sessions = botSessions(snapshot, bot.id);
  const runningSessions = sessions.filter((session) => {
    const state = sessionState(session, shellMap.get(session.threadId) ?? null, now);
    return state.kind === "working" || state.kind === "quiet";
  }).length;
  const job =
    props.jobId === null ? null : (snapshot.jobs.find((entry) => entry.id === props.jobId) ?? null);

  const togglePause = async () => {
    if (bot.paused) {
      const result = await resume({ environmentId: props.environmentId, input: { botId: bot.id } });
      toastCommandFailure("Could not resume the bot", result);
    } else {
      const result = await pause({ environmentId: props.environmentId, input: { botId: bot.id } });
      toastCommandFailure("Could not pause the bot", result);
    }
  };

  const deleteBot = async () => {
    const result = await remove({ environmentId: props.environmentId, input: { botId: bot.id } });
    toastCommandFailure("Could not delete the bot", result);
    if (result._tag === "Success") {
      setConfirmDelete(false);
      void navigate({ to: "/bots" });
    }
  };

  const playbook = props.tab === "playbook";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border p-3">
        <div className="flex items-center gap-3">
          <BotAvatar bot={bot} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <h1 className="font-medium text-base">{bot.name}</h1>
              {bot.charter.trim() === "" ? null : (
                <span className="min-w-0 truncate text-muted-foreground text-sm">
                  {bot.charter}
                </span>
              )}
            </div>
            <div className="truncate text-muted-foreground text-xs">{summary.label}</div>
          </div>
          <TabSegmented tab={props.tab} onChange={props.onTabChange} playbook={true} />
          <Menu>
            <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Bot menu" />}>
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => void togglePause()}>
                <PauseIcon />
                {bot.paused ? `Resume ${bot.name}` : `Pause ${bot.name}`}
              </MenuItem>
              <MenuItem onClick={() => setSettingsOpen(true)}>
                <SettingsIcon />
                Settings
              </MenuItem>
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2Icon />
                Delete bot…
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
        {bot.paused ? (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-border px-2.5 py-2">
            <PauseIcon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-sm">{bot.name} is paused</p>
              <p className="text-muted-foreground text-xs">
                Its sessions keep running; their questions come to you.
              </p>
            </div>
            <Button size="sm" onClick={() => void togglePause()}>
              Resume
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {props.tab === "briefing" ? (
            <BotBriefing
              environmentId={props.environmentId}
              bot={bot}
              snapshot={snapshot}
              shells={shellMap}
              lastSeenAt={lastSeenAt}
              now={now}
              composerText={composerText}
              onComposerTextChange={setComposerText}
              onOpenJob={props.onOpenJob}
              onOpenSession={(threadId) =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId: props.environmentId, threadId },
                })
              }
              onResume={() => void togglePause()}
            />
          ) : null}
          {props.tab === "chat" ? (
            bot.homeThreadId === null ? (
              <div className="flex flex-1 items-center justify-center">
                <p className="text-muted-foreground text-sm">{bot.name} is starting…</p>
              </div>
            ) : (
              <BackgroundThreadContext value>
                <ComposerHandleContext value={null}>
                  <ChatView
                    environmentId={props.environmentId}
                    threadId={bot.homeThreadId}
                    routeKind="server"
                    embedded={EMBEDDED_PANEL}
                  />
                </ComposerHandleContext>
              </BackgroundThreadContext>
            )
          ) : null}
          {playbook ? (
            <BotPlaybook environmentId={props.environmentId} bot={bot} snapshot={snapshot} />
          ) : null}
        </div>

        {job === null ? null : (
          <div className="fixed inset-0 z-30 bg-background md:static md:z-auto md:w-[420px] md:shrink-0">
            <BotJobPanel
              environmentId={props.environmentId}
              bot={bot}
              job={job}
              snapshot={snapshot}
              shells={shellMap}
              now={now}
              onClose={props.onCloseJob}
              onOpenSession={(threadId) =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId: props.environmentId, threadId },
                })
              }
              onMessageAboutJob={() => {
                props.onTabChange("chat");
                props.onCloseJob();
              }}
              onStartSuggestedJob={(request) => {
                setComposerText(request);
                props.onTabChange("briefing");
                props.onCloseJob();
              }}
            />
          </div>
        )}
      </div>

      <BotSettingsDialog
        key={`${bot.id}:${settingsOpen}`}
        environmentId={props.environmentId}
        bot={bot}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {bot.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              All {sessions.length} of its session{sessions.length === 1 ? "" : "s"} move into
              Threads ({runningSessions} {runningSessions === 1 ? "is" : "are"} still running and
              keep going). Its jobs and notes are deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => void deleteBot()}>
              Delete {bot.name}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
