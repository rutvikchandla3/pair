import { LegendList } from "@legendapp/list/react";
import {
  type SpaceViewer,
  spaceSystemLineText,
  spaceTaskStatus,
  splitSpacePostText,
} from "@t3tools/client-runtime/spaces";
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  Space,
  SpaceRoomEntry,
  ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { QuoteIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useTeamMembers } from "../../state/team";
import { MemberAvatar } from "../team/MemberAvatar";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type SpacePairFeedItem, SpacePairFeedRow } from "./SpacePairFeed";
import { SpaceStatusIcon } from "./SpaceStatusIcon";

type SpaceFeedRow =
  | { readonly type: "day"; readonly key: string; readonly label: string }
  | { readonly type: "new"; readonly key: "new" }
  | {
      readonly type: "entry";
      readonly key: string;
      readonly entry: SpaceRoomEntry;
      /** Same author within a few minutes: no name line. */
      readonly continued: boolean;
    }
  | { readonly type: "pair"; readonly key: string; readonly item: SpacePairFeedItem };

const CONTINUE_WITHIN_MS = 5 * 60_000;

function dayLabel(iso: string, now: Date): string {
  const date = new Date(iso);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (day === today) return "Today";
  if (day === today - 86_400_000) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

function buildRows(
  entries: ReadonlyArray<SpaceRoomEntry>,
  pairItems: ReadonlyArray<SpacePairFeedItem>,
  newIndex: number | null,
): ReadonlyArray<SpaceFeedRow> {
  const now = new Date();
  const rows: SpaceFeedRow[] = [];
  let lastDay: string | null = null;
  let previous: SpaceRoomEntry | null = null;
  let pairIndex = 0;
  const pushDay = (createdAt: string) => {
    const label = dayLabel(createdAt, now);
    if (label === lastDay) return;
    lastDay = label;
    const date = new Date(createdAt);
    rows.push({
      type: "day",
      key: `day:${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`,
      label,
    });
  };
  entries.forEach((entry, index) => {
    while (pairIndex < pairItems.length && pairItems[pairIndex]!.createdAt < entry.createdAt) {
      const item = pairItems[pairIndex++]!;
      pushDay(item.createdAt);
      rows.push({ type: "pair", key: `pair:${item.key}`, item });
      previous = null;
    }
    pushDay(entry.createdAt);
    if (index === newIndex) rows.push({ type: "new", key: "new" });
    const continued =
      index !== newIndex &&
      previous !== null &&
      previous.type === "post" &&
      entry.type === "post" &&
      previous.authorId === entry.authorId &&
      Date.parse(entry.createdAt) - Date.parse(previous.createdAt) < CONTINUE_WITHIN_MS &&
      rows.at(-1)?.type === "entry";
    rows.push({ type: "entry", key: entry.id, entry, continued });
    previous = entry;
  });
  for (; pairIndex < pairItems.length; pairIndex++) {
    const item = pairItems[pairIndex]!;
    pushDay(item.createdAt);
    rows.push({ type: "pair", key: `pair:${item.key}`, item });
  }
  return rows;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export interface SpaceFeedProps {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly entries: ReadonlyArray<SpaceRoomEntry>;
  readonly pairItems: ReadonlyArray<SpacePairFeedItem>;
  readonly tasks: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly viewer: SpaceViewer;
  readonly newIndex: number | null;
  readonly canQuote: boolean;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  readonly onLoadOlder: () => void;
  readonly onQuote: (entry: Extract<SpaceRoomEntry, { type: "post" }>) => void;
}

export function SpaceFeed(props: SpaceFeedProps) {
  const members = useTeamMembers(props.environmentId);
  const rows = buildRows(props.entries, props.pairItems, props.newIndex);
  const tasksById = new Map(props.tasks.map((task) => [task.id, task] as const));

  const renderTaskChip = (threadId: ThreadId) => {
    const task = tasksById.get(threadId);
    const status = task === undefined ? null : spaceTaskStatus(task, props.viewer);
    return (
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId: props.environmentId, threadId }}
        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 align-middle text-foreground text-xs hover:bg-accent"
      >
        {status === null ? null : (
          <SpaceStatusIcon icon={status.icon} tone={status.tone} label={status.label} />
        )}
        <span className="truncate font-medium">{task?.title ?? "Task"}</span>
        {status === null ? null : (
          <span className="shrink-0 text-muted-foreground">{status.label}</span>
        )}
      </Link>
    );
  };

  const renderEntry = (entry: SpaceRoomEntry, continued: boolean) => {
    if (entry.type === "system") {
      const line = entry.line;
      return (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-4 py-1 text-muted-foreground text-xs">
          <span className="font-medium text-foreground/80">
            {entry.actorId === props.viewer.memberId ? "You" : props.viewer.nameOf(entry.actorId)}
          </span>
          <span>{spaceSystemLineText(line, props.viewer)}</span>
          {line.type === "task-created" || line.type === "task-handed-back"
            ? renderTaskChip(line.threadId)
            : null}
          {line.type === "task-handed-back" ? <span>“{line.reason}”</span> : null}
          <span className="tabular-nums">{timeFormat.format(new Date(entry.createdAt))}</span>
        </div>
      );
    }
    const author = members.get(entry.authorId);
    const name = props.viewer.nameOf(entry.authorId);
    const segments = splitSpacePostText(entry.text, entry.mentions, props.viewer.nameOf);
    return (
      <div
        className={cn(
          "group relative flex gap-2.5 px-4 hover:bg-accent/40",
          continued ? "py-0.5" : "pt-2 pb-0.5",
        )}
      >
        <div className="w-8 shrink-0">
          {continued ? null : (
            <MemberAvatar member={{ name, color: author?.color ?? "var(--muted-foreground)" }} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          {continued ? null : (
            <div className="flex items-baseline gap-2">
              <span className="font-medium text-sm">{name}</span>
              {entry.authorKind === "agent" ? (
                <span className="text-muted-foreground text-xs">agent</span>
              ) : null}
              <span className="text-muted-foreground text-xs tabular-nums">
                {timeFormat.format(new Date(entry.createdAt))}
              </span>
            </div>
          )}
          {entry.quote === undefined ? null : (
            <div className="flex min-w-0 items-baseline gap-1.5 text-muted-foreground text-xs">
              <span aria-hidden>↳</span>
              <span className="shrink-0 font-medium">
                {props.viewer.nameOf(entry.quote.authorId)}
              </span>
              <span className="truncate">{entry.quote.text}</span>
            </div>
          )}
          <p className="whitespace-pre-wrap break-words text-sm">
            {segments.map((segment, index) =>
              segment.type === "text" ? (
                segment.text
              ) : (
                <span
                  // oxlint-disable-next-line react/no-array-index-key -- segments have no identity
                  key={index}
                  className={cn(
                    "rounded px-0.5 font-medium",
                    segment.mention.type === "pair" ||
                      (segment.mention.type === "member" &&
                        segment.mention.memberId === props.viewer.memberId)
                      ? "bg-input-foreground/12 text-input-foreground"
                      : "text-input-foreground",
                  )}
                >
                  {segment.text}
                </span>
              ),
            )}
          </p>
        </div>
        {props.canQuote ? (
          <div className="absolute -top-3 right-4 hidden rounded-md border border-border bg-popover shadow-xs group-focus-within:flex group-hover:flex">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Quote reply"
                    onClick={() => props.onQuote(entry)}
                  />
                }
              >
                <QuoteIcon />
              </TooltipTrigger>
              <TooltipPopup>Quote reply</TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
      </div>
    );
  };

  const renderRow = (item: SpaceFeedRow) => {
    switch (item.type) {
      case "day":
        return (
          <div className="flex items-center gap-3 px-4 pt-4 pb-1 text-muted-foreground text-xs">
            <span className="h-px flex-1 bg-border" />
            {item.label}
            <span className="h-px flex-1 bg-border" />
          </div>
        );
      case "new":
        return (
          <div className="flex items-center gap-3 px-4 py-1 font-medium text-destructive text-xs">
            <span className="h-px flex-1 bg-destructive/50" />
            New
          </div>
        );
      case "pair":
        return <SpacePairFeedRow item={item.item} />;
      case "entry":
        return renderEntry(item.entry, item.continued);
    }
  };

  // Same lane as ChatView, so the room and the task screen line up.
  const renderItem = ({ item }: { item: SpaceFeedRow }) => (
    <div className="chat-composer-lane">
      <div className="chat-content-lane">{renderRow(item)}</div>
    </div>
  );
  const header = props.hasOlder ? (
    <div className="flex justify-center pt-3">
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={props.loadingOlder}
        onClick={props.onLoadOlder}
      >
        {props.loadingOlder ? "Loading…" : "Load earlier messages"}
      </Button>
    </div>
  ) : (
    <div className="px-4 pt-6 pb-2 text-muted-foreground text-xs">
      The start of <span className="font-medium text-foreground">{props.space.name}</span>
    </div>
  );

  return (
    <LegendList<SpaceFeedRow>
      data={rows}
      extraData={tasksById}
      keyExtractor={(row) => row.key}
      getItemType={(row) => row.type}
      renderItem={renderItem}
      estimatedItemSize={56}
      initialScrollAtEnd
      maintainScrollAtEnd
      maintainScrollAtEndThreshold={1}
      maintainVisibleContentPosition={{ data: true, size: true }}
      className="h-full min-h-0 overflow-x-hidden overscroll-y-contain pb-2 [overflow-anchor:none]"
      ListHeaderComponent={header}
    />
  );
}
