import {
  MessageId,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  type Space,
  type SpaceError,
} from "@t3tools/contracts";
import { spaceThreadActivity } from "@t3tools/shared/spaceThreadActivity";
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
  const loaded = yield* readCaller();
  const memberId = loaded.caller?.ownerId ?? loaded.scope.client?.memberId;
  if (memberId === undefined || memberId === null) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Spaces need a member; this credential has none.",
    });
  }
  return {
    caller: { memberId, authorKind: "agent" as const },
    thread: loaded.caller,
    threads: loaded.threads,
    spaces: yield* SpaceService.SpaceService,
  };
});

const summaryOf = (space: Space) => ({
  spaceId: space.id,
  name: space.name,
  archived: space.archivedAt !== null,
});

const activityOf = (shell: OrchestrationV2ThreadShell) => {
  const activity = spaceThreadActivity(shell);
  return activity.type === "needs" ? `needs-${activity.reason}` : activity.type;
};

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
          taskId: task.id,
          title: task.title,
          ownerId: task.ownerId,
          status: task.status,
          threads: view.threads.flatMap((shell) =>
            shell.space?.kind === "task" && shell.space.taskId === task.id
              ? [
                  {
                    threadId: shell.id,
                    title: shell.title,
                    ownerId: shell.ownerId ?? null,
                    activity: activityOf(shell),
                  },
                ]
              : [],
          ),
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
      const { task } = yield* spaces
        .createTask(caller, {
          type: "create",
          spaceId: input.spaceId,
          title: input.title,
          description: input.description,
          ownerId: input.ownerId ?? caller.memberId,
          ...(input.status === undefined ? {} : { status: input.status }),
        })
        .pipe(Effect.mapError(failure));
      if (task === null) {
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "The task was not recorded.",
        });
      }
      return { taskId: task.id };
    }),
  ),
  t3_space_thread_start: McpToolAccess.startsThreads(
    () => ({}),
    (input, modes) =>
      Effect.gen(function* () {
        const { caller, thread, spaces } = yield* spaceCaller;
        if (thread === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Start a thread on a task from a thread, whose model it uses, or in the app.",
          });
        }
        // Open tasks of the caller's spaces: also the membership check.
        const listed = yield* spaces.list(caller).pipe(Effect.mapError(failure));
        const task = listed.tasks.find((candidate) => candidate.id === input.taskId);
        const space = listed.spaces.find((candidate) => candidate.id === task?.spaceId);
        if (task === undefined || space === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `No open task ${input.taskId} in your spaces.`,
          });
        }
        const started = yield* spaces
          .startThread(caller, {
            type: "start",
            spaceId: space.id,
            taskId: task.id,
            projectId: space.projectId,
            modelSelection: thread.modelSelection,
            base: {},
            runtimeMode: modes.runtimeMode,
            interactionMode: modes.interactionMode,
            ...(input.prompt === undefined ? {} : { text: input.prompt }),
          })
          .pipe(Effect.mapError(failure));
        if (started.threadId === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "The thread did not start.",
          });
        }
        return { threadId: started.threadId };
      }),
    { refused: "start a thread on a space task" },
  ),
  t3_space_task_status: McpToolAccess.writes(({ status }) =>
    Effect.gen(function* () {
      const { caller, thread, threads, spaces } = yield* spaceCaller;
      if (thread?.space?.kind !== "task") {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "This thread isn't on a space task.",
        });
      }
      const { spaceId, taskId } = thread.space;
      const projection = yield* threads
        .getThreadProjection(thread.id)
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
      // The person who asked: the author of the latest turn's prompt, else the thread's owner.
      const latest = projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      const prompt = projection.messages.find((message) => message.id === latest?.userMessageId);
      const before = yield* spaces
        .taskGet(caller, { spaceId, taskId })
        .pipe(Effect.mapError(failure));
      const { task } = yield* spaces
        .setTaskStatus(caller, {
          spaceId,
          taskId,
          status,
          by: { type: "agent", threadId: thread.id },
          askedBy: prompt?.authorId ?? thread.ownerId ?? null,
        })
        .pipe(Effect.mapError(failure));
      return {
        taskId,
        title: task?.title ?? before.task.title,
        from: before.task.status,
        to: task?.status ?? status,
      };
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
