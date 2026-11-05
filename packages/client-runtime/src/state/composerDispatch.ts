import type {
  MemberId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { canChangeQueuedRun, runStarterId } from "@t3tools/shared/threadCollaboration";

import { isTeamModeMembers, type TeamMembers } from "./team.ts";

export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

export function resolveComposerDispatchMode(input: {
  readonly running: boolean;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
  /** False while the active turn cannot take steering input, such as during compaction. */
  readonly canSteer?: boolean;
}): ComposerDispatchMode {
  if (!input.running) return "auto";
  if (input.canSteer === false) return "queue";
  const defaultAction = input.activeTurnDefault ?? "steer";
  if (input.alternateModifier) return defaultAction === "queue" ? "steer" : "queue";
  return defaultAction;
}

export function alternateComposerDispatchAction(
  activeTurnDefault?: ActiveTurnComposerAction,
): ActiveTurnComposerAction {
  return resolveComposerDispatchMode({
    running: true,
    alternateModifier: true,
    ...(activeTurnDefault === undefined ? {} : { activeTurnDefault }),
  }) as ActiveTurnComposerAction;
}

const ACTIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

type ThreadProjectionForStarter = {
  readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "ownerId">;
  readonly messages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "id" | "authorId">>;
};

function holderIdOf(
  thread: ThreadProjectionForStarter["thread"],
  members: TeamMembers,
): MemberId | null {
  let holderId = thread.ownerId ?? null;
  if (holderId === null) {
    for (const member of members.values()) if (member.isOwner) holderId = member.id;
  }
  return holderId;
}

/**
 * On a team, who started the active turn when it was not `me`: sends then queue by default and
 * steering is an explicit choice. Null for your own turn, an idle thread and single-member servers.
 */
export function othersTurnStarterId(input: {
  readonly projection: ThreadProjectionForStarter & {
    readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "userMessageId">>;
  };
  readonly members: TeamMembers;
  readonly me: MemberId | null;
}): MemberId | null {
  if (input.me === null || !isTeamModeMembers(input.members)) return null;
  // The server steers the last active run, so this is the one whose starter matters.
  const run = input.projection.runs.findLast((candidate) =>
    ACTIVE_RUN_STATUSES.has(candidate.status),
  );
  const holderId = holderIdOf(input.projection.thread, input.members);
  if (run === undefined || holderId === null) return null;
  const starter = runStarterId({ run, messages: input.projection.messages, holderId });
  return starter === input.me ? null : starter;
}

/**
 * On a team, what `me` may do with a queued run, mirroring the server: only its author edits the
 * text; its author or the holder sends, reorders or removes it. Null when everything is allowed.
 */
export function queuedRunLock(input: {
  readonly projection: ThreadProjectionForStarter;
  readonly run: Pick<OrchestrationV2Run, "userMessageId">;
  readonly members: TeamMembers;
  readonly me: MemberId | null;
}): {
  readonly starterId: MemberId;
  readonly canEdit: boolean;
  readonly canControl: boolean;
} | null {
  if (input.me === null || !isTeamModeMembers(input.members)) return null;
  const holderId = holderIdOf(input.projection.thread, input.members);
  if (holderId === null) return null;
  const starterId = runStarterId({ run: input.run, messages: input.projection.messages, holderId });
  const rule = { actorId: input.me, holderId, starterId, teamMode: true };
  const canEdit = canChangeQueuedRun({ ...rule, action: "edit" });
  const canControl = canChangeQueuedRun({ ...rule, action: "control" });
  return canEdit && canControl ? null : { starterId, canEdit, canControl };
}

const DISCARDED_RUN_STATUSES = new Set(["completed", "interrupted", "failed"]);

/**
 * On a team, whose turns reverting to `targetTurnCount` discards, other than `me`'s, in the order
 * they ran. Runs mirror the server's rollback; the bounded projection drops older runs, so turns
 * whose run it no longer holds are read from the timeline's messages instead.
 */
export function discardedTurnAuthors(input: {
  readonly projection: Pick<ThreadProjectionForStarter, "thread"> & {
    readonly runs: ReadonlyArray<
      Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "userMessageId">
    >;
  };
  /** The timeline's messages from the one being edited onward. */
  readonly messages: ReadonlyArray<{
    readonly id: OrchestrationV2ConversationMessage["id"];
    readonly role: string;
    readonly runId: OrchestrationV2Run["id"] | null;
    readonly authorId?: MemberId | undefined;
  }>;
  readonly targetTurnCount: number;
  readonly members: TeamMembers;
  readonly me: MemberId | null;
}): ReadonlyArray<{ readonly memberId: MemberId; readonly count: number }> {
  if (input.me === null || !isTeamModeMembers(input.members)) return [];
  const holderId = holderIdOf(input.projection.thread, input.members);
  if (holderId === null) return [];
  const counts = new Map<MemberId, number>();
  const add = (memberId: MemberId) => {
    if (memberId !== input.me) counts.set(memberId, (counts.get(memberId) ?? 0) + 1);
  };
  // Turns the projection no longer holds are older than its runs. Paged-in history only shows live
  // turns, and a run's first user message is its starter's.
  const heldRunIds = new Set<string>(input.projection.runs.map((run) => run.id));
  for (const message of input.messages) {
    if (message.role !== "user" || message.runId === null || heldRunIds.has(message.runId))
      continue;
    heldRunIds.add(message.runId);
    add(message.authorId ?? holderId);
  }
  for (const run of input.projection.runs) {
    if (run.ordinal <= input.targetTurnCount || !DISCARDED_RUN_STATUSES.has(run.status)) continue;
    add(runStarterId({ run, messages: input.messages, holderId }));
  }
  return [...counts].map(([memberId, count]) => ({ memberId, count }));
}
