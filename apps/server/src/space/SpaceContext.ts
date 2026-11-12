import {
  isSpaceActiveMember,
  type MemberId,
  type OrchestrationV2ThreadShell,
  type Space,
  type SpaceAction,
  SpaceError,
  type SpaceNoteItem,
  type SpaceRoomEntry,
} from "@t3tools/contracts";
import { spaceTaskState } from "@t3tools/shared/spaceTaskState";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import type * as Members from "../persistence/Members.ts";
import { TeamState } from "../team/TeamState.ts";
import { spaceReplyTrigger } from "./SpaceAgentDecisions.ts";
import {
  type SpaceAgentRequest,
  SpaceAgentTools,
  type SpaceContentBlock,
  SpaceContext,
  type SpaceReplyScope,
  type SpaceTextBlock,
} from "./SpaceAgentRuntime.ts";
import { SPACE_AGENT_INSTRUCTIONS } from "./spaceAgentInstructions.ts";

/** Budgets in tokens (spaces-agent §4), estimated as characters / 4: cheap, and close enough. */
export const SPACE_CONTEXT_BUDGETS = {
  space: 300,
  brief: 1_500,
  notes: 2_000,
  room: 8_000,
  tasks: 2_500,
  trigger: 4_000,
  post: 1_000,
  toolResult: 3_000,
} as const;

/** Room entries loaded per reply; older ones are a `space_search` away. */
const SPACE_ROOM_WINDOW = 2_000;
const CHUNK_TARGET = 20;
const CHUNK_MAX = 40;
const OPEN_QUESTION_DAYS = 14;

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** Cuts `text` to `tokens`, ending with `marker`. */
export const capTokens = (text: string, tokens: number, marker: string) =>
  estimateTokens(text) <= tokens
    ? text
    : `${text.slice(0, tokens * 4 - marker.length - 1)}${marker}`;

const SECTION_TAG = /<(\/?)(space|brief|notes|room|tasks|trigger|task_output|already_done)\b/gi;

/** Untrusted text can't open or close one of the prompt's sections (§11). */
export const fence = (text: string) => text.replace(SECTION_TAG, "‹$1$2");

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** `Tue 10:42`, in UTC like the system message says. */
const timeLabel = (iso: string) => {
  const date = DateTime.make(iso);
  if (Option.isNone(date)) return iso;
  const parts = DateTime.toPartsUtc(date.value);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${DAYS[parts.weekDay]} ${pad(parts.hour)}:${pad(parts.minute)}`;
};

const epochMillis = (iso: string) =>
  Option.match(DateTime.make(iso), { onNone: () => 0, onSome: DateTime.toEpochMillis });

export interface MemberDirectory {
  readonly name: (memberId: MemberId) => string;
  readonly role: (memberId: MemberId) => Members.MemberRecord["role"] | null;
}

export const memberDirectory = (
  members: ReadonlyMap<MemberId, Members.MemberRecord>,
): MemberDirectory => ({
  name: (memberId) => members.get(memberId)?.name ?? memberId,
  role: (memberId) => members.get(memberId)?.role ?? null,
});

export type SpaceTaskShell = OrchestrationV2ThreadShell & {
  readonly space: Extract<NonNullable<OrchestrationV2ThreadShell["space"]>, { kind: "task" }>;
};

/** Pair's reach: the space's live tasks, and only while the tagger is in the space (§6). */
export const spaceTasksInReach = Effect.fn("SpaceContext.tasksInReach")(function* (
  projections: ProjectionStoreV2["Service"],
  space: Space,
  taggerId: MemberId,
) {
  if (!isSpaceActiveMember(space, taggerId)) return [];
  const ids = yield* projections.listSpaceTaskThreadIds(space.id);
  const shells = yield* Effect.forEach(ids, (id) => projections.getThreadShell(id), {
    concurrency: 8,
  });
  return shells.filter(
    (shell): shell is SpaceTaskShell =>
      shell !== null &&
      shell.deletedAt === null &&
      shell.space?.kind === "task" &&
      shell.space.spaceId === space.id,
  );
});

export const taskStatusText = (shell: SpaceTaskShell, members: MemberDirectory) => {
  const state = spaceTaskState(shell);
  const owner = shell.ownerId == null ? "nobody" : members.name(shell.ownerId);
  switch (state.type) {
    case "not-started":
      return `Not started, waiting for ${owner}`;
    case "needs":
      return `Needs ${state.memberId === null ? owner : members.name(state.memberId)}: ${state.reason}`;
    case "in-review":
      return "In review";
    default:
      return state.type.charAt(0).toUpperCase() + state.type.slice(1);
  }
};

const isTaskOpen = (shell: SpaceTaskShell) => spaceTaskState(shell).type !== "done";

const ledgerLine = (shell: SpaceTaskShell, members: MemberDirectory) =>
  [
    shell.id,
    fence(shell.title),
    shell.ownerId == null ? "no owner" : members.name(shell.ownerId),
    taskStatusText(shell, members),
    timeLabel(DateTime.formatIso(shell.updatedAt)),
  ].join(" · ");

/**
 * A record's one line, from its events; never from what a reply said. Its state can change, so
 * transcript lines leave it out to keep closed room parts byte-stable (§4 bp3).
 */
const actionLine = (action: SpaceAction, members: MemberDirectory, withState = true) => {
  const asked = `asked by ${members.name(action.actorId)}`;
  const state = !withState || action.state === "done" ? "" : ` (${action.state})`;
  const outcome = action.outcome;
  if (outcome?.type === "task.created") {
    return `Pair created "${fence(outcome.title)}" (${outcome.threadId}) for ${members.name(outcome.ownerId)} · ${asked}${state}`;
  }
  if (outcome?.type === "task.message.queued") {
    return `Pair queued a message in "${fence(outcome.title)}" for ${members.name(action.actorId)}${state}`;
  }
  if (outcome?.type === "notes.changed") {
    const items = outcome.changes.map((change) => `${change.op} "${fence(change.text)}"`);
    return `Pair changed the notes: ${items.join("; ")} · ${asked}${state}`;
  }
  if (action.request.type === "task.message") {
    const task = action.proposal?.snapshot.title ?? action.request.taskId;
    return `Pair asked ${members.name(action.actorId)} to confirm a message to "${fence(task)}"${state}`;
  }
  return `Pair ${action.request.type} · ${asked}${state}`;
};

interface TranscriptLine {
  readonly id: string;
  readonly at: string;
  readonly text: string;
}

const postLine = (id: string, who: string, at: string, text: string) => {
  const head = `[${id} · ${who} · ${timeLabel(at)}] `;
  const marker = ` … (read ${id} for the rest)`;
  return head + capTokens(fence(text), SPACE_CONTEXT_BUDGETS.post, marker);
};

const systemLineText = (entry: Extract<SpaceRoomEntry, { type: "system" }>, m: MemberDirectory) => {
  const actor = m.name(entry.actorId);
  const line = entry.line;
  switch (line.type) {
    case "task-created":
      return `${actor} created task ${line.threadId} for ${m.name(line.ownerId)}`;
    case "task-handed-back":
      return `${actor} handed back task ${line.threadId}: ${fence(line.reason)}`;
    case "members-added":
      return `${actor} added ${line.memberIds.map(m.name).join(", ")}`;
    case "member-removed":
    case "member-restored":
      return `${actor} ${line.type === "member-removed" ? "removed" : "restored"} ${m.name(line.memberId)}`;
    case "owner-transferred":
      return `${actor} made ${m.name(line.ownerId)} the owner`;
    case "renamed":
      return `${actor} renamed the space to ${fence(line.name)}`;
    default:
      return `${actor}: ${line.type}`;
  }
};

/** FNV-1a: chunk edges depend only on the lines, so a closed chunk keeps its bytes (§4 bp3). */
const edgeHash = (id: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/** Closed chunks average 20 lines and never change; the open chunk takes new posts. */
const chunkTranscript = (lines: ReadonlyArray<string>, ids: ReadonlyArray<string>) => {
  const closed: Array<ReadonlyArray<string>> = [];
  let open: Array<string> = [];
  lines.forEach((line, index) => {
    open.push(line);
    if (edgeHash(ids[index]!) % CHUNK_TARGET === 0 || open.length >= CHUNK_MAX) {
      closed.push(open);
      open = [];
    }
  });
  return { closed, open };
};

const renderNote = (item: SpaceNoteItem, members: MemberDirectory, nowMs: number) => {
  const section =
    item.section === "decision"
      ? "Decision"
      : item.section === "question"
        ? "Open question"
        : "How we work";
  const ageDays = Math.floor((nowMs - epochMillis(item.createdAt)) / 86_400_000);
  const detail = [
    item.answerer === undefined ? null : `${members.name(item.answerer)} to answer`,
    item.section === "question" && ageDays > OPEN_QUESTION_DAYS ? `open ${ageDays} days` : null,
  ].filter((part) => part !== null);
  const sources = item.sources
    .map((s) => `${members.name(s.authorId)} · ${timeLabel(s.at)} (${s.messageId})`)
    .join("; ");
  const writer =
    item.lastEditedBy.type === "member"
      ? `edited by ${members.name(item.lastEditedBy.memberId)}`
      : item.createdBy.type === "pair"
        ? "added by Pair"
        : `added by ${members.name(item.createdBy.memberId)}`;
  return `[${item.id} v${item.version}] ${section}${detail.length === 0 ? "" : ` (${detail.join(", ")})`}: ${fence(item.text)} (from ${sources}) · ${writer}`;
};

const block = (text: string, cacheTtl?: "5m" | "1h"): SpaceTextBlock =>
  cacheTtl === undefined
    ? { type: "text", text }
    : { type: "text", text, cache_control: { type: "ephemeral", ttl: cacheTtl } };

const isSpaceError = Schema.is(SpaceError);

const readFailure = (cause: unknown) =>
  new SpaceError({
    reason: "failed",
    message: `Couldn't read the space: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const team = yield* TeamState;
  const tools = yield* SpaceAgentTools;

  const assemble = Effect.fn("SpaceContext.assemble")(
    function* (scope: SpaceReplyScope) {
      const space = yield* projections.getSpace(scope.spaceId);
      if (space === null) {
        return yield* new SpaceError({
          reason: "not-found",
          message: `No space ${scope.spaceId}.`,
        });
      }
      const members = memberDirectory(yield* Ref.get(team.members));
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const triggerId = spaceReplyTrigger(scope.roomMessageId);

      const active = space.members.filter((member) => member.removedAt === null);
      const spaceText = capTokens(
        [
          `<space>`,
          `Name: ${fence(space.name)}`,
          `Project: ${space.projectId}`,
          `Members:`,
          ...active.map(
            (member) =>
              `- ${members.name(member.memberId)} (${member.memberId}) · ${members.role(member.memberId) ?? "member"}${member.memberId === space.ownerId ? " · space owner" : ""}`,
          ),
          `</space>`,
        ].join("\n"),
        SPACE_CONTEXT_BUDGETS.space,
        "\n…\n</space>",
      );
      const briefText = `<brief>\n${capTokens(fence(space.brief.trim() || "(empty)"), SPACE_CONTEXT_BUDGETS.brief, " … (cut)")}\n</brief>`;
      const notes = yield* projections.listSpaceNotes(space.id);
      const notesText = `<notes>\n${
        notes.length === 0
          ? "(none yet)"
          : capTokens(
              notes.map((item) => renderNote(item, members, now.epochMilliseconds)).join("\n"),
              SPACE_CONTEXT_BUDGETS.notes,
              " … (cut)",
            )
      }\n</notes>`;

      const entries = yield* projections.listSpaceRoomEntries({
        spaceId: space.id,
        limit: SPACE_ROOM_WINDOW,
      });
      // Replies and records are bounded by the window's oldest post once the window is full.
      const windowFull = entries.length >= SPACE_ROOM_WINDOW;
      const since = windowFull ? entries[0]?.createdAt : undefined;
      const replies = yield* projections.listSpaceRoomReplies({
        roomThreadId: space.roomThreadId,
        since,
        limit: SPACE_ROOM_WINDOW,
      });
      const actions = yield* projections.listSpaceActions({
        spaceId: space.id,
        limit: SPACE_ROOM_WINDOW,
        since,
      });
      const postAuthor = new Map(
        entries.flatMap((entry) => (entry.type === "post" ? [[entry.id, entry.authorId]] : [])),
      );
      const transcript: Array<TranscriptLine> = [
        ...entries.map((entry) => ({
          id: entry.id,
          at: entry.createdAt,
          text:
            entry.type === "post"
              ? postLine(
                  entry.id,
                  entry.authorKind === "agent"
                    ? `${members.name(entry.authorId)}'s agent`
                    : members.name(entry.authorId),
                  entry.createdAt,
                  entry.quote === undefined
                    ? entry.text
                    : `(quoting ${entry.quote.entryId}) ${entry.text}`,
                )
              : `[${entry.id} · room · ${timeLabel(entry.createdAt)}] ${systemLineText(entry, members)}`,
        })),
        ...replies.flatMap(({ message, triggerId }) => {
          if (message.runId === scope.runId) return [];
          const tagger =
            triggerId === null ? undefined : postAuthor.get(spaceReplyTrigger(triggerId));
          const at = DateTime.formatIso(message.createdAt);
          const who = tagger === undefined ? "Pair" : `Pair, for ${members.name(tagger)}`;
          return [{ id: message.id, at, text: postLine(message.id, who, at, message.text) }];
        }),
        ...actions.map((action) => ({
          id: action.id,
          at: action.createdAt,
          text: `[record · ${timeLabel(action.createdAt)}] ${actionLine(action, members, false)}`,
        })),
      ].toSorted((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));

      const chunks = chunkTranscript(
        transcript.map((line) => line.text),
        transcript.map((line) => line.id),
      );
      // A full window slides with every post, so its first, partial chunk would change each time.
      const closed = windowFull ? chunks.closed.slice(1) : [...chunks.closed];
      const size = (lines: ReadonlyArray<string>) => estimateTokens(lines.join("\n"));
      let roomTokens = closed.reduce((sum, lines) => sum + size(lines), size(chunks.open));
      let dropped = 0;
      while (closed.length > 0 && roomTokens > SPACE_CONTEXT_BUDGETS.room) {
        roomTokens -= size(closed.shift()!);
        dropped++;
      }
      const earlier =
        dropped > 0 || windowFull
          ? "(Earlier messages are not shown; space_search finds them.)\n"
          : "";
      const closedBlocks = closed.map((lines, index) =>
        block(
          `<room part="${index + 1}">\n${index === 0 ? earlier : ""}${lines.join("\n")}\n</room>`,
          index === closed.length - 1 ? "5m" : undefined,
        ),
      );
      const unsettled = actions.filter((action) => action.state !== "done");
      const openText = `<room part="latest">\n${closed.length === 0 ? earlier : ""}${
        chunks.open.length === 0 ? "(no newer messages)" : chunks.open.join("\n")
      }${
        unsettled.length === 0
          ? ""
          : `\nRecords not done:\n${unsettled
              .map(
                (action) =>
                  `- [record · ${timeLabel(action.createdAt)}] ${actionLine(action, members)}`,
              )
              .join("\n")}`
      }\n</room>`;

      const tasks = yield* spaceTasksInReach(projections, space, scope.taggerId);
      const byActivity = (left: SpaceTaskShell, right: SpaceTaskShell) =>
        right.updatedAt.epochMilliseconds - left.updatedAt.epochMilliseconds;
      const open = tasks.filter(isTaskOpen).toSorted(byActivity);
      const done = tasks.filter((task) => !isTaskOpen(task)).toSorted(byActivity);
      const ledger: Array<string> = [];
      let ledgerTokens = 0;
      const fits = (line: string) =>
        ledgerTokens + estimateTokens(line) <= SPACE_CONTEXT_BUDGETS.tasks;
      for (const [index, task] of open.entries()) {
        const line = ledgerLine(task, members);
        if (!fits(line)) {
          ledger.push(`and ${open.length - index} more open`);
          break;
        }
        ledger.push(line);
        ledgerTokens += estimateTokens(line);
      }
      let shownDone = 0;
      for (const task of done) {
        const line = ledgerLine(task, members);
        if (!fits(`${line}\nand ${done.length} done`)) break;
        ledger.push(line);
        ledgerTokens += estimateTokens(line);
        shownDone++;
      }
      if (shownDone < done.length) ledger.push(`and ${done.length - shownDone} done`);
      const tasksText = `<tasks>\n${ledger.length === 0 ? "(no tasks yet)" : ledger.join("\n")}\n</tasks>`;

      const trigger = yield* projections.getSpaceRoomEntry(triggerId);
      const triggerText =
        trigger?.type !== "post"
          ? `<trigger>\n(the tagged post ${triggerId} is gone)\n</trigger>`
          : `<trigger id="${trigger.id}" author="${members.name(trigger.authorId)}" at="${timeLabel(trigger.createdAt)}">\n${capTokens(
              fence(
                trigger.quote === undefined
                  ? trigger.text
                  : `(quoting ${trigger.quote.entryId}: "${trigger.quote.text}") ${trigger.text}`,
              ),
              SPACE_CONTEXT_BUDGETS.trigger,
              ` … (cut; space_message_read ${trigger.id} has the rest)`,
            )}\n</trigger>`;

      const already = (yield* projections.listSpaceActions({ roomMessageId: triggerId })).filter(
        (action) => action.state === "done" || action.state === "proposed",
      );
      const role = members.role(scope.taggerId);
      const systemText = [
        `The tagger is ${members.name(scope.taggerId)} (${scope.taggerId}), team role ${role ?? "member"}${role === "admin" ? " (an admin)" : " (not an admin)"}${scope.taggerId === space.ownerId ? ", the space's owner" : ""}.`,
        `The trigger is ${triggerId}. Now: ${nowIso} (${timeLabel(nowIso)} UTC). Times above are UTC.`,
        ...(already.length === 0
          ? []
          : [
              `Already done in the failed attempt:`,
              ...already.map((action) => `- ${actionLine(action, members)}`),
            ]),
      ].join("\n");

      const content: ReadonlyArray<SpaceContentBlock> = [
        block(spaceText),
        block(briefText),
        block(notesText, "5m"),
        ...closedBlocks,
        block(openText),
        block(tasksText),
        block(triggerText),
      ];
      return {
        system: [block(SPACE_AGENT_INSTRUCTIONS, "1h")],
        tools: tools.definitions,
        messages: [
          { role: "user", content },
          { role: "system", content: systemText },
        ],
      } satisfies SpaceAgentRequest;
    },
    Effect.mapError((error) => (isSpaceError(error) ? error : readFailure(error))),
  );

  return SpaceContext.of({ assemble });
});

export const layer = Layer.effect(SpaceContext, make);
