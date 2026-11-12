import {
  type SpacePairFeedItem,
  type SpacePairReply,
  type SpacePairRoom,
  spaceActionView,
  spacePairStatusLine,
} from "@t3tools/client-runtime/spaceAgent";
import type { SpaceViewer } from "@t3tools/client-runtime/spaces";
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
  Space,
  SpaceAction,
  ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { UndoIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useNowAfter } from "../../hooks/useDeadline";
import { useAssistantMessageText } from "../../state/entities";
import { spaceAgentEnvironment } from "../../state/spaceAgent";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { PairMark } from "../PairMark";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const formatTime = (iso: string) => timeFormat.format(new Date(iso));

export interface SpacePairFeedContext {
  readonly environmentId: EnvironmentId;
  readonly roomRef: ScopedThreadRef;
  readonly space: Space;
  readonly viewer: SpaceViewer;
  readonly pairRoom: SpacePairRoom;
  readonly tasksById: ReadonlyMap<string, OrchestrationV2ThreadShell>;
  readonly onAskAgain: (text: string) => void;
}

function TaskChip(props: {
  readonly environmentId: EnvironmentId;
  readonly taskId: ThreadId | null;
  readonly title: string | null;
}) {
  if (props.title === null) return null;
  if (props.taskId === null) return <span className="font-medium">{props.title}</span>;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: props.environmentId, threadId: props.taskId }}
      className="font-medium text-foreground hover:underline"
    >
      {props.title}
    </Link>
  );
}

/** One record, receipt or confirm card, collapsed to a line once answered. */
function SpaceActionRow(props: {
  readonly action: SpaceAction;
  readonly context: SpacePairFeedContext;
}) {
  const { action, context } = props;
  const run = useAtomCommand(spaceAgentEnvironment.action, "Update @pair action");
  const [busy, setBusy] = useState(false);
  // A confirm card turns into "expired" when its deadline passes, without a refresh.
  const expiresAt = action.state === "proposed" ? action.proposal?.expiresAt : undefined;
  const now = useNowAfter(expiresAt === undefined ? null : Date.parse(expiresAt));
  const view = spaceActionView(action, {
    viewer: context.viewer,
    now,
    taskStarted: (threadId) => {
      const task = context.tasksById.get(threadId);
      return task === undefined ? null : task.latestRunId !== null;
    },
  });
  const send = async (input: Parameters<typeof run>[0]["input"], label: string) => {
    setBusy(true);
    const result = await run({ environmentId: context.environmentId, input });
    setBusy(false);
    toastCommandFailure(label, result);
  };
  const undo = () => void send({ type: "undo", actionId: action.id }, "Could not undo");
  const time = <span className="tabular-nums">· {formatTime(action.updatedAt)}</span>;
  const undoButton = (
    <Button size="micro" variant="ghost-muted" disabled={busy} onClick={undo}>
      <UndoIcon />
      Undo
    </Button>
  );

  switch (view.kind) {
    case "confirm":
      return (
        <div className="flex max-w-xl flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm">
          <div className="text-muted-foreground text-xs">
            <TaskChip
              environmentId={context.environmentId}
              taskId={view.taskId}
              title={view.title}
            />{" "}
            · for {view.ownerName}
          </div>
          <p className="font-medium">Send this to {view.title}?</p>
          <p className="whitespace-pre-wrap border-border border-l-2 pl-2 text-muted-foreground">
            {view.text}
          </p>
          <p className="text-muted-foreground text-xs">
            It waits behind the task's current work and never interrupts it. Undo removes it while
            it's queued.{view.asAdmin ? " You can send it as a team admin." : ""}
          </p>
          {view.canAnswer ? (
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                disabled={busy}
                onClick={() =>
                  void send(
                    { type: "answer", actionId: action.id, answer: "confirm" },
                    "Could not send",
                  )
                }
              >
                Send message
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void send(
                    { type: "answer", actionId: action.id, answer: "cancel" },
                    "Could not cancel",
                  )
                }
              >
                Cancel
              </Button>
              <span className="text-muted-foreground text-xs">Only you can answer this</span>
            </div>
          ) : (
            <span className="text-muted-foreground text-xs">Waiting for {view.waitingFor}</span>
          )}
        </div>
      );
    case "record":
      return (
        <div className="flex flex-col gap-0.5 text-muted-foreground text-xs">
          <div className="flex flex-wrap items-center gap-x-1">
            <span>{view.lead}</span>
            <TaskChip
              environmentId={context.environmentId}
              taskId={view.taskId}
              title={view.title}
            />
            <span>{view.detail}</span>
            {time}
            {view.canUndo ? undoButton : null}
          </div>
          {view.quote === null ? null : (
            <span className="line-clamp-2 border-border border-l-2 pl-2">{view.quote}</span>
          )}
        </div>
      );
    case "receipt":
      return (
        <div className="flex flex-col gap-0.5 text-muted-foreground text-xs">
          {view.lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
          <div className="flex flex-wrap items-center gap-x-1">
            <span>{view.detail}</span>
            {time}
            {view.canUndo ? undoButton : null}
          </div>
        </div>
      );
    case "closed":
      return (
        <div className="flex flex-wrap items-center gap-x-1 text-muted-foreground text-xs">
          <TaskChip environmentId={context.environmentId} taskId={view.taskId} title={view.title} />
          <span>{view.text}</span>
          {time}
          {view.askAgain === null ? null : (
            <Button
              size="micro"
              variant="ghost-muted"
              onClick={() => context.onAskAgain(view.askAgain!)}
            >
              Ask again
            </Button>
          )}
        </div>
      );
  }
}

function SpacePairText(props: { readonly roomRef: ScopedThreadRef; readonly itemId: string }) {
  const text = useAssistantMessageText(props.roomRef, props.itemId);
  if (text === null || text.length === 0) return null;
  return <ChatMarkdown text={text} cwd={undefined} className="text-sm" />;
}

/** Pair's reply: its streamed text, then the records of what it did, from events. */
export function SpacePairFeedRow(props: {
  readonly item: SpacePairFeedItem;
  readonly context: SpacePairFeedContext;
}) {
  const { item, context } = props;
  const reply = item.reply;
  return (
    <div className="flex gap-2.5 px-4 pt-2 pb-0.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent">
        <PairMark className="size-4" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-sm">Pair</span>
          <span className="text-muted-foreground text-xs">agent</span>
          {reply?.taggerId == null ? null : (
            <span className="text-muted-foreground text-xs">
              replying to{" "}
              {reply.taggerId === context.viewer.memberId
                ? "you"
                : context.viewer.nameOf(reply.taggerId)}
            </span>
          )}
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatTime(item.createdAt)}
          </span>
        </div>
        {reply === null
          ? null
          : reply.textItemIds.map((itemId) => (
              <SpacePairText key={itemId} roomRef={context.roomRef} itemId={itemId} />
            ))}
        {item.actions.map((action) => (
          <SpaceActionRow key={action.id} action={action} context={context} />
        ))}
      </div>
    </div>
  );
}

/** Under a post that tagged `@pair`: queued, replying, failed, stopped or cancelled. */
export function SpacePairStatus(props: {
  readonly reply: SpacePairReply | undefined;
  readonly context: SpacePairFeedContext;
}) {
  const { context, reply } = props;
  const control = useAtomCommand(spaceAgentEnvironment.reply, "Update @pair reply");
  const [busy, setBusy] = useState(false);
  const line = spacePairStatusLine(
    reply,
    context.pairRoom,
    context.space,
    context.viewer,
    formatTime,
  );
  if (line === null || reply === undefined) return null;
  const act = async (action: "cancel" | "stop" | "retry") => {
    setBusy(true);
    const result = await control({
      environmentId: context.environmentId,
      input: { spaceId: context.space.id, runId: reply.runId, action },
    });
    setBusy(false);
    toastCommandFailure(
      action === "retry"
        ? "Could not retry"
        : action === "stop"
          ? "Could not stop"
          : "Could not cancel",
      result,
    );
  };
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-1 text-xs",
        line.tone === "error" ? "text-destructive-foreground" : "text-muted-foreground",
      )}
    >
      <span>{line.text}</span>
      {line.control === null ? null : (
        <>
          <span aria-hidden>·</span>
          <Button
            size="micro"
            variant="ghost-muted"
            disabled={busy}
            onClick={() => void act(line.control!)}
          >
            {line.control === "retry" ? "Retry" : line.control === "stop" ? "Stop" : "Cancel"}
          </Button>
        </>
      )}
    </div>
  );
}
