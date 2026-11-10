import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  EventId,
  MemberId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  SandboxId,
  type TeamImageBuild,
  TeamImageBuildId,
  ComputeDriverId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as TeamImageService from "../sandbox/image/TeamImageService.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import type { MemberRecord } from "../persistence/Members.ts";
import * as MemberPushDevices from "../team/MemberPushDevices.ts";
import * as Presence from "../team/Presence.ts";
import * as TeamState from "../team/TeamState.ts";
import * as ThreadAccess from "../team/ThreadAccess.ts";
import * as MemberPushNotifier from "./MemberPushNotifier.ts";

const NOW = "2026-11-01T00:00:00.000Z";
const LATER = "2099-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const RUN_ID = RunId.make("run-1");
const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const INSTANCE_ID = ProviderInstanceId.make("codex");

const member = (id: string, name: string, isOwner = false): MemberRecord => ({
  id: MemberId.make(id),
  name,
  role: isOwner ? "admin" : "member",
  gitName: null,
  gitEmail: null,
  isOwner,
  createdAt: NOW,
  updatedAt: null,
  removedAt: null,
});
const ALICE = member("alice", "Alice", true);
const BOB = member("bob", "Bob");
const CAROL = member("carol", "Carol");
const TEAM = [ALICE, BOB, CAROL];

const shell = (
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Fix the login bug",
  providerInstanceId: INSTANCE_ID,
  modelSelection: { instanceId: INSTANCE_ID, model: "test-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  activeRunId: null,
  latestVisibleMessage: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  lastVisitedAt: null,
  deletedAt: null,
  branch: null,
  linkedPullRequest: null,
  status: "idle",
  activityRunStatus: null,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  latestRunId: RUN_ID,
  latestRunRequestedAt: null,
  latestRunStartedAt: null,
  latestRunCompletedAt: null,
  latestUserMessageAt: null,
  createdAt: DateTime.makeUnsafe(NOW),
  updatedAt: DateTime.makeUnsafe(NOW),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  latestRunAuthorId: BOB.id,
  ...overrides,
});

const appThread = (
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => ({
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Fix the login bug",
  providerInstanceId: INSTANCE_ID,
  modelSelection: { instanceId: INSTANCE_ID, model: "test-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: DateTime.makeUnsafe(NOW),
  updatedAt: DateTime.makeUnsafe(NOW),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...overrides,
});

const completedRun = {
  id: RUN_ID,
  threadId: THREAD_ID,
  ordinal: 1,
  providerInstanceId: INSTANCE_ID,
  modelSelection: { instanceId: INSTANCE_ID, model: "test-model" },
  providerThreadId: null,
  userMessageId: MessageId.make("message-1"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: DateTime.makeUnsafe(NOW),
  startedAt: DateTime.makeUnsafe(NOW),
  completedAt: DateTime.makeUnsafe(NOW),
  checkpointId: null,
  contextHandoffId: null,
} satisfies OrchestrationV2Run;

const runCompleted: OrchestrationV2DomainEvent = {
  id: EventId.make("event-run-completed"),
  type: "run.updated",
  threadId: THREAD_ID,
  occurredAt: DateTime.makeUnsafe(NOW),
  payload: completedRun,
};

const runFailed: OrchestrationV2DomainEvent = {
  ...runCompleted,
  id: EventId.make("event-run-failed"),
  payload: { ...completedRun, status: "failed" },
};

interface SentMessage {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  readonly data: { readonly deepLink: string };
}

const makeHarness = Effect.fnUntraced(function* (options: {
  readonly members?: ReadonlyArray<MemberRecord>;
  readonly unregistered?: ReadonlyArray<string>;
  readonly endpoint?: string;
  readonly shell?: OrchestrationV2ThreadShell;
  readonly cloudOnly?: boolean;
  /** `ThreadAccess.allowsThread` on a cloud-only server. */
  readonly opens?: (memberId: MemberId) => boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  const members = options.members ?? TEAM;
  for (const record of members) {
    yield* sql`
      INSERT INTO auth_sessions (session_id, subject, member_id, scopes, method, issued_at, expires_at)
      VALUES (${`session-${record.id}`}, ${record.id}, ${record.id}, '[]', 'bearer-access-token', ${NOW}, ${LATER})
    `;
  }
  const devices = yield* MemberPushDevices.MemberPushDevices;
  for (const record of members) {
    yield* devices.register({
      memberId: record.id,
      sessionId: AuthSessionId.make(`session-${record.id}`),
      deviceId: `device-${record.id}`,
      token: `ExponentPushToken[${record.id}]`,
      platform: "ios",
    });
  }

  const requests: Array<ReadonlyArray<SentMessage>> = [];
  const urls: Array<string> = [];
  const shellReads: Array<ThreadId> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "[]";
      const messages: ReadonlyArray<SentMessage> = JSON.parse(body);
      requests.push(messages);
      urls.push(request.url);
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          data: messages.map((message) =>
            options.unregistered?.includes(message.to)
              ? { status: "error", details: { error: "DeviceNotRegistered" } }
              : { status: "ok", id: `ticket-${message.to}` },
          ),
        }),
      );
    }),
  );

  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const pulls = yield* Queue.unbounded<void>();
  const builds = yield* Queue.unbounded<TeamImageService.TeamImageBuildFinished>();
  const buildPulls = yield* Queue.unbounded<void>();
  const currentShell = options.shell ?? shell();
  const notifier = yield* MemberPushNotifier.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        TeamState.layerTest(members),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.sync(() => {
              shellReads.push(threadId);
              return currentShell;
            }),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 1,
              threads: [currentShell],
              archivedThreads: [],
            }),
          streamDomainEvents: Stream.fromEffectRepeat(
            Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
          ),
        }),
        Layer.mock(TeamImageService.TeamImageService)({
          buildFinished: Stream.fromEffectRepeat(
            Queue.offer(buildPulls, undefined).pipe(Effect.andThen(Queue.take(builds))),
          ),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
        }),
        Layer.mock(ServerConfig.ServerConfig)({ cloudOnly: options.cloudOnly ?? false } as never),
        Layer.mock(ThreadAccess.ThreadAccess)({
          enforced: options.cloudOnly ?? false,
          allowsSandbox: () => true,
          allowsThread: (memberId) => options.opens?.(memberId) ?? true,
          mayInviteGuest: () => true,
          agentReaches: () => true,
          threadTarget: () => undefined,
          movedAt: () => undefined,
        }),
      ),
    ),
    Effect.provideService(HttpClient.HttpClient, http),
    options.endpoint === undefined
      ? identity
      : Effect.provideService(MemberPushNotifier.MemberPushEndpoint, options.endpoint),
  );
  yield* notifier.start();
  yield* Queue.take(pulls);
  yield* Queue.take(buildPulls);
  const emit = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    yield* Queue.offer(events, event);
    yield* Queue.take(pulls);
    yield* notifier.drain;
  });
  const emitBuild = Effect.fnUntraced(function* (
    finished: TeamImageService.TeamImageBuildFinished,
  ) {
    yield* Queue.offer(builds, finished);
    yield* Queue.take(buildPulls);
    yield* notifier.drain;
  });
  const recipients = () => requests.flatMap((batch) => batch.map((message) => message.to));
  const deviceRows = sql<{ readonly device_id: string }>`
    SELECT device_id FROM member_push_devices ORDER BY device_id
  `.pipe(Effect.map((rows) => rows.map((row) => row.device_id)));
  return { emit, emitBuild, requests, urls, recipients, shellReads, deviceRows, sql };
});

const token = (record: MemberRecord) => `ExponentPushToken[${record.id}]`;

const finishedBuild = (change: Partial<TeamImageBuild>): TeamImageBuild => ({
  id: TeamImageBuildId.make("tib_00000000000000000015"),
  number: 15,
  status: "succeeded",
  phase: null,
  recipeRevision: 1,
  driverId: ComputeDriverId.make("docker"),
  requestedBy: { kind: "member", memberId: ALICE.id },
  activateOnSuccess: true,
  requestedAt: DateTime.makeUnsafe(NOW),
  startedAt: DateTime.makeUnsafe(NOW),
  finishedAt: DateTime.makeUnsafe(NOW),
  imageDeletedAt: null,
  ...change,
});

const layer = Layer.mergeAll(MemberPushDevices.layer, Presence.layer).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

describe("MemberPushNotifier", () => {
  it.effect("pushes Bob's completed turn on Alice's thread to Bob and Alice, not Carol", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      yield* harness.emit(runCompleted);

      assert.deepStrictEqual(harness.requests, [
        [ALICE, BOB].map((record) => ({
          to: token(record),
          title: "Thread completed",
          body: "Fix the login bug",
          data: { deepLink: "/threads/env-1/thread-1" },
          sound: "default",
          channelId: "agent-alerts",
          priority: "high",
        })),
      ]);
      assert.deepStrictEqual(harness.urls, ["https://exp.host/--/api/v2/push/send"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "pushes Machine failed once to Bob and Alice when Bob's waiting run fails with its machine",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          shell: shell({
            sandbox: { state: "failed", ownerThreadId: THREAD_ID, failureCode: "boot-timeout" },
          }),
        });
        yield* harness.emit(runFailed);

        assert.deepStrictEqual(
          harness.requests.flat().map(({ to, title, body }) => ({ to, title, body })),
          [ALICE, BOB].map((record) => ({
            to: token(record),
            title: "Machine failed",
            body: "Fix the login bug",
          })),
        );
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("never pushes Bob his own message", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      yield* harness.emit({
        id: EventId.make("event-message"),
        type: "message.updated",
        threadId: THREAD_ID,
        occurredAt: DateTime.makeUnsafe(NOW),
        payload: {
          id: MessageId.make("message-2"),
          threadId: THREAD_ID,
          runId: null,
          nodeId: null,
          role: "user",
          text: "Please also check the logout path",
          attachments: [],
          streaming: false,
          createdBy: "user",
          creationSource: "web",
          authorId: BOB.id,
          createdAt: DateTime.makeUnsafe(NOW),
          updatedAt: DateTime.makeUnsafe(NOW),
        },
      });

      assert.deepStrictEqual(harness.recipients(), [token(ALICE)]);
      assert.strictEqual(harness.requests[0]?.[0]?.title, "New message");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("pushes an Assign only to the new owner, at the endpoint a harness sets", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ endpoint: "http://127.0.0.1:4010/push" });
      yield* harness.emit({
        id: EventId.make("event-assign"),
        type: "thread.metadata-updated",
        threadId: THREAD_ID,
        occurredAt: DateTime.makeUnsafe(NOW),
        payload: appThread({ ownerId: CAROL.id, ownerUpdatedBy: ALICE.id }),
      });

      assert.deepStrictEqual(harness.recipients(), [token(CAROL)]);
      assert.strictEqual(harness.requests[0]?.[0]?.title, "Assigned to you");
      assert.deepStrictEqual(harness.urls, ["http://127.0.0.1:4010/push"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("links an archive push to Archived threads, naming the archiver", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      yield* harness.emit({
        id: EventId.make("event-archive"),
        type: "thread.archived",
        threadId: THREAD_ID,
        occurredAt: DateTime.makeUnsafe(NOW),
        payload: appThread({ archivedAt: DateTime.makeUnsafe(NOW), archivedBy: BOB.id }),
      });

      assert.deepStrictEqual(
        harness.requests.flat().map(({ to, title, data }) => ({ to, title, data })),
        [{ to: token(ALICE), title: "Archived by Bob", data: { deepLink: "/settings/archive" } }],
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect.each([
    { row: "viewing and online", idle: false, recipients: [token(BOB)] },
    { row: "viewing and away", idle: true, recipients: [token(ALICE), token(BOB)] },
  ])("Alice $row", ({ idle, recipients }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      const presence = yield* Presence.Presence;
      yield* presence
        .subscribe({ connectionId: "alice-web", memberId: ALICE.id })
        .pipe(Effect.asVoid);
      yield* presence.report("alice-web", { viewingThreadId: THREAD_ID, idle });
      yield* harness.emit(runCompleted);

      assert.deepStrictEqual(harness.recipients(), recipients);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("drops a revoked session's device without sending to it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ members: [ALICE, BOB] });
      yield* harness.sql`
        UPDATE auth_sessions SET revoked_at = ${NOW}
        WHERE session_id IN ('session-alice', 'session-bob')
      `;
      yield* harness.emit(runCompleted);

      assert.deepStrictEqual(harness.requests, []);
      assert.deepStrictEqual(yield* harness.deviceRows, []);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("deletes a device Expo reports as not registered", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ unregistered: [token(ALICE)] });
      yield* harness.emit(runCompleted);

      assert.deepStrictEqual(harness.recipients(), [token(ALICE), token(BOB)]);
      assert.deepStrictEqual(yield* harness.deviceRows, ["device-bob", "device-carol"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect.each([
    { row: "sends nothing and reads nothing", cloudOnly: false, recipients: [] },
    {
      row: "pushes the completion to its member when cloud-only",
      cloudOnly: true,
      recipients: [token(ALICE)],
    },
  ])("on a single-member server, $row", ({ cloudOnly, recipients }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ members: [ALICE], cloudOnly });
      yield* harness.emit(runCompleted);

      assert.deepStrictEqual(harness.recipients(), recipients);
      assert.deepStrictEqual(harness.shellReads, cloudOnly ? [THREAD_ID] : []);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("pushes a cloud thread only to the members who can open it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cloudOnly: true, opens: (id) => id !== BOB.id });
      yield* harness.emit(runCompleted);

      assert.deepStrictEqual(harness.recipients(), [token(ALICE)]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "pushes Shared with you to each member added, and nothing else an access change does",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ cloudOnly: true });
        const changed = (
          id: string,
          change: {
            added?: ReadonlyArray<MemberId>;
            removed?: ReadonlyArray<MemberId>;
            audienceChanged?: boolean;
          },
        ) =>
          harness.emit({
            id: EventId.make(id),
            type: "sandbox.access-changed",
            threadId: THREAD_ID,
            occurredAt: DateTime.makeUnsafe(NOW),
            payload: {
              sandboxId: SandboxId.make("sbx_0123456789abcdef0123"),
              access: {
                audience: "members",
                memberIds: [BOB.id],
                updatedBy: ALICE.id,
                updatedAt: DateTime.makeUnsafe(NOW),
              },
              added: change.added ?? [],
              removed: change.removed ?? [],
              audienceChanged: change.audienceChanged ?? false,
              actorId: ALICE.id,
            },
          });
        // The owner is named when the machine changes hands; Assign already tells them.
        yield* changed("event-shared", { added: [BOB.id, ALICE.id] });
        yield* changed("event-removed", { removed: [CAROL.id] });
        yield* changed("event-team", { audienceChanged: true });

        assert.deepStrictEqual(
          harness.requests.flat().map(({ to, title, body, data }) => ({ to, title, body, data })),
          [
            {
              to: token(BOB),
              title: "Shared with you",
              body: 'Alice shared "Fix the login bug" with you',
              data: { deepLink: "/threads/env-1/thread-1" },
            },
          ],
        );
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("pushes a finished build to its recipients with the machines link, not to others", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      yield* harness.emitBuild({
        build: finishedBuild({
          status: "failed",
          failure: { phase: "install", detail: "boom", logTail: ["secret-ish"] },
        }),
        recipients: [ALICE.id, BOB.id],
      });

      assert.deepStrictEqual(
        harness.requests.flat().map(({ to, title, body, data }) => ({ to, title, body, data })),
        [ALICE, BOB].map((record) => ({
          to: token(record),
          title: "Team image",
          body: "Build 15 failed at install.",
          data: { deepLink: "/settings/machines" },
        })),
      );
      assert.deepStrictEqual(harness.shellReads, []);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("pushes nothing for a cancelled build or a build nobody hears of", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      yield* harness.emitBuild({
        build: finishedBuild({ status: "cancelled" }),
        recipients: [ALICE.id],
      });
      yield* harness.emitBuild({ build: finishedBuild({}), recipients: [] });

      assert.deepStrictEqual(harness.requests, []);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
