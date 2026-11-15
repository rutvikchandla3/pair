import type { OrchestrationV2Run, OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

// What the agent is told before its next turn about lineage steps between turns. Each step's
// note is an `agent-told` row on the thread, so the person sees exactly what the agent was told.

const MAX_LISTED_FILES = 20;

export const listFiles = (paths: ReadonlyArray<string>) =>
  paths.length <= MAX_LISTED_FILES
    ? paths.join(", ")
    : `${paths.slice(0, MAX_LISTED_FILES).join(", ")} and ${paths.length - MAX_LISTED_FILES} more`;

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

export const appliedNote = (input: {
  readonly senderName: string;
  readonly branchTitle: string;
  readonly files: number;
}) =>
  `${input.senderName}'s changes from ${input.branchTitle} were applied to your files: ${plural(input.files, "file")}. Credit ${input.senderName} when you commit them.`;

export const updatedNote = (input: {
  readonly sourceTitle: string;
  readonly paths: ReadonlyArray<string>;
}) =>
  `${input.sourceTitle} was merged into your branch: ${plural(input.paths.length, "file")} changed: ${listFiles(input.paths)}.`;

const openUpdateNote = (input: {
  readonly sourceTitle: string;
  readonly paths: ReadonlyArray<string>;
}) =>
  `An update from ${input.sourceTitle} is in progress. These files have conflict markers: ${listFiles(input.paths)}. Resolve them and commit; don't abort or stash the merge.`;

/** `agent-told` rows recorded after the thread's previous turn started, oldest first. */
export function pendingAgentNotes(input: {
  readonly runId: RunId;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "startedAt">>;
  readonly notices: ReadonlyArray<OrchestrationV2TurnItem>;
}): ReadonlyArray<string> {
  let since = Number.NEGATIVE_INFINITY;
  for (const run of input.runs) {
    if (run.id === input.runId || run.startedAt === null) continue;
    since = Math.max(since, DateTime.toEpochMillis(run.startedAt));
  }
  return input.notices
    .flatMap((item) => {
      if (item.type !== "system_notice" || item.runId !== null) return [];
      if (item.lineage?.kind !== "agent-told" || item.startedAt === null) return [];
      const at = DateTime.toEpochMillis(item.startedAt);
      return at > since ? [{ at, text: item.lineage.text }] : [];
    })
    .toSorted((left, right) => left.at - right.at)
    .map((note) => note.text);
}

export interface TurnStartLineage {
  /** The thread's runless `agent-told` rows. */
  readonly notices: ReadonlyArray<OrchestrationV2TurnItem>;
  /** On a branch whose Update merge is still open. */
  readonly openUpdate: {
    readonly sourceTitle: string | null;
    readonly conflictedPaths: ReadonlyArray<string>;
  } | null;
}

/** The lineage note for a turn that is starting; empty when there is nothing to tell. */
export function lineageTurnNote(input: {
  readonly runId: RunId;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "startedAt">>;
  readonly lineage: TurnStartLineage | undefined;
}): string {
  if (input.lineage === undefined) return "";
  const notes = [...pendingAgentNotes({ ...input, notices: input.lineage.notices })];
  const open = input.lineage.openUpdate;
  if (open !== null) {
    notes.push(
      openUpdateNote({
        sourceTitle: open.sourceTitle ?? "the source thread",
        paths: open.conflictedPaths,
      }),
    );
  }
  return notes.join("\n");
}
