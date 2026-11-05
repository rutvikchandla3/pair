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
}): { readonly starterId: MemberId; readonly canEdit: boolean; readonly canControl: boolean } | null {
  if (input.me === null || !isTeamModeMembers(input.members)) return null;
  const holderId = holderIdOf(input.projection.thread, input.members);
  if (holderId === null) return null;
  const starterId = runStarterId({ run: input.run, messages: input.projection.messages, holderId });
  const rule = { actorId: input.me, holderId, starterId, teamMode: true };
  const canEdit = canChangeQueuedRun({ ...rule, action: "edit" });
  const canControl = canChangeQueuedRun({ ...rule, action: "control" });
  return canEdit && canControl ? null : { starterId, canEdit, canControl };
}
