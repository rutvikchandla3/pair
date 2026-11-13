import {
  isListedThreadLineage,
  isSpaceActiveMember,
  type MemberId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2SpaceCommand,
  type OrchestrationV2SpaceTaskChange,
  type Space,
  SPACE_AGENT_DEFAULT_MODEL,
  SPACE_AGENT_INSTANCE_ID,
  SPACE_QUOTE_MAX_LENGTH,
  type SpaceAction,
  type SpaceMention,
  type SpaceMember,
  type SpaceRoomEntry,
  type SpaceSystemLine,
  type SpaceTask,
  type ThreadId,
  SpaceError,
  type SpaceId,
  spaceTaskIsOpen,
  type ThreadSpaceTask,
} from "@t3tools/contracts";

import type { SpaceAgentCommand } from "./SpaceAgentDecisions.ts";

/** A room thread runs only on `spaceAgent`; any other selection becomes its default. */
export const spaceAgentSelection = (current: ModelSelection): ModelSelection =>
  current.instanceId === SPACE_AGENT_INSTANCE_ID
    ? current
    : { instanceId: SPACE_AGENT_INSTANCE_ID, model: SPACE_AGENT_DEFAULT_MODEL };

/**
 * Never steer: a message `@pair` sends only queues (spaces-agent §7). Only room threads run on
 * `spaceAgent`, and a room takes no other provider.
 */
export function spaceMessageRefusal(
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
  thread: Pick<OrchestrationV2AppThread, "space">,
): string | null {
  if (
    command.via !== undefined &&
    (command.dispatchMode.type !== "queue_after_active" ||
      command.deliveryIntent !== undefined ||
      command.steerOthersTurn === true ||
      command.restartContinuationOfRunId !== undefined)
  ) {
    return "A message @pair sends only queues; it never steers or restarts a turn.";
  }
  if (command.via !== undefined && thread.space?.kind !== "task") {
    return "@pair only messages the threads on a space's tasks.";
  }
  const onSpaceAgent = command.modelSelection?.instanceId === SPACE_AGENT_INSTANCE_ID;
  const isRoom = thread.space?.kind === "room";
  if (onSpaceAgent && !isRoom) return "Only a space's room runs on @pair.";
  if (isRoom && command.modelSelection !== undefined && !onSpaceAgent) {
    return "A space's room runs only on @pair.";
  }
  return null;
}

/** Why a space command is refused; the client sees it as a `SpaceError`. */
export type SpaceRefusal = Exclude<SpaceError["reason"], "failed">;

/** The cause an `OrchestratorDispatchError` carries, which `SpaceService` hands to the client. */
export const spaceRefusal = (
  spaceId: SpaceId,
  action: string,
  reason: SpaceRefusal,
  message?: string,
) =>
  new SpaceError({
    reason,
    message: message ?? `Space ${spaceId} refused ${action}: ${reason}.`,
  });

interface Refused {
  readonly _tag: "Refuse";
  readonly reason: SpaceRefusal;
  readonly message?: string;
}

export type SpaceDecision =
  | Refused
  | { readonly _tag: "NoOp" }
  | {
      readonly _tag: "Accept";
      /** The whole space after the change, or null when it did not change. */
      readonly space: Space | null;
      readonly entries: ReadonlyArray<SpaceRoomEntry>;
      /** Set when a human post tagged `@pair`: the reply to queue. */
      readonly pairReply: { readonly postId: MessageId; readonly taggerId: MemberId } | null;
      /** Every task the command wrote, whole. */
      readonly tasks: ReadonlyArray<SpaceTask>;
      /** `@pair`'s record of what it did, in the same commit. */
      readonly actions: ReadonlyArray<SpaceAction>;
      /** Threads to take off their task and archive: the one `@pair`'s created-task Undo started. */
      readonly archiveThreadIds: ReadonlyArray<ThreadId>;
    };

const refuse = (reason: SpaceRefusal, message?: string): Refused =>
  message === undefined ? { _tag: "Refuse", reason } : { _tag: "Refuse", reason, message };
const NO_OP = { _tag: "NoOp" } as const;

const systemEntryId = (commandId: string, index = 0) =>
  MessageId.make(index === 0 ? `space-line:${commandId}` : `space-line:${commandId}:${index}`);

const systemEntry = (
  space: Pick<Space, "id">,
  actorId: MemberId,
  line: SpaceSystemLine,
  commandId: string,
  now: string,
  index = 0,
): SpaceRoomEntry => ({
  type: "system",
  id: systemEntryId(commandId, index),
  spaceId: space.id,
  actorId,
  line,
  createdAt: now,
});

const accept = (
  space: Space | null,
  entries: ReadonlyArray<SpaceRoomEntry>,
  more: {
    readonly pairReply?: { readonly postId: MessageId; readonly taggerId: MemberId } | null;
    readonly tasks?: ReadonlyArray<SpaceTask>;
    readonly actions?: ReadonlyArray<SpaceAction>;
    readonly archiveThreadIds?: ReadonlyArray<ThreadId>;
  } = {},
): SpaceDecision => ({
  _tag: "Accept",
  space,
  entries,
  pairReply: more.pairReply ?? null,
  tasks: more.tasks ?? [],
  actions: more.actions ?? [],
  archiveThreadIds: more.archiveThreadIds ?? [],
});

const uniqueIds = (ids: ReadonlyArray<MemberId>) => [...new Set(ids)];

/** Keeps the space's mentions the composer may send: active members, and `@pair` once. */
const normalizeMentions = (
  space: Space,
  mentions: ReadonlyArray<SpaceMention>,
): ReadonlyArray<SpaceMention> => {
  const seen = new Set<string>();
  const kept: Array<SpaceMention> = [];
  for (const mention of mentions) {
    const key = mention.type === "pair" ? "pair" : mention.memberId;
    if (seen.has(key)) continue;
    if (mention.type === "member" && !isSpaceActiveMember(space, mention.memberId)) continue;
    seen.add(key);
    kept.push(mention);
  }
  return kept;
};

export type SpaceThreadLinkCommand = Extract<
  OrchestrationV2SpaceCommand,
  { readonly type: "space.thread.link" }
>;

/** The Spaces core commands; `@pair`'s are decided in `SpaceAgentDecisions`, links below. */
export type SpaceCoreCommand = Exclude<
  OrchestrationV2SpaceCommand,
  SpaceAgentCommand | SpaceThreadLinkCommand
>;

type TaskCreateCommand = Extract<SpaceCoreCommand, { readonly type: "space.task.create" }>;
type TaskUpdateCommand = Extract<SpaceCoreCommand, { readonly type: "space.task.update" }>;

export interface SpaceCommandInput {
  readonly command: SpaceCoreCommand;
  readonly space: Space | null;
  /** The entry a `space.post` quotes, read by the caller. */
  readonly quoted?: SpaceRoomEntry | null;
  /** The task a `space.task.*` command names (null when there is none yet). */
  readonly task?: SpaceTask | null;
  /** `space.member.remove` / `space.leave`: the leaving member's tasks in this space. */
  readonly memberTasks?: ReadonlyArray<SpaceTask>;
  /** `space.task.create` via `@pair`: tasks it already created for this reply's post. */
  readonly othersThisReply?: number;
  /** `status` by an agent: whether that thread is on this task. */
  readonly agentThreadOnTask?: boolean;
  /** `status-undo`: the line it names, and `@pair`'s record of that move when it was Pair's. */
  readonly undoLine?: SpaceRoomEntry | null;
  readonly undoAction?: SpaceAction | null;
  /** `delete`: the threads on the task, and `@pair`'s record of creating it. */
  readonly taskThreadIds?: ReadonlyArray<ThreadId>;
  readonly createdAction?: SpaceAction | null;
  readonly now: string;
}

/** Pure: the "Who can do what" table in docs/product/spaces.md, decided against `space`. */
export function decideSpaceCommand(input: SpaceCommandInput): SpaceDecision {
  const { command, now } = input;
  const actor = command.actorId;
  if (command.type === "space.create") {
    if (input.space !== null) return refuse("already-exists");
    const members: Array<SpaceMember> = [
      { memberId: actor, joinedAt: now, addedBy: null, removedAt: null },
      ...uniqueIds(command.memberIds)
        .filter((memberId) => memberId !== actor)
        .map((memberId) => ({ memberId, joinedAt: now, addedBy: actor, removedAt: null })),
    ];
    const space: Space = {
      id: command.spaceId,
      roomThreadId: command.threadId,
      name: command.name,
      brief: command.brief,
      repositoryIds: command.repositoryIds,
      projectId: command.projectId,
      ownerId: actor,
      members,
      joinRequests: [],
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      archivedBy: null,
    };
    return accept(space, [systemEntry(space, actor, { type: "created" }, command.commandId, now)]);
  }

  const space = input.space;
  if (space === null || space.roomThreadId !== command.threadId) return refuse("not-found");
  const isOwner = space.ownerId === actor;
  const isMember = isSpaceActiveMember(space, actor);
  const changed = (patch: Partial<Space>): Space => ({ ...space, ...patch, updatedAt: now });
  const line = (value: SpaceSystemLine, index = 0) =>
    systemEntry(space, actor, value, command.commandId, now, index);

  switch (command.type) {
    case "space.update": {
      if (!isMember) return refuse("not-member");
      if (space.archivedAt !== null) return refuse("archived");
      if ((command.repositoryIds === undefined) !== (command.projectId === undefined)) {
        return refuse("not-allowed");
      }
      const repositoriesChanged =
        command.repositoryIds !== undefined &&
        command.projectId !== undefined &&
        (command.projectId !== space.projectId ||
          !sameIds(command.repositoryIds, space.repositoryIds));
      const renamed = command.name !== undefined && command.name !== space.name;
      if ((renamed || repositoriesChanged) && !isOwner) return refuse("not-owner");
      const lines: Array<SpaceSystemLine> = [];
      const patch: { -readonly [K in keyof Space]?: Space[K] } = {};
      if (renamed && command.name !== undefined) {
        patch.name = command.name;
        lines.push({ type: "renamed", name: command.name });
      }
      if (command.brief !== undefined && command.brief !== space.brief) {
        patch.brief = command.brief;
        lines.push({ type: "brief-edited" });
      }
      if (
        repositoriesChanged &&
        command.repositoryIds !== undefined &&
        command.projectId !== undefined
      ) {
        patch.repositoryIds = command.repositoryIds;
        patch.projectId = command.projectId;
        lines.push({
          type: "repositories-changed",
          repositoryIds: command.repositoryIds,
          projectId: command.projectId,
        });
      }
      if (lines.length === 0) return NO_OP;
      return accept(
        changed(patch),
        lines.map((value, index) => line(value, index)),
      );
    }
    case "space.archive":
      if (!isOwner) return refuse("not-owner");
      if (space.archivedAt !== null) return NO_OP;
      return accept(changed({ archivedAt: now, archivedBy: actor }), [line({ type: "archived" })]);
    case "space.unarchive":
      if (!isOwner) return refuse("not-owner");
      if (space.archivedAt === null) return NO_OP;
      return accept(changed({ archivedAt: null, archivedBy: null }), [
        line({ type: "unarchived" }),
      ]);
    case "space.member.add": {
      if (!isOwner) return refuse("not-owner");
      if (space.archivedAt !== null) return refuse("archived");
      const added: Array<MemberId> = [];
      const restored: Array<MemberId> = [];
      const members = [...space.members];
      for (const memberId of uniqueIds(command.memberIds)) {
        const index = members.findIndex((member) => member.memberId === memberId);
        const existing = index === -1 ? undefined : members[index];
        if (existing !== undefined && existing.removedAt === null) continue;
        if (existing !== undefined && command.restore === true) {
          members[index] = { ...existing, removedAt: null };
          restored.push(memberId);
        } else {
          const member = { memberId, joinedAt: now, addedBy: actor, removedAt: null };
          if (existing === undefined) members.push(member);
          else {
            members.splice(index, 1);
            members.push(member);
          }
          added.push(memberId);
        }
      }
      if (added.length === 0 && restored.length === 0) return NO_OP;
      const joining = new Set<MemberId>([...added, ...restored]);
      const lines: Array<SpaceSystemLine> = [
        ...(added.length === 0 ? [] : [{ type: "members-added" as const, memberIds: added }]),
        ...restored.map((memberId) => ({ type: "member-restored" as const, memberId })),
      ];
      return accept(
        changed({
          members,
          joinRequests: space.joinRequests.filter((request) => !joining.has(request.memberId)),
        }),
        lines.map((value, index) => line(value, index)),
      );
    }
    case "space.member.remove": {
      if (!isOwner) return refuse("not-owner");
      if (command.memberId === space.ownerId) return refuse("owner-cannot-leave");
      if (!isSpaceActiveMember(space, command.memberId)) return NO_OP;
      const handover = reassignTasks(space, command.memberId, command.reassignTo, input, actor);
      if (handover === null) return refuse("not-a-target-member");
      return accept(
        changed({ members: withRemoved(space.members, command.memberId, now) }),
        [
          line({
            type: "member-removed",
            memberId: command.memberId,
            reassignedTo: command.reassignTo ?? null,
            tasks: handover.length,
          }),
        ],
        { tasks: handover },
      );
    }
    case "space.owner.transfer":
      if (!isOwner) return refuse("not-owner");
      if (command.ownerId === space.ownerId) return NO_OP;
      if (!isSpaceActiveMember(space, command.ownerId)) return refuse("not-a-target-member");
      return accept(changed({ ownerId: command.ownerId }), [
        line({ type: "owner-transferred", ownerId: command.ownerId }),
      ]);
    case "space.leave": {
      if (!isMember) return NO_OP;
      if (isOwner) return refuse("owner-cannot-leave");
      const handover = reassignTasks(space, actor, command.reassignTo, input, actor);
      if (handover === null) return refuse("not-a-target-member");
      return accept(
        changed({ members: withRemoved(space.members, actor, now) }),
        [
          line({
            type: "left",
            reassignedTo: command.reassignTo ?? null,
            tasks: handover.length,
          }),
        ],
        { tasks: handover },
      );
    }
    case "space.join.request":
      if (isMember) return NO_OP;
      if (space.joinRequests.some((request) => request.memberId === actor)) {
        return refuse("already-requested");
      }
      return accept(
        changed({ joinRequests: [...space.joinRequests, { memberId: actor, requestedAt: now }] }),
        [],
      );
    case "space.join.cancel":
      if (!space.joinRequests.some((request) => request.memberId === actor)) {
        return refuse("no-request");
      }
      return accept(
        changed({
          joinRequests: space.joinRequests.filter((request) => request.memberId !== actor),
        }),
        [],
      );
    case "space.post": {
      if (!isMember) return refuse("not-member");
      if (space.archivedAt !== null) return refuse("archived");
      const quoted = command.quoteEntryId === undefined ? undefined : input.quoted;
      if (
        command.quoteEntryId !== undefined &&
        (quoted == null || quoted.type !== "post" || quoted.spaceId !== space.id)
      ) {
        return refuse("quote-not-found");
      }
      const mentions = normalizeMentions(space, command.mentions);
      const pairRequested =
        command.authorKind === "user" && mentions.some((mention) => mention.type === "pair");
      const post: SpaceRoomEntry = {
        type: "post",
        id: command.messageId,
        spaceId: space.id,
        authorId: actor,
        authorKind: command.authorKind,
        text: command.text,
        mentions,
        ...(quoted?.type === "post"
          ? {
              quote: {
                entryId: quoted.id,
                authorId: quoted.authorId,
                text: quoted.text.slice(0, SPACE_QUOTE_MAX_LENGTH),
              },
            }
          : {}),
        pairRequested,
        createdAt: now,
      };
      return accept(null, [post], {
        pairReply: pairRequested ? { postId: command.messageId, taggerId: actor } : null,
      });
    }
    case "space.task.create":
      return decideTaskCreate(command, space, input, now);
    case "space.task.update":
      return decideTaskUpdate(command, space, input, now);
  }
}

/** The leaver's open tasks, now `reassignTo`'s; null when `reassignTo` can't take them. */
function reassignTasks(
  space: Space,
  leaving: MemberId,
  reassignTo: MemberId | undefined,
  input: SpaceCommandInput,
  actor: MemberId,
): ReadonlyArray<SpaceTask> | null {
  if (reassignTo === undefined) return [];
  if (reassignTo === leaving || !isSpaceActiveMember(space, reassignTo)) return null;
  return (input.memberTasks ?? [])
    .filter(
      (task) =>
        task.spaceId === space.id &&
        task.ownerId === leaving &&
        task.deletedAt === null &&
        spaceTaskIsOpen(task.status),
    )
    .map((task) => ({
      ...task,
      ownerId: reassignTo,
      assignedBy: reassignTo === actor ? null : actor,
      handedBack: null,
      remindedAt: null,
      updatedAt: input.now,
    }));
}

function decideTaskCreate(
  command: TaskCreateCommand,
  space: Space,
  input: SpaceCommandInput,
  now: string,
): SpaceDecision {
  const actor = command.actorId;
  if (input.task != null) return refuse("already-exists");
  if (!isSpaceActiveMember(space, actor)) return refuse("not-member");
  if (space.archivedAt !== null) return refuse("archived");
  if (!isSpaceActiveMember(space, command.ownerId)) return refuse("not-a-target-member");
  const byPair = command.via !== undefined;
  if (byPair && command.spaceActionId === undefined) return refuse("not-allowed");
  if (byPair && (input.othersThisReply ?? 0) > 0) return refuse("over-limit");
  const task: SpaceTask = {
    id: command.taskId,
    spaceId: space.id,
    title: command.title,
    description: command.description,
    ownerId: command.ownerId,
    createdBy: actor,
    createdAt: now,
    assignedBy: command.ownerId === actor ? null : actor,
    status: command.status,
    statusVersion: 1,
    statusChangedAt: now,
    statusChangedBy: { type: "member", memberId: actor },
    handedBack: null,
    remindedAt: null,
    via: command.via ?? null,
    updatedAt: now,
    deletedAt: null,
  };
  const entry = (value: SpaceSystemLine, index: number) =>
    systemEntry(space, actor, value, command.commandId, now, index);
  const entries = [entry({ type: "task-created", taskId: task.id, ownerId: task.ownerId }, 0)];
  if (task.status !== "todo") {
    entries.push(
      entry(
        {
          type: "task-status",
          taskId: task.id,
          from: "todo",
          to: task.status,
          by: task.statusChangedBy,
          askedBy: null,
          version: 1,
          undoOf: null,
        },
        1,
      ),
    );
  }
  const actions: Array<SpaceAction> = [];
  if (command.via !== undefined && command.spaceActionId !== undefined) {
    actions.push({
      id: command.spaceActionId,
      spaceId: space.id,
      request: {
        type: "task.create",
        title: task.title,
        description: task.description,
        ownerId: task.ownerId,
        ...(task.ownerId === actor ? { start: true } : {}),
      },
      actorId: actor,
      via: command.via,
      state: "done",
      outcome: {
        type: "task.created",
        taskId: task.id,
        threadId: null,
        ownerId: task.ownerId,
        title: task.title,
        // `space.action.started` sets it once a thread is on the task.
        started: false,
      },
      proposal: null,
      undo: null,
      resolvedBy: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  return accept(null, entries, { tasks: [task], actions });
}

function decideTaskUpdate(
  command: TaskUpdateCommand,
  space: Space,
  input: SpaceCommandInput,
  now: string,
): SpaceDecision {
  const task = input.task;
  const actor = command.actorId;
  if (task == null || task.spaceId !== space.id || task.deletedAt !== null) {
    return refuse("not-a-task");
  }
  if (!isSpaceActiveMember(space, actor)) return refuse("not-member");
  if (space.archivedAt !== null) return refuse("archived");
  const write = (patch: Partial<SpaceTask>): SpaceTask => ({ ...task, ...patch, updatedAt: now });
  const entry = (value: SpaceSystemLine, actorId: MemberId = actor) =>
    systemEntry(space, actorId, value, command.commandId, now);
  const change: OrchestrationV2SpaceTaskChange = command.change;
  const mayEdit = actor === task.createdBy || actor === task.ownerId;
  switch (change.type) {
    case "edit": {
      if (!mayEdit) return refuse("not-task-creator");
      const title = change.title ?? task.title;
      const description = change.description ?? task.description;
      if (title === task.title && description === task.description) return NO_OP;
      return accept(null, [entry({ type: "task-edited", taskId: task.id })], {
        tasks: [write({ title, description })],
      });
    }
    case "reassign": {
      if (!mayEdit) return refuse("not-task-creator");
      if (!isSpaceActiveMember(space, change.ownerId)) return refuse("not-a-target-member");
      if (change.ownerId === task.ownerId) return NO_OP;
      return accept(
        null,
        [entry({ type: "task-assigned", taskId: task.id, from: task.ownerId, to: change.ownerId })],
        {
          tasks: [
            write({
              ownerId: change.ownerId,
              assignedBy: change.ownerId === actor ? null : actor,
              handedBack: null,
              remindedAt: null,
            }),
          ],
        },
      );
    }
    case "hand-back": {
      if (actor !== task.ownerId) return refuse("not-task-owner");
      if (task.assignedBy === null || task.assignedBy === actor) return refuse("own-task");
      return accept(
        null,
        [entry({ type: "task-handed-back", taskId: task.id, reason: change.reason })],
        {
          tasks: [
            write({
              ownerId: task.assignedBy,
              assignedBy: null,
              handedBack: { by: actor, reason: change.reason, at: now },
              remindedAt: null,
            }),
          ],
        },
      );
    }
    case "remind":
      if (actor !== (task.assignedBy ?? task.createdBy)) return refuse("not-task-creator");
      if (actor === task.ownerId) return refuse("own-task");
      return accept(null, [], { tasks: [write({ remindedAt: now })] });
    case "status": {
      if (change.by.type === "agent" && input.agentThreadOnTask !== true) {
        return refuse("not-a-task");
      }
      const byPair = change.by.type === "pair";
      if (
        byPair !== (command.via !== undefined) ||
        (byPair && command.spaceActionId === undefined)
      ) {
        return refuse("not-allowed");
      }
      if (change.status === task.status) return NO_OP;
      const version = task.statusVersion + 1;
      const line = entry(
        {
          type: "task-status",
          taskId: task.id,
          from: task.status,
          to: change.status,
          by: change.by,
          askedBy: change.askedBy,
          version,
          undoOf: null,
        },
        change.askedBy ?? actor,
      );
      const moved = write({
        status: change.status,
        statusVersion: version,
        statusChangedAt: now,
        statusChangedBy: change.by,
      });
      const actions: Array<SpaceAction> = [];
      if (command.via !== undefined && command.spaceActionId !== undefined) {
        actions.push({
          id: command.spaceActionId,
          spaceId: space.id,
          request: { type: "task.status", taskId: task.id, status: change.status },
          actorId: actor,
          via: command.via,
          state: "done",
          outcome: {
            type: "task.status.moved",
            taskId: task.id,
            title: task.title,
            from: task.status,
            to: change.status,
            entryId: line.id,
          },
          proposal: null,
          undo: null,
          resolvedBy: null,
          createdAt: now,
          updatedAt: now,
        });
      }
      return accept(null, [line], { tasks: [moved], actions });
    }
    case "status-undo": {
      const undone = input.undoLine;
      const moved =
        undone?.type === "system" &&
        undone.spaceId === space.id &&
        undone.line.type === "task-status" &&
        undone.line.taskId === task.id
          ? undone.line
          : null;
      // An Undo bumps the version too, so a line undone once never matches again.
      if (
        moved === null ||
        moved.by.type === "member" ||
        moved.undoOf !== null ||
        moved.version !== task.statusVersion
      ) {
        return refuse("not-undoable", "Status changed since");
      }
      const version = task.statusVersion + 1;
      const by = { type: "member" as const, memberId: actor };
      const action = input.undoAction;
      return accept(
        null,
        [
          entry({
            type: "task-status",
            taskId: task.id,
            from: task.status,
            to: moved.from,
            by,
            askedBy: null,
            version,
            undoOf: change.entryId,
          }),
        ],
        {
          tasks: [
            write({
              status: moved.from,
              statusVersion: version,
              statusChangedAt: now,
              statusChangedBy: by,
            }),
          ],
          actions:
            moved.by.type === "pair" && action != null && action.state === "done"
              ? [
                  {
                    ...action,
                    state: "undone",
                    undo: { by: actor, at: now, notUndone: [] },
                    updatedAt: now,
                  },
                ]
              : [],
        },
      );
    }
    case "delete": {
      const created = input.createdAction;
      const started =
        created?.outcome?.type === "task.created" && created.outcome.taskId === task.id
          ? created.outcome.threadId
          : null;
      const threads = input.taskThreadIds ?? [];
      if (
        task.via === null ||
        task.statusVersion !== 1 ||
        task.updatedAt !== task.createdAt ||
        threads.some((threadId) => threadId !== started)
      ) {
        return refuse("not-undoable");
      }
      return accept(null, [], {
        tasks: [write({ deletedAt: now })],
        archiveThreadIds: threads,
      });
    }
  }
}

export type SpaceThreadLinkDecision =
  | Refused
  | { readonly _tag: "NoOp" }
  | {
      readonly _tag: "Accept";
      /** The thread's new `space`, or null to remove the key. */
      readonly link: ThreadSpaceTask | null;
      /** Each line with the room whose stream it goes on. */
      readonly entries: ReadonlyArray<{
        readonly roomThreadId: ThreadId;
        readonly entry: SpaceRoomEntry;
      }>;
    };

export interface SpaceThreadLinkInput {
  readonly command: SpaceThreadLinkCommand;
  readonly thread: OrchestrationV2AppThread | null;
  /** The task the thread is on now, with its space; null when it is on none. */
  readonly current: { readonly space: Space | null; readonly task: SpaceTask | null } | null;
  readonly target: { readonly space: Space | null; readonly task: SpaceTask | null } | null;
  readonly now: string;
}

/**
 * Attach, move and remove are one rewrite of a thread's `space`. Only the thread's owner attaches
 * or moves; removing is also the task's or the space's owner's, and the thread owner's even on an
 * archived space, so the way out of sharing always exists.
 */
export function decideThreadLink(input: SpaceThreadLinkInput): SpaceThreadLinkDecision {
  const { command, thread, current, target, now } = input;
  const actor = command.actorId;
  if (thread === null || thread.deletedAt !== null || thread.space?.kind === "room") {
    return refuse("not-linkable");
  }
  const isThreadOwner = thread.ownerId === actor;
  const placement = thread.space?.kind === "task" ? thread.space : null;
  if (command.target === null) {
    if (placement === null) return NO_OP;
    const currentSpace = current?.space ?? null;
    const isTaskOwner = current?.task?.ownerId === actor;
    const isSpaceOwner = currentSpace?.ownerId === actor;
    if (!isThreadOwner && !isTaskOwner && !isSpaceOwner) return refuse("not-thread-owner");
    if (!isThreadOwner && currentSpace?.archivedAt != null) return refuse("archived");
    return {
      _tag: "Accept",
      link: null,
      entries: removedLine(input, placement, actor),
    };
  }
  if (!isThreadOwner) return refuse("not-thread-owner");
  if (thread.archivedAt !== null || !isListedThreadLineage(thread.lineage)) {
    return refuse("not-linkable");
  }
  const space = target?.space ?? null;
  const task = target?.task ?? null;
  if (space === null || space.id !== command.target.spaceId) return refuse("not-found");
  if (!isSpaceActiveMember(space, actor)) return refuse("not-member");
  if (task === null || task.spaceId !== space.id || task.deletedAt !== null) {
    return refuse("not-a-task");
  }
  if (space.archivedAt !== null) return refuse("archived");
  if (placement?.taskId === task.id) return NO_OP;
  const added = systemEntry(
    space,
    actor,
    {
      type: "task-thread-added",
      taskId: task.id,
      threadId: thread.id,
      threadOwnerId: actor,
      via: placement === null ? command.via : "move",
    },
    command.commandId,
    now,
    1,
  );
  return {
    _tag: "Accept",
    link: {
      kind: "task",
      spaceId: space.id,
      taskId: task.id,
      linkedBy: actor,
      linkedAt: now,
      via: command.via,
    },
    entries: [
      ...(placement === null ? [] : removedLine(input, placement, actor)),
      { roomThreadId: space.roomThreadId, entry: added },
    ],
  };
}

const removedLine = (input: SpaceThreadLinkInput, placement: ThreadSpaceTask, actor: MemberId) => {
  const space = input.current?.space ?? null;
  const owner = input.thread?.ownerId ?? actor;
  if (space === null) return [];
  return [
    {
      roomThreadId: space.roomThreadId,
      entry: systemEntry(
        space,
        actor,
        {
          type: "task-thread-removed",
          taskId: placement.taskId,
          threadId: input.command.threadId,
          threadOwnerId: owner,
        },
        input.command.commandId,
        input.now,
      ),
    },
  ];
};

const withRemoved = (
  members: ReadonlyArray<SpaceMember>,
  memberId: MemberId,
  now: string,
): ReadonlyArray<SpaceMember> =>
  members.map((member) =>
    member.memberId === memberId && member.removedAt === null
      ? { ...member, removedAt: now }
      : member,
  );

const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((id, index) => id === right[index]);
