import {
  type SpaceRecordContext,
  type SpaceTaskLineEntry,
  type SpaceViewer,
  spaceRecordText,
  spaceStatusUndo,
  spaceTaskStatusInfo,
} from "@t3tools/client-runtime/spaces";
import type {
  EnvironmentId,
  Space,
  SpaceId,
  SpaceRoomEntry,
  SpaceTask,
  SpaceTaskId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CircleArrowRightIcon, Undo2Icon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { spaceEnvironment } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SpaceTaskStatusGlyph } from "./SpaceStatusIcon";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
export const formatSpaceTime = (iso: string) => timeFormat.format(new Date(iso));

/** A task as a chip: its status and title, opening the task page. */
export function SpaceTaskChip(props: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
  readonly taskId: SpaceTaskId;
  readonly task: Pick<SpaceTask, "title" | "status"> | null;
  readonly showStatus?: boolean;
}) {
  const status = props.task === null ? null : spaceTaskStatusInfo(props.task.status);
  return (
    <Link
      to="/spaces/$environmentId/$spaceId/tasks/$taskId"
      params={{
        environmentId: props.environmentId,
        spaceId: props.spaceId,
        taskId: props.taskId,
      }}
      className="-mx-px inline-flex max-w-full items-center gap-1 rounded px-1 align-bottom font-medium text-foreground text-sm hover:bg-accent"
    >
      {status === null ? null : (
        <SpaceTaskStatusGlyph icon={status.icon} tone={status.tone} label={status.label} />
      )}
      <span className="truncate">{props.task?.title ?? "A task"}</span>
      {props.showStatus === true && status !== null ? (
        <span className="shrink-0 font-normal text-muted-foreground">{status.label}</span>
      ) : null}
    </Link>
  );
}

/** Undo on an agent's or `@pair`'s status move, or why it's no longer offered. */
export function SpaceStatusUndoButton(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly entry: SpaceRoomEntry;
  readonly task: SpaceTask | null;
  readonly entries: ReadonlyArray<SpaceRoomEntry>;
  readonly viewer: SpaceViewer;
}) {
  const undoStatus = useAtomCommand(spaceEnvironment.undoTaskStatus, "Undo status move");
  const [busy, setBusy] = useState(false);
  const undo = spaceStatusUndo(props.entry, props.task, props.space, props.viewer, props.entries);
  if (undo === null) return null;
  if (undo.state === "disabled") {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button size="micro" variant="ghost-muted" disabled>
            Undo
          </Button>
        </TooltipTrigger>
        <TooltipPopup>{undo.tooltip}</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Button
      size="micro"
      variant="ghost-muted"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const result = await undoStatus({ environmentId: props.environmentId, input: undo.input });
        setBusy(false);
        toastCommandFailure("Could not undo", result);
      }}
    >
      Undo
    </Button>
  );
}

export interface SpaceRecordLineProps {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly entry: SpaceTaskLineEntry;
  /** Every entry the line renders among, for which moves were undone. */
  readonly entries: ReadonlyArray<SpaceRoomEntry>;
  readonly taskOf: (taskId: SpaceTaskId) => SpaceTask | null;
  readonly context: SpaceRecordContext;
  readonly className?: string;
}

/**
 * A room record line, as the board's `.sys`: muted 12/22 text, no avatar, the actor plain, and a
 * leading icon only for moves and undos. The caller adds the feed's indent and spacing.
 */
export function SpaceSystemLine(props: {
  readonly icon?: ReactNode;
  readonly muted?: boolean;
  readonly createdAt: string;
  readonly className?: string;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "min-w-0 break-words text-muted-foreground text-xs leading-5.5",
        props.muted === true && "opacity-64",
        props.className,
      )}
    >
      {props.icon}
      {props.children}
      <span className="whitespace-nowrap tabular-nums"> · {formatSpaceTime(props.createdAt)}</span>
      {props.trailing === undefined ? null : <> {props.trailing}</>}
    </div>
  );
}

const lineIconClass = "me-1 inline size-3 align-middle";

/** One task line: "[lead] Agent moved [chip] to In review · asked by you · 11:12 · Undo". */
export function SpaceRecordLine(props: SpaceRecordLineProps) {
  const { entry, context } = props;
  const view = spaceRecordText(entry, context);
  return (
    <SpaceSystemLine
      createdAt={entry.createdAt}
      muted={view.muted}
      {...(props.className === undefined ? {} : { className: props.className })}
      icon={
        view.lead === "move" ? (
          <CircleArrowRightIcon aria-hidden className={lineIconClass} />
        ) : view.lead === "undo" ? (
          <Undo2Icon aria-hidden className={lineIconClass} />
        ) : null
      }
      trailing={
        view.muted ? null : (
          <SpaceStatusUndoButton
            environmentId={props.environmentId}
            space={props.space}
            entry={entry}
            task={"taskId" in entry.line ? props.taskOf(entry.line.taskId) : null}
            entries={props.entries}
            viewer={context.viewer}
          />
        )
      }
    >
      {view.segments.map((segment, index) => {
        const key = `${segment.type}:${index}`;
        if (segment.type === "text") return <span key={key}>{segment.text}</span>;
        if (segment.type === "task") {
          return (
            <SpaceTaskChip
              key={key}
              environmentId={props.environmentId}
              spaceId={props.space.id}
              taskId={segment.taskId}
              task={props.taskOf(segment.taskId)}
            />
          );
        }
        return (
          <Link
            key={key}
            to="/$environmentId/$threadId"
            params={{ environmentId: props.environmentId, threadId: segment.threadId }}
            className="font-medium text-foreground hover:underline"
          >
            {segment.text}
          </Link>
        );
      })}
    </SpaceSystemLine>
  );
}
