import {
  isSpaceActiveMember,
  type MemberId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2SpaceCommand,
  type ProjectId,
  type Space,
  SPACE_QUOTE_MAX_LENGTH,
  type SpaceMention,
  type SpaceMember,
  type SpaceRoomEntry,
  type SpaceSystemLine,
  type ThreadId,
  SpaceError,
  type SpaceId,
  type ThreadSpace,
  type ThreadSpaceTask,
} from "@t3tools/contracts";

/** Why a space command is refused; the client sees it as a `SpaceError`. */
export type SpaceRefusal = Exclude<SpaceError["reason"], "failed">;

/** The cause an `OrchestratorDispatchError` carries, which `SpaceService` hands to the client. */
export const spaceRefusal = (spaceId: SpaceId, action: string, reason: SpaceRefusal) =>
  new SpaceError({ reason, message: `Space ${spaceId} refused ${action}: ${reason}.` });

export type SpaceDecision =
  | { readonly _tag: "Refuse"; readonly reason: SpaceRefusal }
  | { readonly _tag: "NoOp" }
  | {
      readonly _tag: "Accept";
      /** The whole space after the change, or null when it did not change. */
      readonly space: Space | null;
      readonly entries: ReadonlyArray<SpaceRoomEntry>;
      /** Set when a human post tagged `@pair`: the reply to queue. */
      readonly pairReply: { readonly postId: MessageId; readonly taggerId: MemberId } | null;
    };

const refuse = (reason: SpaceRefusal): SpaceDecision => ({ _tag: "Refuse", reason });
const NO_OP: SpaceDecision = { _tag: "NoOp" };

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
  pairReply: { readonly postId: MessageId; readonly taggerId: MemberId } | null = null,
): SpaceDecision => ({ _tag: "Accept", space, entries, pairReply });

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

export interface SpaceCommandInput {
  readonly command: OrchestrationV2SpaceCommand;
  readonly space: Space | null;
  /** The entry a `space.post` quotes, read by the caller. */
  readonly quoted?: SpaceRoomEntry | null;
  /** The task thread a `space.task.update` targets, and whether any run has been requested. */
  readonly task?: {
    readonly thread: OrchestrationV2AppThread;
    readonly started: boolean;
  } | null;
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
      projectId: command.projectId,
      ownerId: actor,
      members,
      joinRequests: [],
      pairBilling: command.pairBilling,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      archivedBy: null,
    };
    return accept(space, [systemEntry(space, actor, { type: "created" }, command.commandId, now)]);
  }

  const space = input.space;
  if (space === null || space.roomThreadId !== roomThreadOf(command, input)) {
    return refuse("not-found");
  }
  const isOwner = space.ownerId === actor;
  const isMember = isSpaceActiveMember(space, actor);
  const changed = (patch: Partial<Space>): Space => ({ ...space, ...patch, updatedAt: now });
  const line = (value: SpaceSystemLine, index = 0) =>
    systemEntry(space, actor, value, command.commandId, now, index);

  switch (command.type) {
    case "space.update": {
      if (!isMember) return refuse("not-member");
      if (space.archivedAt !== null) return refuse("archived");
      const ownerOnly =
        (command.name !== undefined && command.name !== space.name) ||
        (command.projectId !== undefined && command.projectId !== space.projectId) ||
        (command.pairBilling !== undefined &&
          !samePairBilling(command.pairBilling, space.pairBilling));
      if (ownerOnly && !isOwner) return refuse("not-owner");
      const lines: Array<SpaceSystemLine> = [];
      const patch: { -readonly [K in keyof Space]?: Space[K] } = {};
      if (command.name !== undefined && command.name !== space.name) {
        patch.name = command.name;
        lines.push({ type: "renamed", name: command.name });
      }
      if (command.brief !== undefined && command.brief !== space.brief) {
        patch.brief = command.brief;
        lines.push({ type: "brief-edited" });
      }
      if (command.projectId !== undefined && command.projectId !== space.projectId) {
        patch.projectId = command.projectId as ProjectId;
        lines.push({ type: "project-changed", projectId: command.projectId });
      }
      if (
        command.pairBilling !== undefined &&
        !samePairBilling(command.pairBilling, space.pairBilling)
      ) {
        patch.pairBilling = command.pairBilling;
        lines.push({ type: "billing-changed", pairBilling: command.pairBilling });
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
      return accept(changed({ members: withRemoved(space.members, command.memberId, now) }), [
        line({ type: "member-removed", memberId: command.memberId }),
      ]);
    }
    case "space.owner.transfer":
      if (!isOwner) return refuse("not-owner");
      if (command.ownerId === space.ownerId) return NO_OP;
      if (!isSpaceActiveMember(space, command.ownerId)) return refuse("not-a-target-member");
      return accept(changed({ ownerId: command.ownerId }), [
        line({ type: "owner-transferred", ownerId: command.ownerId }),
      ]);
    case "space.leave":
      if (!isMember) return NO_OP;
      if (isOwner) return refuse("owner-cannot-leave");
      return accept(changed({ members: withRemoved(space.members, actor, now) }), [
        line({ type: "left" }),
      ]);
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
      return accept(
        null,
        [post],
        pairRequested ? { postId: command.messageId, taggerId: actor } : null,
      );
    }
    case "space.task.update":
      return decideTaskUpdate(command, space, input, now);
  }
}

function decideTaskUpdate(
  command: Extract<OrchestrationV2SpaceCommand, { readonly type: "space.task.update" }>,
  space: Space,
  input: SpaceCommandInput,
  now: string,
): SpaceDecision {
  const task = input.task;
  const placement = task?.thread.space;
  if (task == null || placement?.kind !== "task" || placement.spaceId !== space.id) {
    return refuse("not-a-task");
  }
  if (!isSpaceActiveMember(space, command.actorId)) return refuse("not-member");
  if (space.archivedAt !== null) return refuse("archived");
  if (task.started) return refuse("task-started");
  switch (command.change.type) {
    case "edit":
    case "remind":
      return placement.createdBy === command.actorId
        ? accept(null, [])
        : refuse("not-task-creator");
    case "hand-back":
      if (task.thread.ownerId !== command.actorId) return refuse("not-task-owner");
      if (placement.createdBy === command.actorId) return refuse("own-task");
      return accept(null, [
        systemEntry(
          space,
          command.actorId,
          { type: "task-handed-back", threadId: task.thread.id, reason: command.change.reason },
          command.commandId,
          now,
        ),
      ]);
  }
}

/** The task's placement after an accepted `space.task.update`. */
export function nextTaskPlacement(
  placement: ThreadSpaceTask,
  change: Extract<OrchestrationV2SpaceCommand, { readonly type: "space.task.update" }>["change"],
  actorId: MemberId,
  now: string,
): ThreadSpaceTask {
  switch (change.type) {
    case "edit":
      return {
        ...placement,
        ...(change.description === undefined ? {} : { description: change.description }),
        ...(change.base === undefined ? {} : { base: change.base }),
      };
    case "remind":
      return { ...placement, remindedAt: now };
    case "hand-back":
      return { ...placement, handedBack: { by: actorId, reason: change.reason, at: now } };
  }
}

/** A new task: its creator must be a member of a live space, and so must its owner. */
export function decideTaskCreate(input: {
  readonly space: Space | null;
  readonly placement: ThreadSpace;
  readonly threadId: ThreadId;
  readonly ownerId: MemberId;
  readonly commandId: string;
  readonly now: string;
}): SpaceDecision {
  const { space, placement } = input;
  if (placement.kind !== "task") return refuse("not-a-task");
  if (space === null || space.id !== placement.spaceId) return refuse("not-found");
  if (!isSpaceActiveMember(space, placement.createdBy)) return refuse("not-member");
  if (space.archivedAt !== null) return refuse("archived");
  if (!isSpaceActiveMember(space, input.ownerId)) return refuse("not-a-target-member");
  return accept(null, [
    systemEntry(
      space,
      placement.createdBy,
      { type: "task-created", threadId: input.threadId, ownerId: input.ownerId },
      input.commandId,
      input.now,
    ),
  ]);
}

const roomThreadOf = (command: OrchestrationV2SpaceCommand, input: SpaceCommandInput) =>
  command.type === "space.task.update" ? (input.space?.roomThreadId ?? null) : command.threadId;

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

const samePairBilling = (left: Space["pairBilling"], right: Space["pairBilling"]) =>
  left.type === right.type &&
  (left.type === "team" || (right.type === "member" && left.memberId === right.memberId));
