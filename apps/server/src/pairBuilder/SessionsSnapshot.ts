import {
  type OrchestrationV2ThreadShell,
  type PairBuilderSessionsSnapshot,
  type PairBuilderSnapshotSession,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const TITLE_MAX_LENGTH = 80;
// The Builder only titles and timestamps from it, and refuses snapshots over 4 MiB.
const FIRST_MESSAGE_MAX_LENGTH = 500;
const ELLIPSIS = "…";
const UNTITLED = "New session";
// A thread keeps this title until the first message names it.
const PLACEHOLDER_THREAD_TITLE = "New thread";
const LIVE_STATUSES: ReadonlySet<OrchestrationV2ThreadShell["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

export interface SnapshotThread {
  readonly shell: OrchestrationV2ThreadShell;
  /** The first message a person sent, as typed; empty before there is one. */
  readonly firstMessage: string;
  readonly createdBy: PairBuilderSnapshotSession["created_by"];
}

const singleLine = (text: string) => text.replace(/\s+/gu, " ").trim();

function cut(text: string, maxLength: number): string {
  const chars = Array.from(text);
  return chars.length <= maxLength
    ? text
    : `${chars
        .slice(0, maxLength - ELLIPSIS.length)
        .join("")
        .trimEnd()}${ELLIPSIS}`;
}

/** The thread's own title, else its first message cut to 80 characters, else "New session". */
function sessionTitle(title: string, firstMessage: string): string {
  const named = singleLine(title);
  if (named.length > 0 && named !== PLACEHOLDER_THREAD_TITLE) return named;
  const message = singleLine(firstMessage);
  return message.length === 0 ? UNTITLED : cut(message, TITLE_MAX_LENGTH);
}

/** Working, as the thread list shows it: a live run that is not blocked on a person. */
function isStreaming(shell: OrchestrationV2ThreadShell): boolean {
  if (shell.pendingRuntimeRequest !== null && shell.pendingRuntimeRequest.blocking !== false) {
    return false;
  }
  return (shell.activityRunStatus ?? null) !== null || LIVE_STATUSES.has(shell.status);
}

export function buildSessionsSnapshot(input: {
  readonly sandboxId: string | undefined;
  readonly sentAt: DateTime.Utc;
  readonly connections: number;
  readonly threads: ReadonlyArray<SnapshotThread>;
}): PairBuilderSessionsSnapshot {
  return {
    type: "sessions.snapshot",
    sandbox_id: input.sandboxId ?? null,
    sent_at: DateTime.formatIso(input.sentAt),
    connections: input.connections,
    sessions: input.threads.map(({ shell, firstMessage, createdBy }) => {
      const createdAt = DateTime.toEpochMillis(shell.createdAt);
      return {
        id: shell.id,
        runtime_session_id: null,
        name: shell.title,
        first_message: cut(firstMessage.trim(), FIRST_MESSAGE_MAX_LENGTH),
        title: sessionTitle(shell.title, firstMessage),
        created_at: createdAt,
        updated_at: Math.max(createdAt, DateTime.toEpochMillis(shell.updatedAt)),
        is_streaming: isStreaming(shell),
        archived: shell.archivedAt !== null || shell.deletedAt !== null,
        created_by: createdBy,
      };
    }),
  };
}
