import {
  CommandId,
  MemberId,
  TeamError,
  type TeamMember,
  type TeamRemovalPreview,
  type TeamRemovalPreviewInput,
  type TeamRemoveInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SandboxProjection from "../sandbox/lifecycle/SandboxProjection.ts";
import * as TeamMembers from "./TeamMembers.ts";
import * as TeamState from "./TeamState.ts";

export class TeamRemoval extends Context.Service<
  TeamRemoval,
  {
    /** How many cloud threads the member owns, counted here because an admin cannot list them. */
    readonly preview: (input: TeamRemovalPreviewInput) => Effect.Effect<TeamRemovalPreview>;
    /**
     * Removes a member. On a cloud-only server it first gives every cloud thread they own to
     * another member or deletes them with their machines, without the admin opening any of them,
     * and drops the member from every machine's list. A member who owns cloud threads cannot be
     * removed without saying which.
     */
    readonly remove: (
      input: TeamRemoveInput,
      actorId: MemberId,
    ) => Effect.Effect<TeamMember, TeamError>;
  }
>()("t3/team/TeamRemoval") {}

interface OwnedThread {
  readonly threadId: ThreadId;
  readonly sideChat: boolean;
}

const handoverFailed = (cause: unknown) =>
  Effect.logError("Could not hand over a removed member's cloud threads.", { cause }).pipe(
    Effect.andThen(
      Effect.fail(
        new TeamError({
          reason: "internal",
          message: "Could not hand over their cloud threads. Nobody was removed; try again.",
        }),
      ),
    ),
  );

const make = Effect.gen(function* () {
  const teamMembers = yield* TeamMembers.TeamMembers;
  const teamState = yield* TeamState.TeamState;
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const { cloudOnly } = yield* ServerConfig.ServerConfig;
  const liveSandboxes = SandboxProjection.listLiveSandboxes().pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
  );

  /** Subagent threads follow their parent and are not what a person calls a thread. */
  const ownedCloudThreads = Effect.fn("TeamRemoval.ownedCloudThreads")(function* (
    memberId: MemberId,
  ) {
    if (!cloudOnly) return [] as ReadonlyArray<OwnedThread>;
    const rows = yield* sql<{ readonly thread_id: ThreadId; readonly side_chat: number }>`
      SELECT thread_id,
        coalesce(json_extract(payload_json, '$.lineage.sideChat'), 0) AS side_chat
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
        AND json_extract(payload_json, '$.ownerId') = ${memberId}
        AND json_extract(payload_json, '$.sandboxId') IS NOT NULL
        AND coalesce(json_extract(payload_json, '$.lineage.relationshipToParent'), '') <> 'subagent'
      ORDER BY created_at ASC, thread_id ASC
    `;
    return rows.map((row) => ({ threadId: row.thread_id, sideChat: row.side_chat === 1 }));
  });

  const isDeleted = (threadId: ThreadId) =>
    sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE thread_id = ${threadId} AND deleted_at IS NULL
    `.pipe(Effect.map((rows) => rows.length === 0));

  const preview: TeamRemoval["Service"]["preview"] = Effect.fn("TeamRemoval.preview")(
    function* (input) {
      const owned = yield* ownedCloudThreads(input.memberId).pipe(Effect.orDie);
      return { cloudThreadCount: owned.length };
    },
  );

  const commandId = (...parts: ReadonlyArray<string>) => CommandId.make(parts.join(":"));

  /** Ids are fixed per removal, so a retry after a failure replays what already happened. */
  const handOver = Effect.fn("TeamRemoval.handOver")(function* (
    memberId: MemberId,
    actorId: MemberId,
    handover: NonNullable<TeamRemoveInput["cloudThreads"]>,
    owned: ReadonlyArray<OwnedThread>,
  ) {
    const tag = `team-remove:${memberId}`;
    if (handover.type === "give") {
      for (const { threadId } of owned) {
        yield* threads.dispatch({
          type: "thread.owner.set",
          commandId: commandId(tag, "give", threadId),
          threadId,
          ownerId: handover.toMemberId,
          actorId,
        });
      }
      return;
    }
    // Side chats first: deleting a thread deletes its side chats too.
    for (const { threadId } of owned.toSorted((a, b) => Number(b.sideChat) - Number(a.sideChat))) {
      if (yield* isDeleted(threadId)) continue;
      yield* threads.dispatch({
        type: "thread.delete",
        commandId: commandId(tag, "delete", threadId),
        threadId,
        actorId,
      });
    }
    // Deleting the last thread destroys a machine; one another member's side chat still uses is
    // handed over instead, and it holds the removed member's sign-ins.
    for (const record of yield* liveSandboxes) {
      if (record.ownerMemberId !== memberId) continue;
      yield* threads
        .dispatch({
          type: "sandbox.discard",
          commandId: commandId(tag, "discard", record.id),
          threadId: record.ownerThreadId,
          sandboxId: record.id,
          actorId,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not discard a removed member's machine.", {
              sandboxId: record.id,
              cause,
            }),
          ),
        );
    }
  });

  /** A re-added member must not silently regain old shares, and an inactive one fails the rule anyway. */
  const forgetInLists = Effect.fn("TeamRemoval.forgetInLists")(function* (memberId: MemberId) {
    const tag = `team-remove:${memberId}`;
    for (const record of yield* liveSandboxes) {
      const { access, ownerMemberId } = record;
      if (access === undefined || ownerMemberId === null || !access.memberIds.includes(memberId)) {
        continue;
      }
      yield* threads.dispatch({
        type: "sandbox.access.set",
        commandId: commandId(tag, "forget", record.id),
        threadId: record.ownerThreadId,
        sandboxId: record.id,
        // The decider takes the machine's owner as the one setting its list.
        actorId: ownerMemberId,
        audience: access.audience,
        memberIds: access.memberIds.filter((id) => id !== memberId),
      });
    }
  });

  const remove: TeamRemoval["Service"]["remove"] = Effect.fn("TeamRemoval.remove")(
    function* (input, actorId) {
      if (!cloudOnly) return yield* teamMembers.remove({ memberId: input.memberId });
      const members = yield* Ref.get(teamState.members);
      const member = members.get(input.memberId);
      if (member === undefined) {
        return yield* new TeamError({
          reason: "not-found",
          message: "That member does not exist.",
        });
      }
      // Refused before anything moves, so a removal that cannot happen hands nothing over.
      if (member.isOwner) {
        return yield* teamMembers.remove({ memberId: input.memberId });
      }
      if (member.removedAt !== null) {
        return yield* new TeamError({ reason: "removed", message: "That member was removed." });
      }
      const owned = yield* ownedCloudThreads(input.memberId).pipe(Effect.orDie);
      const { cloudThreads: handover } = input;
      if (owned.length > 0) {
        if (handover === undefined) {
          return yield* new TeamError({
            reason: "owns-cloud-threads",
            message: `${member.name} owns ${owned.length} cloud ${owned.length === 1 ? "thread" : "threads"}. Give them to a member or delete them.`,
          });
        }
        if (handover.type === "give") {
          const target = members.get(handover.toMemberId);
          if (target === undefined || target.removedAt !== null || target.id === member.id) {
            return yield* new TeamError({
              reason: "not-found",
              message: "Choose an active member to give the threads to.",
            });
          }
        }
        yield* handOver(member.id, actorId, handover, owned).pipe(Effect.catch(handoverFailed));
      }
      yield* forgetInLists(member.id).pipe(Effect.catch(handoverFailed));
      return yield* teamMembers.remove({ memberId: input.memberId });
    },
  );

  return TeamRemoval.of({ preview, remove });
});

export const layer = Layer.effect(TeamRemoval, make);
