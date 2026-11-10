import {
  type MemberId,
  type OrchestrationV2ConversationMessage,
  TeamImageError,
  type TeamImageRequester,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as TeamState from "../../team/TeamState.ts";

const notAdmin = (message: string) => new TeamImageError({ reason: "not-admin", message });

// An agent can always file a proposal, which an admin reviews.
const ASK_OR_PROPOSE = "Ask an admin to make the change, or propose it with t3_team_image_propose.";

/** A person typed it: not a guest, a schedule, a notification, another thread or a delegated task. */
const writtenByMember = (message: OrchestrationV2ConversationMessage) =>
  message.createdBy === "user" &&
  message.authorId !== undefined &&
  message.context?.guest === undefined &&
  message.notification === undefined &&
  message.scheduledTaskId === undefined &&
  message.senderThreadId === undefined &&
  message.delegatedCompletion === undefined;

/**
 * Who an MCP caller may change the team image as (05 §7). A turn speaks for everyone who wrote
 * it, so every author must be an active admin; a client speaks for the member who connected it.
 * Checked at each call, so a member's steer mid-run takes the authority away.
 */
export class TeamImageAuthority extends Context.Service<
  TeamImageAuthority,
  {
    readonly forCaller: (
      scope: McpInvocationScope,
    ) => Effect.Effect<TeamImageRequester, TeamImageError>;
  }
>()("t3/sandbox/image/TeamImageAuthority") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const teamState = yield* TeamState.TeamState;

  const firstNonAdmin = Effect.fnUntraced(function* (memberIds: ReadonlyArray<MemberId>) {
    if (!(yield* teamState.isTeamMode)) return undefined;
    const members = yield* Ref.get(teamState.members);
    const memberId = memberIds.find((id) => {
      const member = members.get(id);
      return member?.role !== "admin" || member.removedAt !== null;
    });
    return memberId === undefined ? undefined : (members.get(memberId)?.name ?? "A former member");
  });

  const forCaller = Effect.fn("TeamImageAuthority.forCaller")(function* (
    scope: McpInvocationScope,
  ) {
    if (scope.thread !== undefined) {
      const { threadId } = scope.thread;
      const thread = yield* projections.getThreadShell(threadId).pipe(Effect.orDie);
      const runId = thread?.activeRunId ?? null;
      if (runId === null) return yield* notAdmin("Only a running turn can change the team image.");
      const messages = yield* projections.listRunUserMessages(threadId, runId).pipe(Effect.orDie);
      if (messages.some((message) => message.context?.guest !== undefined)) {
        return yield* notAdmin(
          `A guest wrote part of this turn, so it cannot change the team image. ${ASK_OR_PROPOSE}`,
        );
      }
      if (messages.length === 0 || !messages.every(writtenByMember)) {
        return yield* notAdmin(
          `No admin wrote all of this turn, so it cannot change the team image. ${ASK_OR_PROPOSE}`,
        );
      }
      const authorIds = [...new Set(messages.flatMap(({ authorId }) => authorId ?? []))];
      const name = yield* firstNonAdmin(authorIds);
      if (name !== undefined) {
        return yield* notAdmin(
          `${name} is not an admin, so this turn cannot change the team image. ${ASK_OR_PROPOSE}`,
        );
      }
      return { kind: "agent", threadId, runId, authorIds } satisfies TeamImageRequester;
    }
    const client = scope.client;
    if (client === undefined || client.access === "read-only") {
      return yield* notAdmin("This connection cannot change the team image.");
    }
    const memberId =
      client.memberId ?? ((yield* teamState.isTeamMode) ? undefined : teamState.ownerId);
    if (memberId === undefined) {
      return yield* notAdmin(
        "This connection belongs to no member, so it cannot change the team image.",
      );
    }
    const name = yield* firstNonAdmin([memberId]);
    if (name !== undefined) {
      return yield* notAdmin(
        `${name} is not an admin, so this connection cannot change the team image.`,
      );
    }
    return { kind: "member", memberId } satisfies TeamImageRequester;
  });

  return TeamImageAuthority.of({ forCaller });
});

export const layer = Layer.effect(TeamImageAuthority, make);
