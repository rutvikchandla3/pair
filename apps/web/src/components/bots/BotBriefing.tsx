import type {
  Bot,
  BotAsk,
  BotJob,
  BotSession,
  BotsSnapshot,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import {
  CircleCheckIcon,
  CircleIcon,
  CircleXIcon,
  LoaderCircleIcon,
  MessageCircleQuestionIcon,
  PlusIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { useProjects } from "../../state/entities";
import { botsEnvironment, useBotHomeProjectIds } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { BotAnsweredAskCard, BotAskCard } from "./BotAskCard";
import { BotDecisionRow } from "./BotDecisionRow";
import {
  BOT_EXAMPLE_JOBS,
  answeredAsks,
  botJobs,
  botSessions,
  composerProjects,
  decisionsSince,
  escalatedSessions,
  headlineChanged,
  jobGroups,
  jobProgress,
  needsYouCount,
  openAsks,
  quietMinutes,
  sessionState,
  sessionStateLabel,
  type ShellLookup,
} from "./bots.logic";

const PICK_PROJECT = "__bot_picks__";

function GroupHeader(props: {
  readonly label: string;
  readonly count?: number;
  readonly onToggle?: () => void;
  readonly right?: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-2.5 py-1 text-muted-foreground text-xs",
        props.className,
      )}
    >
      {props.onToggle === undefined ? (
        <span className="font-medium">{props.label}</span>
      ) : (
        <button
          type="button"
          className="flex items-center gap-1.5 font-medium hover:text-foreground"
          onClick={props.onToggle}
        >
          {props.label}
        </button>
      )}
      {props.count === undefined ? null : <span className="tabular-nums">{props.count}</span>}
      <span className="flex-1" />
      {props.right}
    </div>
  );
}

function JobStatusGlyph({ job }: { readonly job: BotJob }) {
  if (job.headline.trim() === "" && job.status === "working") {
    return <CircleIcon className="size-3.5 text-muted-foreground" />;
  }
  switch (job.status) {
    case "done":
      return <CircleCheckIcon className="size-3.5 text-success" />;
    case "stopped":
      return <CircleXIcon className="size-3.5 text-muted-foreground" />;
    default:
      return <LoaderCircleIcon className="size-3.5 text-muted-foreground" />;
  }
}

/** One job row: glyph, J-n, title, headline, progress label, PR chips and a relative time. */
function BotJobRow(props: {
  readonly job: BotJob;
  readonly sessions: ReadonlyArray<BotSession>;
  readonly shells: ShellLookup;
  readonly lastSeenAt: string | null;
  readonly onOpen: (jobId: string) => void;
  readonly now?: number;
}) {
  const progress = jobProgress(props.job, props.sessions, props.shells, props.now);
  return (
    <button
      type="button"
      onClick={() => props.onOpen(props.job.id)}
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-accent/60"
    >
      <JobStatusGlyph job={props.job} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="w-8 shrink-0 text-muted-foreground text-xs tabular-nums">
            J-{props.job.number}
          </span>
          <span className="min-w-0 truncate font-medium text-sm">{props.job.title}</span>
          {headlineChanged(props.job, props.lastSeenAt) ? (
            <span className="size-1.5 shrink-0 rounded-full bg-input-foreground" />
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 pl-8">
          <span className="min-w-0 truncate text-muted-foreground text-xs">
            {props.job.headline.trim() === "" ? "Waiting for Atlas" : props.job.headline}
          </span>
        </div>
      </div>
      <span
        className={cn(
          "shrink-0 whitespace-nowrap text-xs",
          progress.warning ? "text-warning" : "text-muted-foreground",
        )}
      >
        {progress.label}
      </span>
      <span className="flex shrink-0 items-center justify-end gap-1">
        {props.job.pullRequests.map((pr) => (
          <span
            key={pr.number}
            className="inline-flex h-4.5 items-center gap-0.5 rounded-full border border-border px-1.5 text-xs"
          >
            <PullRequestGlyph.pullRequest className="size-3" />#{pr.number}
          </span>
        ))}
      </span>
      <span className="w-8 shrink-0 text-right text-muted-foreground text-xs">
        <RelativeTime timestamp={props.job.updatedAt} />
      </span>
    </button>
  );
}

/** The Briefing: what needs you, what the bot decided, where each job stands, and the composer. */
export function BotBriefing(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly snapshot: BotsSnapshot;
  readonly shells: ShellLookup;
  readonly lastSeenAt: string | null;
  readonly now: number;
  readonly composerText: string;
  readonly onComposerTextChange: (text: string) => void;
  readonly onOpenJob: (jobId: string) => void;
  readonly onOpenSession: (threadId: string) => void;
  readonly onResume: () => void;
}) {
  const jobs = botJobs(props.snapshot, props.bot.id);
  const sessions = botSessions(props.snapshot, props.bot.id);
  const asks = openAsks(props.snapshot, props.bot.id);
  const escalated = escalatedSessions(props.snapshot, props.bot.id, props.shells, props.now);
  const needYou = needsYouCount(props.snapshot, props.bot.id, props.shells, props.now);
  const answeredRecent = answeredAsks(props.snapshot, props.bot.id).filter((ask) => {
    const at = Date.parse(ask.answeredAt ?? ask.createdAt);
    return Number.isFinite(at) && props.now - at <= 24 * 60 * 60 * 1000;
  });
  const decisions = decisionsSince(props.snapshot.events, props.lastSeenAt);
  const groups = jobGroups(jobs, props.now);
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  const [answeredOpen, setAnsweredOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [allOpen, setAllOpen] = useState(false);
  const [project, setProject] = useState<string>(PICK_PROJECT);
  const createJob = useAtomCommand(botsEnvironment.createJob);
  const projects = useProjects();
  const homeProjectIds = useBotHomeProjectIds(props.environmentId);
  const selectable = composerProjects(
    projects.filter((candidate) => candidate.environmentId === props.environmentId),
    homeProjectIds,
    (candidate) => candidate.id,
  );

  const submit = async () => {
    const request = props.composerText.trim();
    if (request === "" || props.bot.paused) return;
    const result = await createJob({
      environmentId: props.environmentId,
      input: {
        botId: props.bot.id,
        request,
        ...(project === PICK_PROJECT ? {} : { projectId: project as ProjectId }),
      },
    });
    toastCommandFailure("Could not start the job", result);
    if (result._tag === "Success") props.onComposerTextChange("");
  };

  const jobRow = (job: BotJob) => (
    <BotJobRow
      key={job.id}
      job={job}
      sessions={sessions}
      shells={props.shells}
      lastSeenAt={props.lastSeenAt}
      onOpen={props.onOpenJob}
      now={props.now}
    />
  );

  const jobForAsk = (ask: BotAsk): BotJob | null =>
    ask.jobId === null ? null : (jobs.find((job) => job.id === ask.jobId) ?? null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
        <div className="mx-auto flex w-full max-w-[820px] flex-col gap-3 px-2 py-4 max-sm:px-1">
          {needYou > 0 ? (
            <section>
              <GroupHeader label="Needs you" count={needYou} />
              <div className="flex flex-col gap-2">
                {asks.map((ask) => (
                  <BotAskCard
                    key={ask.id}
                    environmentId={props.environmentId}
                    bot={props.bot}
                    ask={ask}
                    job={jobForAsk(ask)}
                  />
                ))}
                {escalated.map((session) => {
                  const shell = props.shells?.get(session.threadId) ?? null;
                  const state = sessionState(session, shell, props.now);
                  const waitedMs = shell === null ? 0 : props.now - Date.parse(shell.updatedAt);
                  const job = jobs.find((candidate) => candidate.id === session.jobId) ?? null;
                  return (
                    <div
                      key={session.threadId}
                      className="rounded-lg border border-border bg-card p-3"
                    >
                      <div className="flex items-center gap-2">
                        <MessageCircleQuestionIcon className="size-3.5 shrink-0 text-input-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {session.title} has waited {quietMinutes(Math.max(0, waitedMs))}m
                        </span>
                        {job === null ? null : (
                          <span className="shrink-0 text-muted-foreground text-xs">
                            J-{job.number} · {job.title}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 pl-5.5 text-muted-foreground text-sm">
                        {sessionStateLabel(state)}. {props.bot.name} hasn&apos;t answered it.
                      </p>
                      <div className="mt-2 flex items-center gap-1.5 pl-5.5">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => props.onOpenSession(session.threadId)}
                        >
                          Answer yourself
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost-muted"
                          onClick={() => props.onOpenSession(session.threadId)}
                        >
                          Open session
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {answeredRecent.length === 0 ? null : (
            <section>
              <GroupHeader
                label="Answered"
                count={answeredRecent.length}
                onToggle={() => setAnsweredOpen(!answeredOpen)}
              />
              {answeredOpen ? (
                <div className="flex flex-col gap-2">
                  {answeredRecent.map((ask) => (
                    <BotAnsweredAskCard
                      key={ask.id}
                      environmentId={props.environmentId}
                      bot={props.bot}
                      ask={ask}
                      job={jobForAsk(ask)}
                      note={
                        ask.noteId === null
                          ? null
                          : (props.snapshot.notes.find((note) => note.id === ask.noteId) ?? null)
                      }
                    />
                  ))}
                </div>
              ) : null}
            </section>
          )}

          {decisions.length === 0 ? null : decisionsOpen ? (
            <section>
              <GroupHeader
                label="Decided for you"
                count={decisions.length}
                right={
                  <button
                    type="button"
                    className="text-xs hover:text-foreground"
                    onClick={() => setDecisionsOpen(false)}
                  >
                    Hide
                  </button>
                }
              />
              <div className="rounded-lg border border-border bg-card py-1">
                {decisions.map((event) => (
                  <BotDecisionRow
                    key={event.id}
                    environmentId={props.environmentId}
                    event={event}
                  />
                ))}
              </div>
            </section>
          ) : (
            <button
              type="button"
              className="flex items-center gap-1.5 px-2.5 py-1 text-left text-muted-foreground text-xs hover:text-foreground"
              onClick={() => setDecisionsOpen(true)}
            >
              <CircleCheckIcon className="size-3" />
              {props.bot.name} decided {decisions.length} thing
              {decisions.length === 1 ? "" : "s"} since you last looked ·{" "}
              <span className="underline">Review</span>
            </button>
          )}

          {groups.inProgress.length > 0 ? (
            <section>
              <GroupHeader label="In progress" count={groups.inProgress.length} />
              <div className="flex flex-col gap-px">{groups.inProgress.map(jobRow)}</div>
            </section>
          ) : null}

          {groups.doneThisWeek.length === 0 ? null : (
            <section>
              <GroupHeader
                label="Done this week"
                count={groups.doneThisWeek.length}
                onToggle={() => setDoneOpen(!doneOpen)}
                right={
                  <button
                    type="button"
                    className="text-xs hover:text-foreground"
                    onClick={() => setAllOpen(!allOpen)}
                  >
                    All jobs
                  </button>
                }
              />
              {doneOpen ? (
                <div className="flex flex-col gap-px">{groups.doneThisWeek.map(jobRow)}</div>
              ) : null}
            </section>
          )}

          {allOpen ? (
            <section>
              <GroupHeader label="All jobs" count={groups.all.length} />
              <div className="flex flex-col gap-px">{groups.all.map(jobRow)}</div>
            </section>
          ) : groups.doneThisWeek.length === 0 && groups.all.length > 0 ? (
            <button
              type="button"
              className="px-2.5 py-1 text-left text-muted-foreground text-xs hover:text-foreground"
              onClick={() => setAllOpen(true)}
            >
              All jobs
            </button>
          ) : null}

          {jobs.length === 0 ? (
            <div className="flex flex-col items-start gap-1.5 px-2.5">
              <p className="text-muted-foreground text-sm">
                Give {props.bot.name} a job below, or start with one of these:
              </p>
              {BOT_EXAMPLE_JOBS.map((example) => (
                <Button
                  key={example}
                  size="sm"
                  variant="outline"
                  onClick={() => props.onComposerTextChange(example)}
                >
                  <PlusIcon />
                  {example}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 border-t border-border p-2">
        <div className="mx-auto flex w-full max-w-[820px] flex-col gap-2">
          <Textarea
            size="sm"
            placeholder={`Give ${props.bot.name} a job…`}
            value={props.composerText}
            disabled={props.bot.paused}
            onChange={(event) => props.onComposerTextChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="flex items-center gap-2">
            <Select
              value={project}
              onValueChange={(value) => setProject(value ?? PICK_PROJECT)}
              disabled={props.bot.paused}
            >
              <SelectTrigger size="sm" aria-label="Project" className="max-w-56">
                <SelectValue>
                  {project === PICK_PROJECT
                    ? `${props.bot.name} picks`
                    : (selectable.find((candidate) => candidate.id === project)?.title ??
                      `${props.bot.name} picks`)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="start">
                <SelectItem value={PICK_PROJECT}>{props.bot.name} picks</SelectItem>
                {selectable.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <span className="text-muted-foreground text-xs">
              {props.bot.paused ? (
                <>
                  {props.bot.name} is paused ·{" "}
                  <button type="button" className="underline" onClick={props.onResume}>
                    Resume
                  </button>
                </>
              ) : (
                "Start job · ⌘↵"
              )}
            </span>
            <Button
              size="sm"
              className="ml-auto"
              disabled={props.bot.paused || props.composerText.trim() === ""}
              onClick={() => void submit()}
            >
              Start job
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
