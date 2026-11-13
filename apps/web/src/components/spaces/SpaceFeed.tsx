import { LegendList } from "@legendapp/list/react";
import type { SpacePairFeedItem } from "@t3tools/client-runtime/spaceAgent";
import {
  type SpaceFeedRow,
  type SpaceViewer,
  isSpaceTaskLineEntry,
  spaceFeedRows,
  spaceSystemLineText,
  spaceUndoneEntryIds,
  splitSpacePostText,
} from "@t3tools/client-runtime/spaces";
import type { EnvironmentId, Space, SpaceRoomEntry } from "@t3tools/contracts";
import { QuoteIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useTeamMembers } from "../../state/team";
import { MemberAvatar } from "../team/MemberAvatar";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type SpacePairFeedContext, SpacePairFeedRow, SpacePairStatus } from "./SpacePairFeed";
import { SpaceRecordLine, SpaceSystemLine, formatSpaceTime } from "./SpaceRecord";

const isRecordRow = (row: SpaceFeedRow<SpacePairFeedItem>) =>
  row.type === "entry" && row.entry.type === "system";

export interface SpaceFeedProps {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly entries: ReadonlyArray<SpaceRoomEntry>;
  readonly pairItems: ReadonlyArray<SpacePairFeedItem>;
  readonly pairContext: SpacePairFeedContext;
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
  const rows = spaceFeedRows(props.entries, props.pairItems, props.newIndex);
  const context = props.pairContext;
  const recordContext = {
    viewer: props.viewer,
    inThread: null,
    onTask: null,
    threadTitle: context.threadTitle,
    undone: spaceUndoneEntryIds(props.entries),
  };

  // Board `.sys`: indented to the message text, 4px apart, 12px after anything else.
  const firstRecords = new Set<string>();
  rows.forEach((row, index) => {
    const previous = rows[index - 1];
    if (isRecordRow(row) && (previous === undefined || !isRecordRow(previous))) {
      firstRecords.add(row.key);
    }
  });
  const recordClass = (key: string) =>
    firstRecords.has(key) ? "ps-14.5 pe-4 pt-3" : "ps-14.5 pe-4 pt-1";

  const renderEntry = (entry: SpaceRoomEntry, continued: boolean) => {
    if (isSpaceTaskLineEntry(entry)) {
      return (
        <SpaceRecordLine
          className={recordClass(entry.id)}
          environmentId={props.environmentId}
          space={props.space}
          entry={entry}
          entries={props.entries}
          taskOf={context.taskOf}
          context={recordContext}
        />
      );
    }
    if (entry.type === "system" && !("taskId" in entry.line)) {
      return (
        <SpaceSystemLine createdAt={entry.createdAt} className={recordClass(entry.id)}>
          {entry.actorId === props.viewer.memberId ? "You" : props.viewer.nameOf(entry.actorId)}{" "}
          {spaceSystemLineText(entry.line, props.viewer)}
        </SpaceSystemLine>
      );
    }
    if (entry.type !== "post") return null;
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
                {formatSpaceTime(entry.createdAt)}
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
          {entry.pairRequested ? (
            <SpacePairStatus
              reply={props.pairContext.pairRoom.byTrigger.get(entry.id)}
              context={props.pairContext}
            />
          ) : null}
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

  const renderRow = (item: SpaceFeedRow<SpacePairFeedItem>) => {
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
        return <SpacePairFeedRow item={item.item} context={props.pairContext} />;
      case "entry":
        return renderEntry(item.entry, item.continued);
    }
  };

  // Same lane as ChatView, so the room and the task screen line up.
  const renderItem = ({ item }: { item: SpaceFeedRow<SpacePairFeedItem> }) => (
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
    <LegendList<SpaceFeedRow<SpacePairFeedItem>>
      data={rows}
      extraData={props.pairContext}
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
