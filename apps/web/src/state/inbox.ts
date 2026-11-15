import { useAtomValue } from "@effect/atom-react";
import { createInboxEnvironmentAtoms } from "@t3tools/client-runtime/state/inbox";
import type {
  EnvironmentId,
  InboxItem,
  InboxListInput,
  InboxSummary,
  SharedWithYouItem,
  SharedWithYouListInput,
  SharedWithYouPerson,
  SpaceTask,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSummaries } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "./query";
import { teamEnvironment } from "./team";
import { spaceTasksKeyAtom } from "./spaces";

export const inboxEnvironment = createInboxEnvironmentAtoms(
  connectionAtomRuntime,
  spaceTasksKeyAtom,
);

// Joined ids, so subscribers re-render only when the list changes.
const teamEnvironmentIdsAtom = Atom.make((get) => {
  const primary = get(primaryEnvironmentIdAtom);
  const connected = get(environmentSummaries.connectedEnvironmentIdsAtom);
  const ordered =
    primary !== null && connected.includes(primary)
      ? [primary, ...connected.filter((id) => id !== primary)]
      : connected;
  return ordered.filter((id) => get(teamEnvironment.isTeamModeAtom(id))).join("\n");
}).pipe(Atom.withLabel("inbox-team-environments"));

/** Connected environments with a second member, primary first: where Inbox and its pages live. */
export function useTeamEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const key = useAtomValue(teamEnvironmentIdsAtom);
  return key === "" ? [] : (key.split("\n") as EnvironmentId[]);
}

const needsYouTotalFamily = Atom.family((environmentIdsKey: string) =>
  Atom.make((get) =>
    (environmentIdsKey === "" ? [] : (environmentIdsKey.split("\n") as EnvironmentId[])).reduce(
      (total, id) => total + (get(inboxEnvironment.summaryValueAtom(id))?.needsYou ?? 0),
      0,
    ),
  ).pipe(Atom.withLabel("inbox-needs-you-total")),
);

/** Inbox's count: Needs you across these environments. */
export function useInboxNeedsYouTotal(environmentIds: ReadonlyArray<EnvironmentId>): number {
  return useAtomValue(needsYouTotalFamily(environmentIds.join("\n")));
}

const NO_SUMMARY = Atom.make<InboxSummary | null>(null).pipe(Atom.withLabel("inbox-summary:none"));

export function useInboxSummary(environmentId: EnvironmentId | null): InboxSummary | null {
  return useAtomValue(
    environmentId === null ? NO_SUMMARY : inboxEnvironment.summaryValueAtom(environmentId),
  );
}

export interface PagedView<T> {
  readonly items: ReadonlyArray<T>;
  /** More pages wait on the server. */
  readonly hasMore: boolean;
  /** No page has answered yet. */
  readonly loading: boolean;
  readonly error: string | null;
}

/** Reads `pages` pages in a row, each after the cursor its predecessor returned. */
function readPages<I, T>(
  pages: number,
  page: (
    cursor: string | undefined,
  ) => AsyncResult.AsyncResult<
    { readonly items: ReadonlyArray<I>; readonly nextCursor: string | null },
    unknown
  >,
  itemsOf: (value: { readonly items: ReadonlyArray<I> }) => ReadonlyArray<T>,
  idOf: (item: T) => string,
): PagedView<T> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let index = 0; index < pages; index += 1) {
    const result = page(cursor);
    const value = AsyncResult.getOrElse(result, () => null);
    if (value === null) {
      return {
        items,
        hasMore: false,
        loading: index === 0 && result._tag !== "Failure",
        error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
      };
    }
    // A page can repeat an item that moved while the next was read.
    for (const item of itemsOf(value)) {
      if (seen.has(idOf(item))) continue;
      seen.add(idOf(item));
      items.push(item);
    }
    if (value.nextCursor === null) return { items, hasMore: false, loading: false, error: null };
    cursor = value.nextCursor;
  }
  return { items, hasMore: true, loading: false, error: null };
}

const inboxPagesFamily = Atom.family((key: string) => {
  const { environmentId, group, pages, snoozed } = JSON.parse(key) as {
    readonly environmentId: EnvironmentId;
    readonly group: NonNullable<InboxListInput["group"]>;
    readonly pages: number;
    readonly snoozed: boolean;
  };
  const input = snoozed ? { group, snoozed } : { group };
  return Atom.make((get) =>
    readPages(
      pages,
      (cursor) =>
        get(
          inboxEnvironment.list({
            environmentId,
            input: cursor === undefined ? input : { ...input, cursor },
          }),
        ),
      (value) => value.items as ReadonlyArray<InboxItem>,
      (item) => item.id,
    ),
  ).pipe(Atom.withLabel(`inbox-pages:${key}`));
});

/**
 * The Inbox's first `pages` pages, newest first; each refetches when the summary moves.
 * `snoozed` lists the task items snoozed until later instead.
 */
export function useInboxPages(
  environmentId: EnvironmentId,
  group: NonNullable<InboxListInput["group"]>,
  pages: number,
  snoozed = false,
): PagedView<InboxItem> {
  return useAtomValue(inboxPagesFamily(JSON.stringify({ environmentId, group, pages, snoozed })));
}

export interface SharedWithYouView extends PagedView<SharedWithYouItem> {
  readonly people: ReadonlyArray<SharedWithYouPerson>;
}

const sharedWithYouPagesFamily = Atom.family((key: string) => {
  const { environmentId, filters, pages } = JSON.parse(key) as {
    readonly environmentId: EnvironmentId;
    readonly filters: Omit<SharedWithYouListInput, "cursor" | "limit">;
    readonly pages: number;
  };
  return Atom.make((get): SharedWithYouView => {
    let people: ReadonlyArray<SharedWithYouPerson> = [];
    const view = readPages(
      pages,
      (cursor) => {
        const result = get(
          inboxEnvironment.sharedWithYou({
            environmentId,
            input: cursor === undefined ? filters : { ...filters, cursor },
          }),
        );
        // The first page's people cover every page under these filters.
        if (cursor === undefined) {
          people = AsyncResult.getOrElse(result, () => null)?.people ?? people;
        }
        return result;
      },
      (value) => value.items as ReadonlyArray<SharedWithYouItem>,
      (item) => item.threadId,
    );
    return { ...view, people };
  }).pipe(Atom.withLabel(`shared-with-you-pages:${key}`));
});

/** Shared with you under these filters, `pages` pages deep. */
export function useSharedWithYouPages(
  environmentId: EnvironmentId,
  filters: Omit<SharedWithYouListInput, "cursor" | "limit">,
  pages: number,
): SharedWithYouView {
  return useAtomValue(sharedWithYouPagesFamily(JSON.stringify({ environmentId, filters, pages })));
}

const NO_CLOSED_TASKS: ReadonlyArray<SpaceTask> = [];

/** My tasks' Done and Canceled: the viewer's newest closed tasks here. */
export function useClosedMyTasks(environmentId: EnvironmentId | null): ReadonlyArray<SpaceTask> {
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : inboxEnvironment.closedTasks({ environmentId, input: undefined }),
  );
  return query.data?.tasks ?? NO_CLOSED_TASKS;
}
