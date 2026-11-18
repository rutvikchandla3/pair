import type { BotAskId, EnvironmentId, RunId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  CpuIcon,
  MessageCircleQuestionIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import type { BotChatOptions } from "../chat/botChat";
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
import { Toggle } from "../ui/toggle";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { BotAvatar } from "./BotAvatar";
import { BotMemoryPanel } from "./BotMemoryPanel";
import { BotRenameDialog } from "./BotRenameDialog";
import { BotSettingsDialog } from "./BotSettingsDialog";
import { botSessions, botStatusLine, sessionState, type ShellLookup } from "./bots.logic";

const EMBEDDED_PANEL: SideChatParentPanel = {
  openToolDiff: () => {},
  runShellCommand: () => {},
};

/** A bot's page: header, the home thread's ChatView, and the Memory panel. */
export function BotPage(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly askId: BotAskId | null;
}) {
  const snapshot = useBotsSnapshot(props.environmentId);
  const navigate = useNavigate();
  const shells = useQuietThreadShells();
  const shellMap: ShellLookup = new Map(
    shells
      .filter((shell) => shell.environmentId === props.environmentId)
      .map((shell) => [shell.id, shell] as const),
  );
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [focusState, setFocusState] = useState<{
    readonly runId: RunId;
    readonly nonce: number;
    readonly askId: string | null;
  } | null>(null);
  const now = useBotsNow();
  const pause = useAtomCommand(botsEnvironment.pause);
  const resume = useAtomCommand(botsEnvironment.resume);
  const remove = useAtomCommand(botsEnvironment.remove);

  if (snapshot === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  const bot = snapshot.bots.find((candidate) => candidate.id === props.botId) ?? null;
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

  // The URL's ask scrolls the chat once it resolves; a new ask id scrolls again. The button
  // below uses the same counter, and the render-phase adjustment keeps one nonce per source.
  const routeAsk =
    props.askId === null
      ? null
      : (snapshot.asks.find((candidate) => candidate.id === props.askId) ?? null);
  if (routeAsk !== null && routeAsk.homeRunId !== null && focusState?.askId !== routeAsk.id) {
    setFocusState({
      runId: routeAsk.homeRunId,
      nonce: (focusState?.nonce ?? 0) + 1,
      askId: routeAsk.id,
    });
  }
  const focus: BotChatOptions["focus"] =
    focusState === null ? null : { runId: focusState.runId, nonce: focusState.nonce };

  const status = botStatusLine(snapshot, bot, shellMap, now);
  const sessions = botSessions(snapshot, bot.id);
  const runningSessions = sessions.filter((session) => {
    const state = sessionState(session, shellMap.get(session.threadId) ?? null, now);
    return state.kind === "working" || state.kind === "quiet";
  }).length;

  const focusAsk = (runId: RunId | null) => {
    if (runId === null) return;
    setFocusState((current) => ({
      runId,
      nonce: (current?.nonce ?? 0) + 1,
      askId: current?.askId ?? null,
    }));
  };

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

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border p-3">
        <BotAvatar bot={bot} size="lg" />
        <h1 className="font-medium text-base">{bot.name}</h1>
        {status.kind === "needs" ? (
          <button
            type="button"
            onClick={() => focusAsk(status.focusRunId)}
            className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-input-foreground text-xs whitespace-nowrap hover:bg-accent"
          >
            <MessageCircleQuestionIcon className="size-3" />
            {status.label}
            <ChevronRightIcon className="size-3" />
          </button>
        ) : (
          <span className="truncate text-muted-foreground text-xs whitespace-nowrap">
            {status.label}
          </span>
        )}
        <span className="flex-1" />
        <Toggle
          variant="ghost"
          size="sm"
          pressed={memoryOpen}
          onPressedChange={setMemoryOpen}
          aria-label="Memory"
        >
          <SparklesIcon />
          Memory
        </Toggle>
        <Menu>
          <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Bot menu" />}>
            <MoreHorizontalIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => void togglePause()}>
              {bot.paused ? <PlayIcon /> : <PauseIcon />}
              {bot.paused ? `Resume ${bot.name}` : `Pause ${bot.name}`}
            </MenuItem>
            <MenuItem onClick={() => setSettingsOpen(true)}>
              <CpuIcon />
              Models…
            </MenuItem>
            <MenuItem onClick={() => setRenameOpen(true)}>
              <PencilIcon />
              Rename…
            </MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2Icon />
              Delete bot…
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {bot.paused ? (
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
              <PauseIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <p className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
                {bot.name} is paused. Its sessions keep running; their questions wait here.
              </p>
              <Button size="xs" onClick={() => void togglePause()}>
                Resume
              </Button>
            </div>
          ) : null}
          {bot.homeThreadId === null ? (
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
                  bot={{ name: bot.name, focus }}
                />
              </ComposerHandleContext>
            </BackgroundThreadContext>
          )}
        </div>

        {memoryOpen ? (
          <div className="fixed inset-0 z-30 md:static md:z-auto md:w-[380px] md:shrink-0 md:border-l md:border-border">
            <BotMemoryPanel
              key={bot.id}
              environmentId={props.environmentId}
              bot={bot}
              snapshot={snapshot}
              onClose={() => setMemoryOpen(false)}
            />
          </div>
        ) : null}
      </div>

      <BotSettingsDialog
        key={`${bot.id}:${settingsOpen}`}
        environmentId={props.environmentId}
        bot={bot}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />

      <BotRenameDialog
        key={`${bot.id}:${renameOpen}`}
        environmentId={props.environmentId}
        bot={bot}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {bot.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              All {sessions.length} of its session{sessions.length === 1 ? "" : "s"} move into
              Threads ({runningSessions} {runningSessions === 1 ? "is" : "are"} still running and
              keep going). Its notes are deleted.
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
