import type {
  Bot,
  BotAsk,
  BotEvent,
  BotJob,
  BotSession,
  BotsSnapshot,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import {
  CircleCheckIcon,
  CircleIcon,
  CircleXIcon,
  LoaderCircleIcon,
  MessageCircleQuestionIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { RelativeTime } from "../RelativeTime";
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
import { useThreadProjection } from "../../state/entities";
import { botsEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { BotDecisionRow } from "./BotDecisionRow";
import {
  botSessions,
  jobAnsweredAsks,
  jobDecisions,
  jobProgress,
  jobTimeline,
  sessionState,
  sessionStateLabel,
  type ShellLookup,
} from "./bots.logic";

function latestAssistantLine(projection: EnvironmentThread | null): string | null {
  if (projection === null) return null;
  for (let index = projection.projection.visibleTurnItems.length - 1; index >= 0; index -= 1) {
    const item = projection.projection.visibleTurnItems[index]?.item;
    if (item?.type === "assistant_message" && item.text.trim() !== "") {
      return item.text;
    }
  }
  return null;
}

function SessionLastLine(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const projection = useThreadProjection(scopeThreadRef(props.environmentId, props.threadId));
  const line = latestAssistantLine(projection);
  if (line === null) return null;
  const collapsed = line.replace(/\s+/gu, " ").slice(0, 160);
  return <div className="truncate text-muted-foreground text-xs">{collapsed}</div>;
}

function StatusPill(props: { readonly status: "working" | "needs-you" | "done" | "stopped" }) {
  const label =
    props.status === "needs-you"
      ? "Needs you"
      : props.status === "done"
        ? "Done"
        : props.status === "stopped"
          ? "Stopped"
          : "Working";
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-xs",
        props.status === "needs-you" ? "border-input-foreground/40 text-input-foreground" : "",
        props.status === "done" ? "border-success/40 text-success" : "",
      )}
    >
      {label}
    </span>
  );
}

function SectionLabel(props: {
  readonly children: React.ReactNode;
  readonly right?: React.ReactNode;
}) {
  return (
    <div className="mt-3 mb-1 flex items-center gap-2 text-muted-foreground text-xs">
      <span className="font-medium">{props.children}</span>
      <span className="flex-1" />
      {props.right}
    </div>
  );
}

const SESSION_GLYPH: Readonly<Record<string, React.ReactNode>> = {
  done: <CircleCheckIcon className="size-3.5 text-success" />,
  failed: <CircleXIcon className="size-3.5 text-destructive" />,
  stopped: <CircleXIcon className="size-3.5 text-muted-foreground" />,
  "paused-until": <CircleIcon className="size-3.5 text-warning" />,
  "taken-over": <CircleIcon className="size-3.5 text-muted-foreground" />,
  working: <LoaderCircleIcon className="size-3.5 text-muted-foreground" />,
  quiet: <LoaderCircleIcon className="size-3.5 text-warning" />,
  waiting: <MessageCircleQuestionIcon className="size-3.5 text-input-foreground" />,
};

/** One session row: state, latest line, PR chip, Open, and Hand back when you took over. */
function SessionRow(props: {
  readonly environmentId: EnvironmentId;
  readonly session: BotSession;
  readonly shells: ShellLookup;
  readonly now: number;
  readonly onOpenSession: (threadId: ThreadId) => void;
}) {
  const handBack = useAtomCommand(botsEnvironment.handBackSession);
  const shell = props.shells?.get(props.session.threadId) ?? null;
  const state = sessionState(props.session, shell, props.now);
  return (
    <div className="flex items-start gap-2 py-1.5">
      <span className="mt-0.5 shrink-0">{SESSION_GLYPH[state.kind]}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 truncate font-medium text-sm">{props.session.title}</span>
          <span
            className={cn(
              "text-xs",
              state.kind === "failed"
                ? "text-destructive"
                : state.kind === "quiet" || state.kind === "paused-until"
                  ? "text-warning"
                  : "text-muted-foreground",
            )}
          >
            {sessionStateLabel(state)}
          </span>
        </div>
        {shell === null ? null : (
          <SessionLastLine environmentId={props.environmentId} threadId={props.session.threadId} />
        )}
      </div>
      {state.kind === "taken-over" ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void handBack({
              environmentId: props.environmentId,
              input: { threadId: props.session.threadId },
            }).then((result) => toastCommandFailure("Could not hand back", result))
          }
        >
          Hand back
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => props.onOpenSession(props.session.threadId)}>
        Open
      </Button>
    </div>
  );
}

/** A job's detail: request, sessions, decisions, timeline, report and a Stop or Reopen. */
export function BotJobPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly job: BotJob;
  readonly snapshot: BotsSnapshot;
  readonly shells: ShellLookup;
  readonly now: number;
  readonly onClose: () => void;
  readonly onOpenSession: (threadId: ThreadId) => void;
  readonly onMessageAboutJob: () => void;
  readonly onStartSuggestedJob: (request: string) => void;
}) {
  const stopJob = useAtomCommand(botsEnvironment.stopJob);
  const reopenJob = useAtomCommand(botsEnvironment.reopenJob);
  const [confirmStop, setConfirmStop] = useState(false);
  const sessions = botSessions(props.snapshot, props.bot.id).filter(
    (session) => session.jobId === props.job.id,
  );
  const runningSessions = sessions.filter((session) => {
    const state = sessionState(session, props.shells?.get(session.threadId) ?? null, props.now);
    return state.kind === "working" || state.kind === "quiet";
  }).length;
  const openAsk = props.snapshot.asks.find(
    (ask) => ask.jobId === props.job.id && ask.status === "open",
  );
  const decisions = jobDecisions(props.snapshot.events, props.job.id);
  const timeline = jobTimeline(props.snapshot.events, props.job.id);
  const answered: ReadonlyArray<BotAsk> = jobAnsweredAsks(props.snapshot, props.job.id);
  const progress = jobProgress(props.job, sessions, props.shells, props.now);
  const report = props.job.report;
  const status = openAsk !== undefined ? "needs-you" : props.job.status;
  const isStoppable = props.job.status === "working";

  const stop = async () => {
    const result = await stopJob({
      environmentId: props.environmentId,
      input: { jobId: props.job.id },
    });
    toastCommandFailure("Could not stop the job", result);
    if (result._tag === "Success") setConfirmStop(false);
  };
  const reopen = async () => {
    const result = await reopenJob({
      environmentId: props.environmentId,
      input: { jobId: props.job.id },
    });
    toastCommandFailure("Could not reopen the job", result);
  };

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border bg-background">
      <div className="shrink-0 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <LoaderCircleIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
            J-{props.job.number}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium text-sm">{props.job.title}</span>
          <StatusPill status={status} />
          <Menu>
            <MenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label="Job menu" />}>
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              {isStoppable ? (
                <MenuItem
                  variant="destructive"
                  onClick={() => {
                    setConfirmStop(true);
                  }}
                >
                  <CircleXIcon />
                  Stop job…
                </MenuItem>
              ) : (
                <MenuItem onClick={() => void reopen()}>
                  <RotateCcwIcon />
                  Reopen
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem onClick={props.onMessageAboutJob}>
                <MessageCircleQuestionIcon />
                Message about J-{props.job.number}
              </MenuItem>
            </MenuPopup>
          </Menu>
          <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={props.onClose}>
            <CircleXIcon />
          </Button>
        </div>
        <p className="mt-1 pl-5.5 text-muted-foreground text-xs">
          {props.job.headline.trim() === "" ? `Waiting for ${props.bot.name}` : props.job.headline}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="text-muted-foreground text-xs">
          Your request · <RelativeTime timestamp={props.job.createdAt} />
        </div>
        <div className="mt-1 rounded-md border border-border p-2 text-sm">{props.job.request}</div>

        <SectionLabel
          right={
            <span className="text-muted-foreground/70">
              on {props.bot.models.worker.instanceId} · {props.bot.models.worker.model}
            </span>
          }
        >
          Sessions · {progress.label}
        </SectionLabel>
        <div className="flex flex-col divide-y divide-border">
          {sessions.length === 0 ? (
            <p className="py-1 text-muted-foreground text-sm">No sessions yet.</p>
          ) : (
            sessions.map((session) => (
              <SessionRow
                key={session.threadId}
                environmentId={props.environmentId}
                session={session}
                shells={props.shells}
                now={props.now}
                onOpenSession={props.onOpenSession}
              />
            ))
          )}
        </div>

        {decisions.length > 0 ? (
          <>
            <SectionLabel>Decided for you · {decisions.length}</SectionLabel>
            <div className="rounded-lg border border-border bg-card py-1">
              {decisions.map((event) => (
                <BotDecisionRow key={event.id} environmentId={props.environmentId} event={event} />
              ))}
            </div>
          </>
        ) : null}

        {report !== null ? (
          <>
            <SectionLabel>What changed</SectionLabel>
            <p className="text-sm">{report.changed}</p>
            {report.evidence.length > 0 ? (
              <>
                <SectionLabel>Evidence</SectionLabel>
                <ul className="flex flex-col gap-1 text-sm">
                  {report.evidence.map((line) => (
                    <li key={line} className="text-muted-foreground">
                      {line}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {props.job.pullRequests.length > 0 ? (
              <>
                <SectionLabel>Pull requests</SectionLabel>
                <div className="flex flex-wrap gap-1">
                  {props.job.pullRequests.map((pr) => (
                    <a
                      key={pr.number}
                      href={pr.url}
                      className="rounded-full border border-border px-1.5 text-xs"
                    >
                      #{pr.number}
                    </a>
                  ))}
                </div>
              </>
            ) : null}
            <SectionLabel>You decided · {answered.length}</SectionLabel>
            {answered.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing.</p>
            ) : (
              answered.map((ask) => (
                <div key={ask.id} className="flex gap-2 py-0.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {ask.question} <span className="text-muted-foreground">→</span>{" "}
                    <span className="font-medium">{ask.answer}</span>
                  </span>
                </div>
              ))
            )}
            {report.openQuestions.length > 0 ? (
              <>
                <SectionLabel>Open questions</SectionLabel>
                <ul className="flex flex-col gap-1 text-sm">
                  {report.openQuestions.map((question) => (
                    <li key={question} className="text-muted-foreground">
                      {question}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {report.next === null ? null : (
              <>
                <SectionLabel>Next</SectionLabel>
                <div className="rounded-md border border-border p-2 text-sm">
                  <p>{report.next.text}</p>
                  {report.next.suggestedRequest === null ? null : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2"
                      onClick={() => props.onStartSuggestedJob(report.next?.suggestedRequest ?? "")}
                    >
                      <PlusIcon />
                      Start job
                    </Button>
                  )}
                </div>
              </>
            )}
          </>
        ) : null}

        <SectionLabel>Timeline</SectionLabel>
        <Timeline events={timeline} />
      </div>

      <div className="shrink-0 border-t border-border p-2">
        <Button
          size="sm"
          variant="outline"
          className="w-full justify-center"
          onClick={props.onMessageAboutJob}
        >
          <MessageCircleQuestionIcon />
          Message {props.bot.name} about this job
        </Button>
      </div>

      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Stop J-{props.job.number} and its {runningSessions} running session
              {runningSessions === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They stop where they are. Their worktrees and PRs stay. You can reopen the job later
              and {props.bot.name} picks it up from there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => void stop()}>
              Stop job
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function Timeline({ events }: { readonly events: ReadonlyArray<BotEvent> }) {
  if (events.length === 0) {
    return <p className="text-muted-foreground text-sm">Nothing yet.</p>;
  }
  return (
    <div className="flex flex-col">
      {events.map((event) => (
        <div key={event.id} className="flex items-start gap-2.5 py-1">
          <CircleCheckIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-xs">{event.text}</span>
          <span className="shrink-0 text-muted-foreground text-xs">
            <RelativeTime timestamp={event.createdAt} />
          </span>
        </div>
      ))}
    </div>
  );
}
