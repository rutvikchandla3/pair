import { useAtomValue } from "@effect/atom-react";
import { createInboxEnvironmentAtoms } from "@t3tools/client-runtime/state/inbox";
import {
  type EnvironmentId,
  INBOX_PAGE_LIMIT,
  type InboxItem,
  type InboxSummary,
  type MemberId,
  SHARED_WITH_YOU_PAGE_LIMIT,
  type SharedWithYouItem,
  type SharedWithYouListInput,
  type SharedWithYouPerson,
  type SharedWithYouState,
  type SpaceTask,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { useEnvironmentQuery } from "./query";
import { spaceTasksKeyAtom } from "./spaces";

export const inboxEnvironment = createInboxEnvironmentAtoms(
  connectionAtomRuntime,
  spaceTasksKeyAtom,
);

const NO_SUMMARY_ATOM = Atom.make<InboxSummary | null>(null).pipe(
  Atom.withLabel("mobile-inbox-summary:none"),
);

/** The live summary; reading it keeps `inbox.subscribeSummary` open. Null while loading. */
export function useInboxSummary(environmentId: EnvironmentId | null): InboxSummary | null {
  return useAtomValue(
    environmentId === null ? NO_SUMMARY_ATOM : inboxEnvironment.summaryValueAtom(environmentId),
  );
}

const EMPTY_ITEMS: ReadonlyArray<InboxItem> = [];

/**
 * The newest page of Inbox items; it refetches whenever the summary's revision moves. `snoozed`
 * lists the task items snoozed until later instead.
 */
export function useInboxItems(environmentId: EnvironmentId, snoozed = false) {
  const query = useEnvironmentQuery(
    inboxEnvironment.list({
      environmentId,
      input: snoozed ? { limit: INBOX_PAGE_LIMIT, snoozed } : { limit: INBOX_PAGE_LIMIT },
    }),
  );
  return {
    items: query.data?.items ?? EMPTY_ITEMS,
    loaded: query.data !== null,
    error: query.data === null ? query.error : null,
    refresh: query.refresh,
  };
}

const NO_CLOSED_TASKS: ReadonlyArray<SpaceTask> = [];

/** My tasks' Done and Canceled: the viewer's newest closed tasks here. */
export function useClosedMyTasks(environmentId: EnvironmentId): ReadonlyArray<SpaceTask> {
  const query = useEnvironmentQuery(
    inboxEnvironment.closedTasks({ environmentId, input: undefined }),
  );
  return query.data?.tasks ?? NO_CLOSED_TASKS;
}

/** My tasks' "Group by space", per environment, for this app session. */
export const myTasksGroupBySpaceAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(false).pipe(Atom.keepAlive, Atom.withLabel(`mobile-my-tasks-group:${environmentId}`)),
);

export interface SharedWithYouFilters {
  readonly personId: MemberId | null;
  readonly state: SharedWithYouState | null;
  readonly includeTaskThreads: boolean;
}

export const NO_SHARED_WITH_YOU_FILTERS: SharedWithYouFilters = {
  personId: null,
  state: null,
  includeTaskThreads: false,
};

export function hasSharedWithYouFilters(filters: SharedWithYouFilters): boolean {
  return filters.personId !== null || filters.state !== null || filters.includeTaskThreads;
}

/** The filters the Shared with you sheet sets, per environment, for this app session. */
export const sharedWithYouFiltersAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(NO_SHARED_WITH_YOU_FILTERS).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile-shared-with-you-filters:${environmentId}`),
  ),
);

const FIRST_PAGE: ReadonlyArray<string | null> = [null];
const NO_SHARED_ITEMS: ReadonlyArray<SharedWithYouItem> = [];
const NO_PEOPLE: ReadonlyArray<SharedWithYouPerson> = [];

/** Every loaded page for one filter set, keyed by `[environmentId, input, cursors]` as JSON. */
const sharedWithYouPagesFamily = Atom.family((key: string) => {
  const [environmentId, input, cursors] = JSON.parse(key) as [
    EnvironmentId,
    SharedWithYouListInput,
    ReadonlyArray<string | null>,
  ];
  return Atom.make((get) =>
    cursors.map((cursor) =>
      get(
        inboxEnvironment.sharedWithYou({
          environmentId,
          input: cursor === null ? input : { ...input, cursor },
        }),
      ),
    ),
  ).pipe(Atom.withLabel(`mobile-shared-with-you-pages:${key}`));
});

/** `sharedWithYou.list` under the filters and search, a page at a time. */
export function useSharedWithYouPages(
  environmentId: EnvironmentId,
  filters: SharedWithYouFilters,
  query: string,
) {
  const input: SharedWithYouListInput = {
    limit: SHARED_WITH_YOU_PAGE_LIMIT,
    ...(filters.personId === null ? {} : { personId: filters.personId }),
    ...(filters.state === null ? {} : { state: filters.state }),
    ...(filters.includeTaskThreads ? { includeTaskThreads: true } : {}),
    ...(query === "" ? {} : { query }),
  };
  const key = JSON.stringify([environmentId, input]);
  const [pagination, setPagination] = useState({ key, cursors: FIRST_PAGE });
  const cursors = pagination.key === key ? pagination.cursors : FIRST_PAGE;
  const results = useAtomValue(
    sharedWithYouPagesFamily(JSON.stringify([environmentId, input, cursors])),
  );
  const values = results.flatMap((result) => Option.toArray(AsyncResult.value(result)));
  const failed = results.find((result) => result._tag === "Failure");
  const failure = failed?._tag === "Failure" ? Cause.squash(failed.cause) : null;
  const nextCursor = values.length === results.length ? (values.at(-1)?.nextCursor ?? null) : null;
  return {
    items: values.length === 0 ? NO_SHARED_ITEMS : values.flatMap((value) => value.items),
    people: values[0]?.people ?? NO_PEOPLE,
    loaded: values.length > 0,
    hasMore: nextCursor !== null,
    loadingMore: results.length > 1 && values.length < results.length && failure === null,
    error:
      failure === null
        ? null
        : failure instanceof Error && failure.message.trim() !== ""
          ? failure.message
          : "Couldn't load threads shared with you.",
    loadMore: () => {
      if (nextCursor === null) return;
      setPagination((current) => {
        const currentCursors = current.key === key ? current.cursors : FIRST_PAGE;
        return currentCursors.includes(nextCursor)
          ? { key, cursors: currentCursors }
          : { key, cursors: [...currentCursors, nextCursor] };
      });
    },
    refresh: () => {
      setPagination({ key, cursors: FIRST_PAGE });
      appAtomRegistry.refresh(inboxEnvironment.sharedWithYou({ environmentId, input }));
    },
  };
}
