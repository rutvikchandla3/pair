import { inboxRowCopy } from "@t3tools/client-runtime/inbox";
import type { SpaceViewer } from "@t3tools/client-runtime/spaces";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, InboxItem, InboxItemReason } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  AlarmClockIcon,
  AtSignIcon,
  CircleCheckIcon,
  GitCompareArrowsIcon,
  InboxIcon,
  InfinityIcon,
  MessageCircleQuestionIcon,
  Share2Icon,
  ShieldQuestionIcon,
  Undo2Icon,
  UserRoundPlusIcon,
  UsersRoundIcon,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { useClientSettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useThreadActions } from "../../hooks/useThreadActions";
import { BotAvatar } from "../bots/BotAvatar";
import {
  inboxEnvironment,
  useInboxPages,
  useInboxSummary,
  useTeamEnvironmentIds,
} from "../../state/inbox";
import { useSpaceViewer } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { RelativeTime } from "../RelativeTime";
import { resolveSnoozePresets, snoozeWakeLabel } from "../Sidebar.snooze";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { Toggle as ToggleButton } from "../ui/toggle";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import { InboxPreview } from "./InboxPreview";
import {
  type InboxItemTarget,
  inboxItemTarget,
  inboxSnoozeKind,
  moveInboxSelection,
  orderInboxItems,
  tomorrowMorning,
} from "./InboxPage.logic";
import { TeamPage } from "./TeamPage";

type InboxFilter = "all" | "needs-you" | "for-you";

const FILTERS: ReadonlyArray<{ readonly value: InboxFilter; readonly label: string }> = [
  { value: "all", label: "All" },
  { value: "needs-you", label: "Needs you" },
  { value: "for-you", label: "For you" },
];

export function InboxPage() {
  const environmentId = useTeamEnvironmentIds()[0] ?? null;
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [showSnoozed, setShowSnoozed] = useState(false);
  const snoozedCount = useInboxSummary(environmentId)?.snoozed ?? 0;
  return (
    <TeamPage
      title="Inbox"
      actions={
        environmentId !== null && (showSnoozed || snoozedCount > 0) ? (
          <ToggleButton
            variant="ghost"
            size="sm"
            pressed={showSnoozed}
            onPressedChange={setShowSnoozed}
          >
            <AlarmClockIcon />
            Snoozed
            <span className="tabular-nums">{snoozedCount}</span>
          </ToggleButton>
        ) : undefined
      }
      controls={
        showSnoozed ? undefined : (
          <ToggleGroup
            aria-label="Show"
            value={[filter]}
            onValueChange={(next) => {
              const value = FILTERS.find((option) => option.value === next[0]);
              if (value) setFilter(value.value);
            }}
          >
            {FILTERS.map((option) => (
              <Toggle key={option.value} value={option.value}>
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
        )
      }
    >
      {environmentId === null ? (
        <InboxEmpty />
      ) : showSnoozed ? (
        <InboxSnoozedBody environmentId={environmentId} />
      ) : (
        <InboxBody
          // A different list starts at its first page and its first row.
          key={`${environmentId}:${filter}`}
          environmentId={environmentId}
          filter={filter}
        />
      )}
    </TeamPage>
  );
}

function InboxEmpty() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia>
          <InboxIcon className="size-5 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>Nothing needs you.</EmptyTitle>
        <EmptyDescription>
          Approvals, questions, assigned tasks and offers to your threads show up here.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function InboxBody(props: { readonly environmentId: EnvironmentId; readonly filter: InboxFilter }) {
  const { environmentId } = props;
  const [pages, setPages] = useState(1);
  const view = useInboxPages(environmentId, props.filter, pages);
  const summary = useInboxSummary(environmentId);
  const viewer = useSpaceViewer(environmentId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const navigate = useNavigate();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { snoozeThread } = useThreadActions();
  const dismiss = useAtomCommand(inboxEnvironment.dismiss, { reportFailure: false });
  const snoozeItem = useAtomCommand(inboxEnvironment.snooze, { reportFailure: false });
  const unsnoozeItem = useAtomCommand(inboxEnvironment.unsnooze, { reportFailure: false });
  const ordered = orderInboxItems(view.items);
  const selected = ordered.find((item) => item.id === selectedId) ?? ordered[0] ?? null;

  const open = (item: InboxItem) => {
    const target = inboxItemTarget(item);
    if (target !== null) void navigateTo(navigate, environmentId, target);
  };
  const done = async (item: InboxItem) => {
    if (item.group !== "for-you") return;
    toastCommandFailure(
      "Could not mark done",
      await dismiss({ environmentId, input: { itemId: item.id } }),
    );
  };
  const snooze = async (item: InboxItem) => {
    const kind = inboxSnoozeKind(item);
    if (kind === "thread" && item.threadId !== undefined) {
      const preset = resolveSnoozePresets(new Date(), timestampFormat, environmentId)[0];
      if (preset === undefined) return;
      const result = await snoozeThread(
        { environmentId, threadId: item.threadId },
        preset.snoozedUntil,
      );
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add({ type: "error", title: "Could not snooze the thread" });
      }
      return;
    }
    if (kind !== "task") return;
    const result = await snoozeItem({
      environmentId,
      input: { itemId: item.id, until: tomorrowMorning(new Date()).toISOString() },
    });
    if (result._tag !== "Success") {
      toastCommandFailure("Could not snooze", result);
      return;
    }
    toastManager.add({
      type: "info",
      title: "Snoozed until tomorrow morning",
      actionProps: {
        children: "Undo",
        onClick: () =>
          void unsnoozeItem({ environmentId, input: { itemId: item.id } }).then((undo) =>
            toastCommandFailure("Could not unsnooze", undo),
          ),
      },
    });
  };

  if (view.items.length === 0) {
    return view.loading ? (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    ) : view.error !== null ? (
      <p className="p-6 text-muted-foreground text-sm">{view.error}</p>
    ) : (
      <InboxEmpty />
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[26rem] min-w-0 shrink-0 flex-col border-r border-border">
        <InboxList
          environmentId={environmentId}
          items={view.items}
          selectedId={selected?.id ?? null}
          needsYouCount={summary?.needsYou ?? null}
          viewer={viewer}
          onSelect={setSelectedId}
          onOpen={open}
          onDone={(item) => void done(item)}
          onSnooze={(item) => void snooze(item)}
          footer={
            view.hasMore ? (
              <Button variant="ghost" size="sm" onClick={() => setPages(pages + 1)}>
                Load more
              </Button>
            ) : null
          }
        />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {selected === null ? null : (
          <InboxPreview
            key={selected.id}
            environmentId={environmentId}
            item={selected}
            viewer={viewer}
            onOpen={() => open(selected)}
          />
        )}
      </div>
    </div>
  );
}

/** The task items snoozed until later; thread items snooze their thread in the Snoozed shelf. */
function InboxSnoozedBody(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const [pages, setPages] = useState(1);
  const view = useInboxPages(environmentId, "all", pages, true);
  const viewer = useSpaceViewer(environmentId);
  const navigate = useNavigate();
  const unsnoozeItem = useAtomCommand(inboxEnvironment.unsnooze, { reportFailure: false });

  if (view.items.length === 0) {
    return view.loading ? (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    ) : view.error !== null ? (
      <p className="p-6 text-muted-foreground text-sm">{view.error}</p>
    ) : (
      <Empty>
        <EmptyHeader>
          <EmptyMedia>
            <AlarmClockIcon className="size-5 text-muted-foreground" />
          </EmptyMedia>
          <EmptyTitle>Nothing snoozed.</EmptyTitle>
          <EmptyDescription>A task you snooze with h waits here until its time.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
      <div className="mx-auto flex max-w-3xl flex-col gap-2 p-2">
        <InboxSnoozedList
          items={view.items}
          viewer={viewer}
          onOpen={(item) => {
            const target = inboxItemTarget(item);
            if (target !== null) void navigateTo(navigate, environmentId, target);
          }}
          onUnsnooze={async (item) =>
            toastCommandFailure(
              "Could not unsnooze",
              await unsnoozeItem({ environmentId, input: { itemId: item.id } }),
            )
          }
        />
        {view.hasMore ? (
          <Button variant="ghost" size="sm" onClick={() => setPages(pages + 1)}>
            Load more
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Snoozed task items, each with when it wakes and Unsnooze. */
export function InboxSnoozedList(props: {
  readonly items: ReadonlyArray<InboxItem>;
  readonly viewer: SpaceViewer;
  readonly onOpen: (item: InboxItem) => void;
  readonly onUnsnooze: (item: InboxItem) => void;
}) {
  const now = `${useNowMinute()}:00.000Z`;
  return (
    <ul aria-label="Snoozed" className="flex flex-col gap-px">
      {props.items.map((item) => {
        const copy = inboxRowCopy(item, props.viewer);
        const Icon = REASON_ICONS[item.reason];
        return (
          <li
            key={item.id}
            className="flex items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-accent/60"
            onDoubleClick={() => props.onOpen(item)}
          >
            <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{copy.title}</p>
              <p className="truncate text-muted-foreground text-xs">
                {[
                  copy.detail,
                  item.snoozedUntil === undefined
                    ? null
                    : `Wakes in ${snoozeWakeLabel(item.snoozedUntil, { now })}`,
                ]
                  .filter((part) => part !== null && part !== "")
                  .join(" · ")}
              </p>
            </div>
            <Button variant="outline" size="xs" onClick={() => props.onUnsnooze(item)}>
              Unsnooze
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function navigateTo(
  navigate: ReturnType<typeof useNavigate>,
  environmentId: EnvironmentId,
  target: InboxItemTarget,
) {
  switch (target.kind) {
    case "thread":
      return navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: target.threadId },
      });
    case "task":
      return navigate({
        to: "/spaces/$environmentId/$spaceId/tasks/$taskId",
        params: { environmentId, spaceId: target.spaceId, taskId: target.taskId },
      });
    case "room":
      return navigate({
        to: "/spaces/$environmentId/$spaceId",
        params: { environmentId, spaceId: target.spaceId },
      });
    case "bot":
      return navigate({
        to: "/bots/$environmentId/$botId",
        params: { environmentId, botId: target.botId },
        search: target.askId === undefined ? {} : { ask: target.askId },
      });
  }
}

const REASON_ICONS: Readonly<Record<InboxItemReason, typeof InboxIcon>> = {
  approval: ShieldQuestionIcon,
  question: MessageCircleQuestionIcon,
  "task-assigned": UserRoundPlusIcon,
  "task-handed-back": Undo2Icon,
  offer: GitCompareArrowsIcon,
  mention: AtSignIcon,
  "pair-reply": InfinityIcon,
  "shared-with-you": Share2Icon,
  "added-to-space": UsersRoundIcon,
  "bot-ask": MessageCircleQuestionIcon,
  "bot-job-done": CircleCheckIcon,
};

const rowId = (item: InboxItem) => `inbox-item-${item.id}`;

/**
 * Needs you, then For you, newest first. While the list has focus `j`/`k` move, Enter opens,
 * `e` marks a For you item done and `h` snoozes.
 */
export function InboxList(props: {
  readonly environmentId: EnvironmentId;
  readonly items: ReadonlyArray<InboxItem>;
  readonly selectedId: string | null;
  /** The summary's count, which covers pages not loaded yet. */
  readonly needsYouCount: number | null;
  readonly viewer: SpaceViewer;
  readonly onSelect: (id: string) => void;
  readonly onOpen: (item: InboxItem) => void;
  readonly onDone: (item: InboxItem) => void;
  readonly onSnooze: (item: InboxItem) => void;
  readonly footer?: ReactNode;
}) {
  const ordered = orderInboxItems(props.items);
  const needsYou = ordered.filter((item) => item.group === "needs-you");
  const forYou = ordered.filter((item) => item.group === "for-you");
  const selected = ordered.find((item) => item.id === props.selectedId) ?? null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    const move = (delta: 1 | -1) => {
      const next = moveInboxSelection(ordered, props.selectedId, delta);
      if (next === null) return;
      props.onSelect(next);
      document.getElementById(`inbox-item-${next}`)?.scrollIntoView({ block: "nearest" });
    };
    switch (event.key) {
      case "j":
      case "ArrowDown":
        event.preventDefault();
        move(1);
        return;
      case "k":
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        return;
      case "Enter":
        if (selected === null) return;
        event.preventDefault();
        props.onOpen(selected);
        return;
      case "e":
        if (selected === null || selected.group !== "for-you") return;
        event.preventDefault();
        props.onDone(selected);
        return;
      case "h":
        if (selected === null) return;
        event.preventDefault();
        props.onSnooze(selected);
        return;
    }
  };

  const group = (label: string, count: number, items: ReadonlyArray<InboxItem>) =>
    items.length === 0 ? null : (
      <div role="group" aria-label={label} className="flex flex-col gap-px">
        <div className="sticky top-0 z-10 flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-muted-foreground text-xs">
          {label}
          <span className="tabular-nums">{count}</span>
        </div>
        {items.map((item) => (
          <InboxRow
            key={item.id}
            environmentId={props.environmentId}
            item={item}
            viewer={props.viewer}
            selected={item.id === selected?.id}
            onSelect={() => props.onSelect(item.id)}
            onOpen={() => props.onOpen(item)}
          />
        ))}
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="listbox"
        aria-label="Inbox"
        tabIndex={0}
        aria-activedescendant={selected === null ? undefined : rowId(selected)}
        onKeyDown={handleKeyDown}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-2 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        {group("Needs you", props.needsYouCount ?? needsYou.length, needsYou)}
        {group("For you", forYou.length, forYou)}
        {props.footer}
      </div>
      <p className="border-t border-border px-3 py-2 text-muted-foreground text-xs">
        j k move · ↵ open · e done · h snooze. An item leaves on its own once it's handled.
      </p>
    </div>
  );
}

function InboxRow(props: {
  readonly environmentId: EnvironmentId;
  readonly item: InboxItem;
  readonly viewer: SpaceViewer;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
}) {
  const { item } = props;
  const copy = inboxRowCopy(item, props.viewer);
  const Icon = REASON_ICONS[item.reason];
  const isBot = item.reason === "bot-ask" || item.reason === "bot-job-done";
  return (
    <div
      id={rowId(item)}
      role="option"
      aria-selected={props.selected}
      className={cn(
        "flex cursor-default gap-2.5 rounded-md px-2.5 py-2 hover:bg-accent/60",
        props.selected && "bg-accent hover:bg-accent",
      )}
      onClick={props.onSelect}
      onDoubleClick={props.onOpen}
    >
      {isBot ? (
        <span className="mt-0.5 shrink-0">
          <BotAvatar
            bot={{ name: item.botName ?? "Bot", color: item.botColor ?? "#4f46e5" }}
            size="sm"
          />
        </span>
      ) : (
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">{copy.title}</span>
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
            <RelativeTime timestamp={item.at} />
          </span>
        </div>
        {copy.detail === "" ? null : (
          <p className="truncate text-muted-foreground text-xs">{copy.detail}</p>
        )}
      </div>
    </div>
  );
}
