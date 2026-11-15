import { type EnvironmentId, type InboxSummary, WS_METHODS } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * The Inbox for one environment: its summary from `inbox.subscribeSummary`, and pages from
 * `inbox.list` that refetch while read whenever the summary's revision moves. `tasksKeyAtom`
 * moves on every space or task write (`createSpaceShellAtoms`' `roomsKeyAtom`).
 */
export function createInboxEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  tasksKeyAtom: (environmentId: EnvironmentId) => Atom.Atom<unknown>,
) {
  /** The summary, then each change. Mount it for one environment with `input: undefined`. */
  const summary = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:inbox:summary",
    tag: WS_METHODS.inboxSubscribeSummary,
  });

  const summaryValueFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): InboxSummary | null =>
      Option.getOrNull(AsyncResult.value(get(summary({ environmentId, input: undefined })))),
    ).pipe(Atom.withLabel(`inbox-summary-value:${environmentId}`)),
  );

  /** Moves whenever any visible item does; held otherwise, so readers refetch only then. */
  const revisionFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(summaryValueFamily(environmentId))?.revision ?? null).pipe(
      Atom.withLabel(`inbox-revision:${environmentId}`),
    ),
  );

  /** `inbox.list`; keyed by group, cursor and limit. */
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:inbox:list",
    tag: WS_METHODS.inboxList,
    refreshTrigger: ({ environmentId }) => revisionFamily(environmentId),
  });

  /** `sharedWithYou.list`; keyed by its filters and cursor. */
  const sharedWithYou = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:inbox:shared-with-you",
    tag: WS_METHODS.sharedWithYouList,
  });

  /** My tasks' Done and Canceled, `myTasks.listClosed`; mount with `input: undefined`. */
  const closedTasks = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:inbox:closed-tasks",
    tag: WS_METHODS.myTasksListClosed,
    refreshTrigger: ({ environmentId }) => tasksKeyAtom(environmentId),
  });

  return {
    summary,
    /** The summary, or null while loading or on error. */
    summaryValueAtom: (environmentId: EnvironmentId) => summaryValueFamily(environmentId),
    revisionAtom: (environmentId: EnvironmentId) => revisionFamily(environmentId),
    list,
    sharedWithYou,
    closedTasks,
    /** Done on a For you item. */
    dismiss: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:inbox:dismiss",
      tag: WS_METHODS.inboxDismiss,
    }),
    /** Task items only; a thread's item snoozes the thread with `thread.snooze`. */
    snooze: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:inbox:snooze",
      tag: WS_METHODS.inboxSnooze,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.itemId}`,
      },
    }),
    unsnooze: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:inbox:unsnooze",
      tag: WS_METHODS.inboxUnsnooze,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.itemId}`,
      },
    }),
  };
}
