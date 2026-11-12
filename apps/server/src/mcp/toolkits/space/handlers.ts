import { MessageId, OrchestratorMcpFailure, type Space, type SpaceError } from "@t3tools/contracts";
import { spaceTaskState } from "@t3tools/shared/spaceTaskState";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";

import * as SpaceService from "../../../space/SpaceService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { SpaceToolkit } from "./tools.ts";

const RECENT_ENTRIES = 30;

const failure = (error: SpaceError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "failed" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

/** The member an agent acts for: its thread's owner, or the member who connected the client. */
const spaceCaller = Effect.gen(function* () {
  const { scope, caller } = yield* readCaller();
  const memberId = caller?.ownerId ?? scope.client?.memberId;
  if (memberId === undefined || memberId === null) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Spaces need a member; this credential has none.",
    });
  }
  return {
    caller: { memberId, authorKind: "agent" as const },
    spaces: yield* SpaceService.SpaceService,
  };
});

const summaryOf = (space: Space) => ({
  spaceId: space.id,
  name: space.name,
  archived: space.archivedAt !== null,
});

const statusOf = (state: ReturnType<typeof spaceTaskState>) =>
  state.type === "needs" ? `needs-${state.reason}` : state.type;

export const layer = McpToolAccess.toLayer(SpaceToolkit, {
  t3_space_read: McpToolAccess.reads(({ spaceId }) =>
    Effect.gen(function* () {
      const { caller, spaces } = yield* spaceCaller;
      if (spaceId === undefined) {
        const { spaces: list } = yield* spaces.list(caller).pipe(Effect.mapError(failure));
        return { spaces: list.map(summaryOf) };
      }
      const view = yield* spaces
        .get(caller, { spaceId, limit: RECENT_ENTRIES })
        .pipe(Effect.mapError(failure));
      if (view.type === "not_member") {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: `You are not a member of ${view.name}.`,
        });
      }
      const { space } = view;
      return {
        space: {
          spaceId: space.id,
          name: space.name,
          brief: space.brief,
          ownerId: space.ownerId,
          memberIds: space.members.filter((m) => m.removedAt === null).map((m) => m.memberId),
          archived: space.archivedAt !== null,
        },
        entries: view.entries,
        tasks: view.tasks.map((task) => ({
          threadId: task.id,
          title: task.title,
          ownerId: task.ownerId ?? null,
          status: statusOf(spaceTaskState(task)),
        })),
      };
    }),
  ),
  t3_space_post: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const { caller, spaces } = yield* spaceCaller;
      const random = yield* SecureRandom.SecureRandom;
      const messageId = MessageId.make(`space-post:${yield* random.uuidV4()}`);
      const { entry } = yield* spaces
        .post(caller, {
          spaceId: input.spaceId,
          messageId,
          text: input.text,
          mentions: input.mentions ?? [],
          ...(input.quoteEntryId === undefined ? {} : { quoteEntryId: input.quoteEntryId }),
        })
        .pipe(Effect.mapError(failure));
      return { entryId: entry.id };
    }),
  ),
  t3_space_task_create: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const { caller, spaces } = yield* spaceCaller;
      const { threadId, started } = yield* spaces
        .task(caller, { type: "create", ...input })
        .pipe(Effect.mapError(failure));
      return { threadId, started };
    }),
  ),
  t3_space_manage: McpToolAccess.writesWithCapability(({ action }) =>
    Effect.gen(function* () {
      const { caller, spaces } = yield* spaceCaller;
      const { space } = yield* spaces.mutate(caller, action).pipe(Effect.mapError(failure));
      return { space: space === null ? null : summaryOf(space) };
    }),
  ),
});
