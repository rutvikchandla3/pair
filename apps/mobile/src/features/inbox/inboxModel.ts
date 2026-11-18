import type {
  BotAskId,
  BotJobId,
  InboxGroup,
  InboxItem,
  InboxItemReason,
  MemberId,
  SharedWithYouItem,
  SharedWithYouPerson,
  SpaceId,
  SpaceTaskId,
  ThreadId,
} from "@t3tools/contracts";

import type { AppSymbolName } from "../../components/ui/AppSymbol";

export interface InboxSection {
  readonly group: InboxGroup;
  readonly label: string;
  readonly items: ReadonlyArray<InboxItem>;
}

/** Needs you, then For you; each keeps the server's newest-first order and only shows when filled. */
export function inboxSections(items: ReadonlyArray<InboxItem>): ReadonlyArray<InboxSection> {
  return (
    [
      { group: "needs-you", label: "Needs you" },
      { group: "for-you", label: "For you" },
    ] as const
  ).flatMap(({ group, label }) => {
    const inGroup = items.filter((item) => item.group === group);
    return inGroup.length === 0 ? [] : [{ group, label, items: inGroup }];
  });
}

export type InboxItemTarget =
  /** An approval or question: answered in place, with Open thread beside it. */
  | { readonly type: "request"; readonly threadId: ThreadId }
  | { readonly type: "thread"; readonly threadId: ThreadId }
  | { readonly type: "task"; readonly spaceId: SpaceId; readonly taskId: SpaceTaskId }
  | { readonly type: "room"; readonly spaceId: SpaceId }
  /** A bot's Ask, answered in the Ask sheet. */
  | { readonly type: "bot-ask"; readonly askId: BotAskId }
  /** A bot's finished or stopped job, opened read-only. */
  | { readonly type: "bot-job"; readonly jobId: BotJobId };

/** Where tapping a row goes; null when the item names nothing this client can open. */
export function inboxItemTarget(item: InboxItem): InboxItemTarget | null {
  switch (item.reason) {
    case "approval":
    case "question":
      return item.threadId === undefined ? null : { type: "request", threadId: item.threadId };
    case "task-assigned":
    case "task-handed-back":
      return item.spaceId === undefined || item.taskId === undefined
        ? null
        : { type: "task", spaceId: item.spaceId, taskId: item.taskId };
    case "offer":
    case "shared-with-you":
      return item.threadId === undefined ? null : { type: "thread", threadId: item.threadId };
    case "mention":
    case "pair-reply":
    case "added-to-space":
      return item.spaceId !== undefined
        ? { type: "room", spaceId: item.spaceId }
        : item.threadId === undefined
          ? null
          : { type: "thread", threadId: item.threadId };
    case "bot-ask":
      return item.askId === undefined ? null : { type: "bot-ask", askId: item.askId };
    case "bot-job-done":
      return item.jobId === undefined ? null : { type: "bot-job", jobId: item.jobId };
  }
}

/**
 * What Snooze does: a task item snoozes itself (`inbox.snooze`); an item about a thread snoozes
 * that thread through its existing Snooze. A thread can't be snoozed while it waits on an answer,
 * so approvals and questions have none, and room items have nothing to snooze.
 */
export function inboxItemSnooze(
  item: InboxItem,
): { readonly type: "task" } | { readonly type: "thread"; readonly threadId: ThreadId } | null {
  if (item.reason === "task-assigned" || item.reason === "task-handed-back") {
    return { type: "task" };
  }
  const target = inboxItemTarget(item);
  return target?.type === "thread" ? { type: "thread", threadId: target.threadId } : null;
}

/** Done clears a For you item early; Needs you items leave only when handled. */
export function canMarkInboxItemDone(item: InboxItem): boolean {
  return item.group === "for-you";
}

export const INBOX_REASON_SYMBOL: Readonly<Record<InboxItemReason, AppSymbolName>> = {
  approval: "exclamationmark.shield",
  question: "questionmark.bubble",
  "task-assigned": "person.badge.plus",
  "task-handed-back": "arrow.uturn.backward",
  offer: "point.topleft.down.curvedto.point.bottomright.up",
  mention: "at",
  "pair-reply": "bubble.left",
  "shared-with-you": "square.and.arrow.up",
  "added-to-space": "person.2",
  "bot-ask": "questionmark.bubble",
  "bot-job-done": "checkmark.circle",
};

export type SharedWithYouRow =
  | {
      readonly type: "person";
      readonly key: string;
      readonly memberId: MemberId;
      readonly count: number;
    }
  | { readonly type: "thread"; readonly key: string; readonly item: SharedWithYouItem };

/**
 * One header per person in the server's order (by last activity), then their threads. A person
 * the server didn't list yet still gets a header, after the listed ones.
 */
export function sharedWithYouRows(
  items: ReadonlyArray<SharedWithYouItem>,
  people: ReadonlyArray<SharedWithYouPerson>,
): ReadonlyArray<SharedWithYouRow> {
  const byPerson = new Map<MemberId, SharedWithYouItem[]>();
  for (const item of items) {
    const list = byPerson.get(item.ownerId);
    if (list === undefined) byPerson.set(item.ownerId, [item]);
    else list.push(item);
  }
  const counts = new Map(people.map((person) => [person.memberId, person.count]));
  const order = [
    ...people.map((person) => person.memberId).filter((memberId) => byPerson.has(memberId)),
    ...[...byPerson.keys()].filter((memberId) => !counts.has(memberId)),
  ];
  return order.flatMap((memberId): SharedWithYouRow[] => {
    const threads = byPerson.get(memberId) ?? [];
    return [
      {
        type: "person",
        key: `person:${memberId}`,
        memberId,
        count: counts.get(memberId) ?? threads.length,
      },
      ...threads.map((item) => ({ type: "thread" as const, key: `thread:${item.threadId}`, item })),
    ];
  });
}
