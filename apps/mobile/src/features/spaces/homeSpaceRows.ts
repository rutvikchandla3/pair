import { type SidebarSpaceRow, sidebarSpaceRows } from "@t3tools/client-runtime/inbox";
import type { InboxSummary, MemberId, Space, SpaceId } from "@t3tools/contracts";

export type HomeTeamItem =
  | {
      readonly type: "place";
      readonly key: "inbox" | "my-tasks" | "shared-with-you";
      /** Inbox's Needs you count; My tasks and Shared with you are places, with no count. */
      readonly count: number | null;
    }
  | { readonly type: "spaces-header" }
  | { readonly type: "spaces-empty" }
  | { readonly type: "space"; readonly row: SidebarSpaceRow }
  | {
      readonly type: "more";
      /** N, the hidden active spaces; archived ones never count. */
      readonly hidden: number;
      readonly needsYou: number;
      readonly expanded: boolean;
    }
  | { readonly type: "archived-header" }
  | { readonly type: "archived-space"; readonly row: SidebarSpaceRow };

/**
 * Home's team block: Inbox, My tasks and Shared with you in team mode, then one row per space in
 * the user's order. After five comes "N more", which expands in place to the rest and, under an
 * Archived sub-header, the archived spaces.
 */
export function homeTeamItems(input: {
  readonly teamMode: boolean;
  readonly spaces: ReadonlyArray<Space>;
  readonly order: ReadonlyArray<SpaceId>;
  readonly summary: InboxSummary | null;
  readonly unreadRoomIds: ReadonlySet<string>;
  readonly viewerId: MemberId | null;
  readonly expanded: boolean;
}): ReadonlyArray<HomeTeamItem> {
  const rows = sidebarSpaceRows(
    input.spaces,
    input.order,
    input.summary,
    input.unreadRoomIds,
    input.viewerId,
  );
  const places: HomeTeamItem[] = input.teamMode
    ? [
        { type: "place", key: "inbox", count: input.summary?.needsYou ?? 0 },
        { type: "place", key: "my-tasks", count: null },
        { type: "place", key: "shared-with-you", count: null },
      ]
    : [];
  const hasMore = rows.hidden.length > 0 || rows.archived.length > 0;
  return [
    ...places,
    { type: "spaces-header" },
    ...(rows.visible.length === 0 ? [{ type: "spaces-empty" } as const] : []),
    ...rows.visible.map((row) => ({ type: "space" as const, row })),
    ...(hasMore
      ? [
          {
            type: "more" as const,
            hidden: rows.hidden.length,
            needsYou: rows.hiddenNeedsYou,
            expanded: input.expanded,
          },
        ]
      : []),
    ...(input.expanded ? rows.hidden.map((row) => ({ type: "space" as const, row })) : []),
    ...(input.expanded && rows.archived.length > 0
      ? [
          { type: "archived-header" as const },
          ...rows.archived.map((row) => ({ type: "archived-space" as const, row })),
        ]
      : []),
  ];
}

/** The "N more" row's label: it still opens Archived when nothing active is hidden. */
export function homeMoreLabel(item: Extract<HomeTeamItem, { type: "more" }>): string {
  if (item.expanded) return "Show less";
  return item.hidden === 0 ? "Archived" : `${item.hidden} more`;
}

/**
 * The stored order after showing `shown` (the active spaces in display order): new spaces keep
 * their place on top from now on, and ids not shown (archived, left) keep theirs at the end.
 * Returns `stored` itself when nothing changes, so callers can skip the write.
 */
export function rememberSpaceOrder(
  stored: ReadonlyArray<string>,
  shown: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const shownIds = new Set(shown);
  const next = [...shown, ...stored.filter((id) => !shownIds.has(id))];
  return next.length === stored.length && next.every((id, index) => id === stored[index])
    ? stored
    : next;
}

/** Moves a space one place up (-1) or down (+1) among `shown`, the active spaces in order. */
export function moveSpaceInOrder(
  stored: ReadonlyArray<string>,
  shown: ReadonlyArray<string>,
  spaceId: string,
  delta: -1 | 1,
): ReadonlyArray<string> {
  const index = shown.indexOf(spaceId);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= shown.length) return stored;
  const moved = [...shown];
  moved[index] = shown[target]!;
  moved[target] = spaceId;
  return rememberSpaceOrder(stored, moved);
}
