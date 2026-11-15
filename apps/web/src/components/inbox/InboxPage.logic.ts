import type { InboxItem, SpaceId, SpaceTaskId, ThreadId } from "@t3tools/contracts";

/** Where Enter and Open take an item. */
export type InboxItemTarget =
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "task"; readonly spaceId: SpaceId; readonly taskId: SpaceTaskId }
  | { readonly kind: "room"; readonly spaceId: SpaceId };

export function inboxItemTarget(item: InboxItem): InboxItemTarget | null {
  switch (item.reason) {
    case "task-assigned":
    case "task-handed-back":
      return item.spaceId !== undefined && item.taskId !== undefined
        ? { kind: "task", spaceId: item.spaceId, taskId: item.taskId }
        : null;
    case "mention":
    case "pair-reply":
    case "added-to-space":
      return item.spaceId === undefined ? null : { kind: "room", spaceId: item.spaceId };
    default:
      return item.threadId === undefined ? null : { kind: "thread", threadId: item.threadId };
  }
}

/**
 * What `h` snoozes: a task item by itself, a thread's item through its thread (the Snoozed
 * shelf). Room items have nothing to snooze.
 */
export function inboxSnoozeKind(item: InboxItem): "task" | "thread" | null {
  switch (item.reason) {
    case "task-assigned":
    case "task-handed-back":
      return "task";
    case "mention":
    case "pair-reply":
    case "added-to-space":
      return null;
    default:
      return item.threadId === undefined ? null : "thread";
  }
}

/** Needs you, then For you, each newest first as the server sent them. */
export function orderInboxItems<T extends Pick<InboxItem, "group">>(
  items: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return [
    ...items.filter((item) => item.group === "needs-you"),
    ...items.filter((item) => item.group !== "needs-you"),
  ];
}

/** `j`/`k`: the id one row down or up, held at the ends. */
export function moveInboxSelection(
  items: ReadonlyArray<Pick<InboxItem, "id">>,
  selectedId: string | null,
  delta: 1 | -1,
): string | null {
  if (items.length === 0) return null;
  const index = items.findIndex((item) => item.id === selectedId);
  if (index === -1) return items[0]!.id;
  return items[Math.max(0, Math.min(items.length - 1, index + delta))]!.id;
}

/** A task item's snooze: tomorrow at 9, local time. */
export function tomorrowMorning(now: Date): Date {
  const wake = new Date(now);
  wake.setDate(wake.getDate() + 1);
  wake.setHours(9, 0, 0, 0);
  return wake;
}
