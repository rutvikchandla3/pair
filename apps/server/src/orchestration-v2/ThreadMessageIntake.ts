import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import { appendUserInputAttachmentPaths } from "../provider/userInputAttachments.ts";
import {
  type ChatAttachment,
  type OrchestrationV2Command,
  MemberId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as TeamState from "../team/TeamState.ts";
import * as Orchestrator from "./Orchestrator.ts";

import * as AttachmentClaims from "./AttachmentClaims.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

// These failures precede commitCommand; generic dispatch errors can follow commits and remain ambiguous.
function dispatchWasNotAccepted(
  error: Orchestrator.OrchestratorV2Error | ThreadManagement.ThreadManagementError,
) {
  switch (error._tag) {
    case "OrchestratorCommandRejectedError":
    case "OrchestratorThreadAlreadyExistsError":
    case "OrchestratorProjectionError":
    case "OrchestratorProviderAdapterError":
    case "OrchestratorCommandPreviouslyRejectedError":
    case "OrchestratorCommandIdConflictError":
    case "OrchestratorSubagentThreadReadOnlyError":
    case "OrchestratorLocalThreadReadOnlyError":
    case "OrchestratorThreadAboveModeLimitError":
    case "OrchestratorRuntimeModeAboveCeilingError":
    case "OrchestratorSandboxCommandMovedError":
    case "ThreadManagementProviderInstanceDisabledError":
      return true;
    default:
      return false;
  }
}
export class ThreadMessageIntakeForbiddenError extends Schema.TaggedError<ThreadMessageIntakeForbiddenError>()(
  "ThreadMessageIntakeForbiddenError",
  {
    threadId: ThreadId,
    memberId: MemberId,
    reason: Schema.Literals(["not_owner_or_admin", "inactive_owner", "machine_not_owner_or_admin"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_owner_or_admin":
        return "Only the thread's owner or an admin can delete it.";
      case "inactive_owner":
        return "Threads can only be assigned to active team members.";
      case "machine_not_owner_or_admin":
        return "Only the owner or an admin can sleep or discard this machine.";
    }
  }
}

type SandboxClientCommand = Extract<
  OrchestrationV2Command,
  { readonly type: "sandbox.wake" | "sandbox.sleep" | "sandbox.retry" | "sandbox.discard" }
>;

const isSandboxClientCommand = (command: OrchestrationV2Command): command is SandboxClientCommand =>
  command.type === "sandbox.wake" ||
  command.type === "sandbox.sleep" ||
  command.type === "sandbox.retry" ||
  command.type === "sandbox.discard";

/** The actor is an admin, the server owner, or `threadId`'s owner. A missing thread passes. */
const actorOwnsThreadOrAdmin = Effect.fn("ThreadMessageIntake.actorOwnsThreadOrAdmin")(function* (
  actorId: MemberId,
  threadId: ThreadId,
) {
  const team = yield* TeamState.TeamState;
  const actor = (yield* Ref.get(team.members)).get(actorId);
  if (actor?.role === "admin" || actor?.isOwner === true) return true;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const shell = yield* threads.getThreadShell(threadId);
  // A missing thread is the orchestrator's to reject.
  return shell === null || shell.ownerId === actorId;
});

/** Team permissions the orchestrator cannot see; it only records who acted. */
const assertTeamPermission = Effect.fn("ThreadMessageIntake.assertTeamPermission")(function* (
  command: OrchestrationV2Command,
) {
  const team = yield* TeamState.TeamState;
  if (command.type === "thread.owner.set" && !(yield* team.isActive(command.ownerId))) {
    return yield* new ThreadMessageIntakeForbiddenError({
      threadId: command.threadId,
      memberId: command.ownerId,
      reason: "inactive_owner",
    });
  }
  if (command.type !== "thread.delete" || command.actorId === undefined) return;
  if (yield* actorOwnsThreadOrAdmin(command.actorId, command.threadId)) return;
  return yield* new ThreadMessageIntakeForbiddenError({
    threadId: command.threadId,
    memberId: command.actorId,
    reason: "not_owner_or_admin",
  });
});

/**
 * Sends a machine command from the thread the user acts in to the sandbox owner's stream, so its
 * receipt and events land there (04 §1). Sleep and discard need the owner thread's owner.
 */
export const dispatchSandboxCommand = Effect.fn("ThreadMessageIntake.dispatchSandboxCommand")(
  function* (command: SandboxClientCommand) {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const route = Effect.gen(function* () {
      const acting = yield* threads.getThreadShell(command.threadId);
      if (acting === null || acting.sandboxId !== command.sandboxId) {
        return yield* new Orchestrator.OrchestratorCommandRejectedError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Thread ${command.threadId} does not use machine ${command.sandboxId}.`,
        });
      }
      // Without a record the orchestrator refuses on the acting thread.
      const ownerThreadId = acting.sandbox?.ownerThreadId ?? command.threadId;
      if (
        (command.type === "sandbox.sleep" || command.type === "sandbox.discard") &&
        command.actorId !== undefined &&
        !(yield* actorOwnsThreadOrAdmin(command.actorId, ownerThreadId))
      ) {
        return yield* new ThreadMessageIntakeForbiddenError({
          threadId: ownerThreadId,
          memberId: command.actorId,
          reason: "machine_not_owner_or_admin",
        });
      }
      return yield* threads.dispatch({ ...command, threadId: ownerThreadId });
    });
    // Ownership moves only by adoption, so one re-read finds the new owner.
    return yield* route.pipe(
      Effect.catchTags({ OrchestratorSandboxCommandMovedError: () => route }),
    );
  },
);

const isOrchestratorError = Schema.is(Orchestrator.OrchestratorV2Error);
const isThreadManagementError = Schema.is(ThreadManagement.ThreadManagementError);

const releaseUnusedClaims = Effect.fn("ThreadMessageIntake.releaseUnusedClaims")(function* (
  claimedPaths: ReadonlyArray<string>,
  accepted: ReadonlyArray<ChatAttachment>,
) {
  if (claimedPaths.length === 0) return;
  const config = yield* ServerConfig.ServerConfig;
  const retained = new Set(
    accepted.flatMap((attachment) => {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      return path ? [path, `${path}.txt`] : [];
    }),
  );
  yield* AttachmentClaims.releaseClaimedAttachments(
    claimedPaths.filter((path) => !retained.has(path)),
  );
});

/**
 * A guest message goes out with the files the guest attached, never ones a client names. They
 * are already the thread's attachments. A message no longer waiting gets none; the orchestrator
 * then refuses or replays the send.
 */
const withGuestAttachments = Effect.fn("ThreadMessageIntake.withGuestAttachments")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
) {
  if (command.guestMessageId === undefined) return command;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // Only the thread record is needed; the window keeps the read small.
  const { projection } = yield* threads
    .getThreadSnapshotWindow(command.threadId, { rowLimit: 1 })
    .pipe(
      Effect.mapError(
        (cause) =>
          new AttachmentClaims.AttachmentClaimError({
            message: "Failed to read the guest message.",
            cause,
          }),
      ),
    );
  const message = projection.thread.guestShare?.messages.find(
    (candidate) => candidate.id === command.guestMessageId && candidate.status === "pending",
  );
  return { ...command, attachments: message?.attachments ?? [] };
});

export const dispatchCommand = Effect.fn("ThreadMessageIntake.dispatchCommand")(function* (
  incoming: OrchestrationV2Command,
) {
  if (isSandboxClientCommand(incoming)) return yield* dispatchSandboxCommand(incoming);
  yield* assertTeamPermission(incoming);
  const command =
    incoming.type === "message.dispatch" ? yield* withGuestAttachments(incoming) : incoming;
  const threads = yield* ThreadManagement.ThreadManagementService;
  if (command.type === "runtime-request.respond" && command.attachmentsByQuestionId) {
    const config = yield* ServerConfig.ServerConfig;
    const incomingByQuestionId = command.attachmentsByQuestionId;
    yield* AttachmentClaims.validateAttachmentLimits(Object.values(incomingByQuestionId).flat());
    const claimedPaths: string[] = [];
    const prepared = yield* Effect.gen(function* () {
      const attachmentsByQuestionId: import("@t3tools/contracts").UserInputAttachments = {};
      for (const [questionId, attachments] of Object.entries(incomingByQuestionId)) {
        const claimed = yield* AttachmentClaims.claimPendingAttachments({
          threadId: command.threadId,
          attachments,
        });
        claimedPaths.push(...claimed.claimedPaths);
        Object.defineProperty(attachmentsByQuestionId, questionId, {
          value: claimed.attachments,
          enumerable: true,
        });
      }
      const answers = yield* appendUserInputAttachmentPaths({
        answers: command.answers ?? {},
        attachmentsByQuestionId,
        attachmentsDir: config.attachmentsDir,
      }).pipe(
        Effect.mapError(
          (cause) => new AttachmentClaims.AttachmentClaimError({ message: cause.issue }),
        ),
      );
      return { answers, attachmentsByQuestionId };
    }).pipe(Effect.onError(() => AttachmentClaims.releaseClaimedAttachments(claimedPaths)));
    return yield* threads
      .dispatch({
        ...command,
        answers: prepared.answers,
        attachmentsByQuestionId: prepared.attachmentsByQuestionId,
      })
      .pipe(
        Effect.tap((result) => {
          // Replayed receipts refer to the first answer; release this attempt's unused copies only with a resolved item.
          // Missing questionAnswer means no accepted attachments; missing resolution leaves delivery ambiguous.
          const answeredItems = result.storedEvents.flatMap(({ event }) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_input_request" &&
            event.payload.requestId === command.requestId
              ? [event.payload]
              : [],
          );
          return answeredItems.length > 0
            ? releaseUnusedClaims(
                claimedPaths,
                answeredItems.flatMap((item) =>
                  item.questionAnswer === undefined
                    ? []
                    : Object.values(item.questionAnswer.attachmentsByQuestionId).flat(),
                ),
              )
            : Effect.void;
        }),
        Effect.tapError((error) =>
          dispatchWasNotAccepted(error)
            ? AttachmentClaims.releaseClaimedAttachments(claimedPaths)
            : Effect.void,
        ),
      );
  }
  if (
    command.type !== "message.dispatch" &&
    (command.type !== "queued-run.edit" || command.attachments === undefined)
  )
    return yield* threads.dispatch(command);
  const claimed = yield* AttachmentClaims.claimPendingAttachments({
    threadId: command.threadId,
    attachments: command.attachments ?? [],
  });
  return yield* threads
    .dispatch({
      ...command,
      attachments: claimed.attachments,
      ...(command.context
        ? {
            context: remapComposerContextAttachments(
              command.context,
              command.attachments ?? [],
              claimed.attachments,
            ),
          }
        : {}),
    })
    .pipe(
      Effect.tap((result) =>
        releaseUnusedClaims(
          claimed.claimedPaths,
          result.storedEvents.flatMap(({ event }) =>
            event.type === "message.updated" ? event.payload.attachments : [],
          ),
        ),
      ),
      Effect.tapError((error) =>
        dispatchWasNotAccepted(error)
          ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
          : Effect.void,
      ),
    );
});

export const sendToThread = Effect.fn("ThreadMessageIntake.sendToThread")(function* (
  input: ThreadManagement.ThreadManagementSendInput,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const claimed = yield* AttachmentClaims.claimPendingAttachments(input);
  return yield* threads.sendToThread({ ...input, attachments: claimed.attachments }).pipe(
    Effect.tap((result) => releaseUnusedClaims(claimed.claimedPaths, result.message.attachments)),
    Effect.tapError((error) =>
      dispatchWasNotAccepted(error)
        ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
        : Effect.void,
    ),
  );
});

export const launchThread = Effect.fn("ThreadMessageIntake.launchThread")(function* (
  input: ThreadLaunch.ThreadLaunchInput,
) {
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  yield* AttachmentClaims.validateAttachmentLimits(input.initialMessage?.attachments ?? []);
  if (!input.initialMessage?.attachments.some(AttachmentClaims.attachmentIsPendingUpload)) {
    return yield* launches.launch(input);
  }
  if (input.threadId === undefined) {
    return yield* new AttachmentClaims.AttachmentClaimError({
      message: "Uploaded attachments need a thread id at launch.",
    });
  }
  const claimed = yield* AttachmentClaims.claimPendingAttachments({
    threadId: input.threadId,
    attachments: input.initialMessage.attachments,
  });
  return yield* launches
    .launch({
      ...input,
      initialMessage: {
        ...input.initialMessage,
        attachments: claimed.attachments,
        ...(input.initialMessage.context
          ? {
              context: remapComposerContextAttachments(
                input.initialMessage.context,
                input.initialMessage.attachments,
                claimed.attachments,
              ),
            }
          : {}),
      },
    })
    .pipe(
      Effect.tap((result) =>
        releaseUnusedClaims(
          claimed.claimedPaths,
          result.projection.messages.flatMap((message) => message.attachments),
        ),
      ),
      Effect.tapError((error) => {
        if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
          return AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths);
        }
        // Project/receipt reads precede dispatch; create-thread errors can wrap post-message reads and prove nothing alone.
        const notAccepted =
          error.operation === "resolve-project" ||
          error.operation === "read-receipt" ||
          ((error.operation === "create-thread" || error.operation === "dispatch-message") &&
            (isOrchestratorError(error.cause) || isThreadManagementError(error.cause)) &&
            // Projection errors under create-thread can occur after the message commit.
            (error.operation !== "create-thread" ||
              error.cause._tag !== "OrchestratorProjectionError") &&
            dispatchWasNotAccepted(error.cause));
        return notAccepted
          ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
          : Effect.void;
      }),
    );
});
