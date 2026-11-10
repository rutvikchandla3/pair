import * as DocumentText from "../provider/DocumentText.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  EventId,
  GuestMessageId,
  MemberId,
  MessageId,
  RuntimeRequestId,
  SandboxId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type UserInputAttachments,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  createAttachmentId,
  createPendingAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { MemberRecord } from "../persistence/Members.ts";
import * as TeamState from "../team/TeamState.ts";
import * as ThreadAccess from "../team/ThreadAccess.ts";
import {
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorDispatchError,
} from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { assertCommandAccess, dispatchCommand } from "./ThreadMessageIntake.ts";

function member(id: string, overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    id: MemberId.make(id),
    name: id,
    role: "member",
    gitName: null,
    gitEmail: null,
    isOwner: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: null,
    removedAt: null,
    ...overrides,
  };
}

const layerIntakeTest = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-question-intake-",
}).pipe(
  Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    TeamState.layerTest([
      member("member-owner", { role: "admin", isOwner: true }),
      member("member-bob"),
      member("member-carol"),
      member("member-gone", { removedAt: "2026-09-01T00:00:00.000Z" }),
    ]),
  ),
);

const layerFailingDispatchHandler =
  (captured: OrchestrationV2ServerCommand[]) => (command: OrchestrationV2ServerCommand) => {
    captured.push(command);
    return Effect.fail(
      new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Stop after intake",
      }),
    );
  };

const layerFailingDispatch = (captured: OrchestrationV2ServerCommand[]) =>
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    dispatch: layerFailingDispatchHandler(captured),
  });

const NOW = DateTime.makeUnsafe("2026-09-13T00:00:00.000Z");

const answeredRespondEvents = (input: {
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly attachmentsByQuestionId: UserInputAttachments;
}): OrchestrationV2StoredEvent[] => [
  {
    sequence: 1,
    commandId: null,
    event: {
      id: EventId.make("evt-recorded-answer"),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: NOW,
      payload: {
        id: TurnItemId.make("item-recorded-answer"),
        type: "user_input_request",
        threadId: input.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: NOW,
        updatedAt: NOW,
        requestId: RuntimeRequestId.make(input.requestId),
        questions: [],
        questionAnswer: {
          requestId: input.requestId,
          answers: {},
          attachmentsByQuestionId: input.attachmentsByQuestionId,
        },
      },
    },
  },
];

it.effect("claims question uploads and passes readable paths through the V2 request command", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const id = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${id}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const captured: OrchestrationV2ServerCommand[] = [];
    yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-1"),
      threadId: ThreadId.make("thread-answer"),
      requestId: RuntimeRequestId.make("request-1"),
      answers: { q: ["Selected option"] },
      attachmentsByQuestionId: {
        q: [{ type: "image", id, name: "screen.png", mimeType: "image/png", sizeBytes: 3 }],
      },
    }).pipe(Effect.provide(layerFailingDispatch(captured)), Effect.result);
    expect(captured).toHaveLength(1);
    const command = captured[0]!;
    expect(command.type).toBe("runtime-request.respond");
    if (command.type !== "runtime-request.respond") return;
    const attachment = command.attachmentsByQuestionId?.q?.[0];
    expect(attachment).toBeDefined();
    const path = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: attachment!,
    });
    expect(path).not.toBeNull();
    expect(NodeFS.readFileSync(path!)).toEqual(Buffer.from([1, 2, 3]));
    expect(command.answers?.q).toEqual([
      "Selected option",
      `Attached image "screen.png": "${path}"`,
    ]);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("retains claimed copies when dispatch failure may have been accepted", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const captured: OrchestrationV2ServerCommand[] = [];
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-ambiguous"),
      threadId: ThreadId.make("thread-ambiguous"),
      requestId: RuntimeRequestId.make("request-ambiguous"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(Effect.provide(layerFailingDispatch(captured)), Effect.result);
    expect(result._tag).toBe("Failure");
    expect(captured).toHaveLength(1);
    const threadFiles = NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
      entry.startsWith("thread-ambiguous-"),
    );
    expect(threadFiles).toHaveLength(1);
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("releases claimed copies when the command was already rejected", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-rejected"),
      threadId: ThreadId.make("thread-rejected"),
      requestId: RuntimeRequestId.make("request-rejected"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: (command) =>
            Effect.fail(
              new OrchestratorCommandPreviouslyRejectedError({
                commandId: command.commandId,
                commandType: command.type,
                detail: "rejected earlier",
              }),
            ),
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-rejected-"),
      ),
    ).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("releases claimed copies when dispatch replays an earlier accepted response", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-replay");
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const earlierAttachment = {
      type: "image" as const,
      id: ChatAttachmentId.make("thread-replay-00000000-0000-4000-8000-0000000000aa"),
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 3,
    };
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${earlierAttachment.id}.png`),
      new Uint8Array([4, 4, 4]),
    );
    const storedEvents = answeredRespondEvents({
      threadId,
      requestId: "request-replay",
      attachmentsByQuestionId: { q: [earlierAttachment] },
    });
    const result = yield* dispatchCommand({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-replay"),
      threadId,
      requestId: RuntimeRequestId.make("request-replay"),
      answers: { q: ["one"] },
      attachmentsByQuestionId: {
        q: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
    }).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: () => Effect.succeed({ sequence: 1, storedEvents }),
        }),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Success");
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-replay-"),
      ),
    ).toEqual([`${earlierAttachment.id}.png`]);
    expect(
      NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${earlierAttachment.id}.png`)),
    ).toEqual(Buffer.from([4, 4, 4]));
    expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`))).toBe(true);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("a retried response re-claims the preserved pending uploads", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("thread-retry");
    const pendingId = ChatAttachmentId.make(createPendingAttachmentId()!);
    const lateId = ChatAttachmentId.make(createPendingAttachmentId()!);
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${pendingId}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const command: OrchestrationV2Command = {
      type: "runtime-request.respond",
      commandId: CommandId.make("answer-retry"),
      threadId,
      requestId: RuntimeRequestId.make("request-retry"),
      answers: { q1: ["one"], q2: ["two"] },
      attachmentsByQuestionId: {
        q1: [
          {
            type: "image",
            id: pendingId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
        q2: [
          {
            type: "image",
            id: lateId,
            name: "late.png",
            mimeType: "image/png",
            sizeBytes: 2,
          },
        ],
      },
    };
    const captured: OrchestrationV2ServerCommand[] = [];
    const first = yield* dispatchCommand(command).pipe(
      Effect.provide(layerFailingDispatch(captured)),
      Effect.result,
    );
    expect(first._tag).toBe("Failure");
    expect(captured).toHaveLength(0);

    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${lateId}.png`),
      new Uint8Array([7, 7]),
    );
    const retry = yield* dispatchCommand(command).pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: (dispatched) => {
            captured.push(dispatched);
            return Effect.succeed({ sequence: 1, storedEvents: [] });
          },
        }),
      ),
      Effect.result,
    );
    expect(retry._tag).toBe("Success");
    const dispatched = captured[0]!;
    expect(dispatched.type).toBe("runtime-request.respond");
    if (dispatched.type !== "runtime-request.respond") return;
    for (const attachment of [
      ...(dispatched.attachmentsByQuestionId?.q1 ?? []),
      ...(dispatched.attachmentsByQuestionId?.q2 ?? []),
    ]) {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      expect(path).not.toBeNull();
      expect(NodeFS.existsSync(path!)).toBe(true);
    }
    expect(
      NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-retry-"),
      ),
    ).toHaveLength(2);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect("sends a guest message with the guest's files, never ones the client names", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const guestFile = {
      type: "image" as const,
      id: ChatAttachmentId.make(createAttachmentId("thread-guest")!),
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 3,
    };
    NodeFS.writeFileSync(
      NodePath.join(config.attachmentsDir, `${guestFile.id}.png`),
      new Uint8Array([1, 2, 3]),
    );
    const guestMessageId = GuestMessageId.make("guest-message:files");
    const captured: OrchestrationV2ServerCommand[] = [];
    const layerGuestShare = Layer.mock(ThreadManagementService.ThreadManagementService)({
      dispatch: layerFailingDispatchHandler(captured),
      // Only the share is read.
      getThreadSnapshotWindow: () =>
        Effect.succeed({
          projection: {
            thread: {
              guestShare: {
                messages: [{ id: guestMessageId, status: "pending", attachments: [guestFile] }],
              },
            },
          },
        } as unknown as Effect.Success<
          ReturnType<
            ThreadManagementService.ThreadManagementServiceShape["getThreadSnapshotWindow"]
          >
        >),
    });
    yield* dispatchCommand({
      type: "message.dispatch",
      commandId: CommandId.make("send-guest-message"),
      threadId: ThreadId.make("thread-guest"),
      messageId: MessageId.make("message-guest"),
      guestMessageId,
      text: "",
      attachments: [{ ...guestFile, id: ChatAttachmentId.make("thread-guest-owner-file") }],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    }).pipe(Effect.provide(layerGuestShare), Effect.result);
    const command = captured[0];
    if (command?.type !== "message.dispatch") throw new Error("Expected a message dispatch.");
    expect(command.attachments).toHaveLength(1);
    // The guest's file, which is already the thread's.
    expect(command.attachments).toEqual([guestFile]);
  }).pipe(Effect.provide(layerIntakeTest)),
);

it.effect(
  "lets only the owner or an admin delete or sleep a machine, only its owner share it, and assigns only active members",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-owned");
      const sideChatId = ThreadId.make("thread-side-chat");
      const sandboxId = SandboxId.make("sbx_0123456789abcdef0123");
      const captured: OrchestrationV2ServerCommand[] = [];
      const attempt = (command: OrchestrationV2Command) =>
        dispatchCommand(command).pipe(
          Effect.provide(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              dispatch: layerFailingDispatchHandler(captured),
              // Carol's side chat shares the machine of Bob's thread.
              getThreadShell: (id) =>
                Effect.succeed({
                  ownerId: MemberId.make(id === sideChatId ? "member-carol" : "member-bob"),
                  sandboxId,
                  sandbox: { state: "ready", ownerThreadId: threadId },
                } as never),
            }),
          ),
          Effect.flip,
          Effect.map((error) =>
            error._tag === "ThreadMessageIntakeForbiddenError"
              ? error.reason
              : error._tag === "OrchestratorCommandRejectedError"
                ? "rejected"
                : "dispatched",
          ),
        );
      const deleteBy = (actorId: string | undefined) =>
        attempt({
          type: "thread.delete",
          commandId: CommandId.make(`delete-${actorId}`),
          threadId,
          ...(actorId === undefined ? {} : { actorId: MemberId.make(actorId) }),
        });
      const assign = (ownerId: string) =>
        attempt({
          type: "thread.owner.set",
          commandId: CommandId.make(`assign-${ownerId}`),
          threadId,
          ownerId: MemberId.make(ownerId),
        });

      expect(yield* deleteBy("member-carol")).toBe("not_owner_or_admin");
      expect(yield* deleteBy("member-bob")).toBe("dispatched");
      expect(yield* deleteBy("member-owner")).toBe("dispatched");
      expect(yield* deleteBy(undefined)).toBe("dispatched");
      const sleepBy = (actorId: string | undefined, type: "sandbox.sleep" | "sandbox.discard") =>
        attempt({
          type,
          commandId: CommandId.make(`${type}-${actorId}`),
          threadId: sideChatId,
          sandboxId,
          ...(actorId === undefined ? {} : { actorId: MemberId.make(actorId) }),
        });
      expect(yield* sleepBy("member-carol", "sandbox.sleep")).toBe("machine_not_owner_or_admin");
      expect(yield* sleepBy("member-owner", "sandbox.sleep")).toBe("dispatched");
      // Without an actor nobody vouches for the sender, so the owner check cannot pass.
      expect(yield* sleepBy(undefined, "sandbox.sleep")).toBe("rejected");
      expect(yield* sleepBy(undefined, "sandbox.discard")).toBe("rejected");
      const shareBy = (actorId: string | undefined, memberIds: ReadonlyArray<string>) =>
        attempt({
          type: "sandbox.access.set",
          commandId: CommandId.make(`share-${actorId}-${memberIds.join()}`),
          threadId: sideChatId,
          sandboxId,
          ...(actorId === undefined ? {} : { actorId: MemberId.make(actorId) }),
          audience: "members",
          memberIds: memberIds.map((id) => MemberId.make(id)),
        });
      expect(yield* shareBy("member-carol", ["member-carol"])).toBe("not_owner");
      expect(yield* shareBy(undefined, ["member-carol"])).toBe("rejected");
      expect(yield* shareBy("member-owner", ["member-owner"])).toBe("not_owner");
      expect(yield* shareBy("member-bob", ["member-carol", "member-gone"])).toBe("inactive_member");
      expect(yield* shareBy("member-bob", ["member-unknown"])).toBe("inactive_member");
      expect(yield* shareBy("member-bob", ["member-carol"])).toBe("dispatched");
      expect(yield* assign("member-gone")).toBe("inactive_owner");
      expect(yield* assign("member-unknown")).toBe("inactive_owner");
      expect(yield* assign("member-carol")).toBe("dispatched");
      expect(captured.map((command) => command.commandId)).toEqual([
        "delete-member-bob",
        "delete-member-owner",
        "delete-undefined",
        "sandbox.sleep-member-owner",
        "share-member-bob-member-carol",
        "assign-member-carol",
      ]);
      // Routed to the owner's stream, not the side chat the admin clicked from.
      expect(captured.find((command) => command.type === "sandbox.sleep")?.threadId).toBe(threadId);
      expect(captured.find((command) => command.type === "sandbox.access.set")?.threadId).toBe(
        threadId,
      );
    }).pipe(Effect.provide(layerIntakeTest)),
);

const PRIVATE_SANDBOX = SandboxId.make("sbx_aaaaaaaaaaaaaaaaaaaa");
const SHARED_SANDBOX = SandboxId.make("sbx_bbbbbbbbbbbbbbbbbbbb");

/** Bob's machine is his alone; the team machine is everyone's. Carol asks. */
const bobsAccess = ThreadAccess.layerTest({
  serverOwnerId: MemberId.make("member-owner"),
  machines: new Map<SandboxId, ThreadAccess.SandboxAccessEntry>([
    [
      PRIVATE_SANDBOX,
      { ownerMemberId: MemberId.make("member-bob"), audience: "members", memberIds: new Set() },
    ],
    [
      SHARED_SANDBOX,
      { ownerMemberId: MemberId.make("member-bob"), audience: "team", memberIds: new Set() },
    ],
  ]),
  threads: new Map([
    [
      ThreadId.make("thread-private"),
      { ownerId: MemberId.make("member-bob"), sandboxId: PRIVATE_SANDBOX },
    ],
    [
      ThreadId.make("thread-shared"),
      { ownerId: MemberId.make("member-bob"), sandboxId: SHARED_SANDBOX },
    ],
  ]),
});

it.effect("refuses a member's command that names a thread, machine or path they cannot open", () =>
  Effect.gen(function* () {
    const carol = MemberId.make("member-carol");
    const check = (command: Record<string, unknown>) =>
      assertCommandAccess(
        { commandId: CommandId.make("access"), ...command } as OrchestrationV2Command,
        carol,
      ).pipe(
        Effect.as("allowed"),
        Effect.catchTags({
          OrchestratorProjectionError: (error) => Effect.succeed(`missing ${error.threadId}`),
          OrchestratorCommandRejectedError: () => Effect.succeed("rejected"),
        }),
      );
    const privateRoot = `/t3-sandbox/${PRIVATE_SANDBOX}/repo`;
    const sharedRoot = `/t3-sandbox/${SHARED_SANDBOX}/repo`;
    const byKind = (thread: string, root: string): ReadonlyArray<Record<string, unknown>> => [
      { type: "thread.archive", threadId: thread },
      { type: "thread.fork", sourceThreadId: thread, targetThreadId: "thread-new" },
      { type: "thread.merge_back", sourceThreadId: "thread-shared", targetThreadId: thread },
      { type: "thread.created.record", parentThreadId: thread, targetThreadId: "thread-shared" },
      { type: "delegated_task.wake-policy", parentThreadId: thread },
      { type: "delegated_task.completion-delivery.acknowledge", parentThreadId: thread },
      { type: "delegated_task.completion-delivery.dispose", parentThreadId: thread },
      {
        type: "message.dispatch",
        threadId: "thread-shared",
        senderThreadId: thread,
        dispatchMode: { type: "start_immediately" },
      },
      {
        type: "message.dispatch",
        threadId: "thread-shared",
        sourcePlanRef: { threadId: thread, planId: "plan" },
        dispatchMode: { type: "start_immediately" },
      },
      {
        type: "message.dispatch",
        threadId: "thread-shared",
        dispatchMode: {
          type: "defer_start",
          workspaceStrategy: { type: "existing_worktree", worktreePath: root },
        },
      },
      { type: "thread.create", threadId: "thread-new", worktreePath: root },
      { type: "thread.metadata.update", threadId: "thread-shared", expectedWorktreePath: root },
      {
        type: "thread.pull-request.sync",
        threadId: "thread-shared",
        expected: { workspaceRoot: root, worktreePath: null },
      },
      { type: "prepared-run.retry", threadId: thread },
      { type: "sandbox.wake", threadId: thread, sandboxId: SHARED_SANDBOX },
      { type: "sandbox.access.set", threadId: "thread-shared", sandboxId: PRIVATE_SANDBOX },
    ];

    const refused = yield* Effect.forEach(byKind("thread-private", privateRoot), check);
    expect(refused).toEqual([
      "missing thread-private",
      "missing thread-private",
      "missing thread-private",
      "missing thread-private",
      "missing thread-private",
      "missing thread-private",
      "missing thread-private",
      "missing thread-private",
      "missing thread-private",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "missing thread-private",
      "rejected",
      "rejected",
    ]);
    const shared = byKind("thread-shared", sharedRoot).slice(0, -1);
    expect(yield* Effect.forEach(shared, check)).toEqual(shared.map(() => "allowed"));
    // An unknown thread is refused like one she cannot open, and `..` cannot climb into Bob's machine.
    expect(yield* check({ type: "thread.archive", threadId: "thread-unknown" })).toBe(
      "missing thread-unknown",
    );
    expect(
      yield* check({
        type: "thread.create",
        threadId: "thread-new",
        worktreePath: `/t3-sandbox/${SHARED_SANDBOX}/../${PRIVATE_SANDBOX}/repo`,
      }),
    ).toBe("rejected");
    expect(
      yield* check({
        type: "thread.create",
        threadId: "thread-new",
        worktreePath: "/t3-sandbox/x",
      }),
    ).toBe("rejected");
    expect(
      yield* check({
        type: "thread.create",
        threadId: "thread-new",
        worktreePath: "/home/carol/repo",
      }),
    ).toBe("allowed");
    // A new id that names Bob's private thread is not "already exists" to her: it is missing.
    expect(
      yield* check({ type: "thread.create", threadId: "thread-private", worktreePath: null }),
    ).toBe("missing thread-private");
    expect(
      yield* check({
        type: "thread.fork",
        sourceThreadId: "thread-shared",
        targetThreadId: "thread-private",
      }),
    ).toBe("missing thread-private");
    expect(
      yield* check({ type: "thread.create", threadId: "thread-shared", worktreePath: null }),
    ).toBe("allowed");
  }).pipe(Effect.provide(bobsAccess)),
);

// Off a cloud-only server the index tracks no thread, so a check would refuse every one.
it.effect("checks no command where access is not enforced", () =>
  Effect.gen(function* () {
    const archive = {
      type: "thread.archive",
      commandId: CommandId.make("access"),
      threadId: ThreadId.make("thread-private"),
    } as OrchestrationV2Command;
    yield* assertCommandAccess(archive, MemberId.make("member-carol"));
  }).pipe(Effect.provide(ThreadAccess.layerTest())),
);
