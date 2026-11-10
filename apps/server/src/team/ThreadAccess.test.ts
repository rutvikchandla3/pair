import { assert, describe, it } from "@effect/vitest";
import {
  ComputeDriverId,
  EventId,
  MemberId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Sandbox,
  ProjectId,
  ProviderInstanceId,
  SandboxId,
  type SandboxAccess,
  type SandboxAccessChange,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as Members from "../persistence/Members.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { WorkspaceHostUnavailableError } from "../workspaceHost/WorkspaceHost.ts";
import * as ThreadAccess from "./ThreadAccess.ts";
import * as TeamState from "./TeamState.ts";

const alice = MemberId.make("member-alice");
const bob = MemberId.make("member-bob");
const carol = MemberId.make("member-carol");
const dave = MemberId.make("member-dave");
const erin = MemberId.make("member-erin");
const serverOwner = MemberId.make("member-owner");

const roster = (cloudOnly = true): ThreadAccess.ThreadAccessRoster => ({
  cloudOnly,
  serverOwnerId: serverOwner,
  isActive: (memberId) => memberId !== dave,
});
const entry = (
  audience: "members" | "team",
  memberIds: ReadonlyArray<MemberId>,
  ownerMemberId: MemberId | null = alice,
): ThreadAccess.SandboxAccessEntry => ({ ownerMemberId, audience, memberIds: new Set(memberIds) });
const shared = entry("members", [bob, dave]);

describe("sandboxAllows", () => {
  // `erin` is an admin and `serverOwner` owns the server: neither role is in the rule.
  it.each([
    ["the owner", shared, alice, true],
    ["a listed member", shared, bob, true],
    ["an unlisted member", shared, carol, false],
    ["an unlisted admin", shared, erin, false],
    ["the server's owner, unlisted", shared, serverOwner, false],
    ["a removed member, listed", shared, dave, false],
    ["anyone, on a team machine", entry("team", []), carol, true],
    ["a removed member, on a team machine", entry("team", []), dave, false],
    ["the server's owner, on an ownerless machine", entry("members", [], null), serverOwner, true],
    ["another member, on an ownerless machine", entry("members", [], null), alice, false],
    ["anyone, on a machine nobody has seen", undefined, alice, false],
  ] as const)("%s: %s", (_name, sandbox, memberId, allowed) => {
    assert.strictEqual(ThreadAccess.sandboxAllows(roster(), sandbox, memberId), allowed);
  });

  it("is not consulted off a cloud-only server", () => {
    for (const memberId of [carol, dave]) {
      assert.isTrue(ThreadAccess.sandboxAllows(roster(false), shared, memberId));
      assert.isTrue(ThreadAccess.sandboxAllows(roster(false), undefined, memberId));
    }
  });
});

describe("threadAllows", () => {
  const sandboxId = SandboxId.make("sbx_0123456789abcdef0123");
  it.each([
    ["a known machine's listed member", { sandboxId, ownerId: alice }, shared, bob, true],
    ["a known machine's unlisted member", { sandboxId, ownerId: alice }, shared, carol, false],
    ["an unknown machine's thread owner", { sandboxId, ownerId: alice }, undefined, alice, true],
    ["an unknown machine's other member", { sandboxId, ownerId: alice }, undefined, bob, false],
    ["an unknown ownerless machine's holder", { sandboxId }, undefined, serverOwner, true],
    ["a local thread's owner", { ownerId: alice }, undefined, alice, true],
    ["a local thread's other member", { ownerId: alice }, undefined, bob, false],
    ["an ownerless local thread", { ownerId: null }, undefined, bob, true],
    ["a removed member on an ownerless thread", {}, undefined, dave, false],
  ] as const)("%s", (_name, thread, sandbox, memberId, allowed) => {
    assert.strictEqual(ThreadAccess.threadAllows(roster(), thread, sandbox, memberId), allowed);
  });

  it("is not consulted off a cloud-only server", () => {
    assert.isTrue(ThreadAccess.threadAllows(roster(false), { ownerId: alice }, undefined, bob));
  });
});

const member = (
  id: MemberId,
  fields: Partial<Members.MemberRecord> = {},
): Members.MemberRecord => ({
  id,
  name: id,
  role: "member",
  gitName: null,
  gitEmail: null,
  isOwner: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
  removedAt: null,
  ...fields,
});

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.map(ServerConfig.ServerConfig, (config) => ({ ...config, cloudOnly: true })),
).pipe(
  Layer.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-access-" })),
  Layer.provide(NodeServices.layer),
);

/**
 * `published` gets what the index said of `bob` as each access change reached publication.
 * `threadRead` runs after each thread `ThreadAccess` reads.
 */
const makeLayer = (published: Array<boolean>, threadRead: Effect.Effect<void> = Effect.void) => {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerStores = Layer.merge(
    // Every stream reads from publication, so access must already apply there.
    Layer.effect(
      EventStore.EventStoreV2,
      Effect.gen(function* () {
        const store = yield* EventStore.EventStoreV2;
        const index = yield* ThreadAccess.ThreadAccessIndex;
        return EventStore.EventStoreV2.of({
          ...store,
          publishCommitted: (events) =>
            Effect.suspend(() => {
              for (const stored of events) {
                if ("event" in stored && stored.event.type === "sandbox.access-changed") {
                  const { sandboxId } = stored.event.payload;
                  published.push(index.entries.get(sandboxId)?.memberIds.has(bob) === true);
                }
              }
              return store.publishCommitted(events);
            }),
        });
      }),
    ).pipe(Layer.provideMerge(Layer.merge(EventStore.layer, ThreadAccess.layerIndex))),
    ProjectionStore.layer,
  ).pipe(Layer.provideMerge(layerDatabase));
  return Layer.mergeAll(
    EventSink.layer,
    ThreadAccess.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerConfig,
          TeamState.layerTest([
            member(serverOwner, { role: "admin", isOwner: true }),
            member(alice),
            member(bob),
            member(carol),
            member(erin, { role: "admin" }),
          ]),
          Layer.effect(
            ProjectionStore.ProjectionStoreV2,
            Effect.map(ProjectionStore.ProjectionStoreV2, (store) =>
              ProjectionStore.ProjectionStoreV2.of({
                ...store,
                getThread: (threadId) => store.getThread(threadId).pipe(Effect.tap(threadRead)),
              }),
            ),
          ),
        ),
      ),
    ),
  ).pipe(Layer.provideMerge(layerStores));
};

const t0 = DateTime.makeUnsafe("2026-11-10T10:00:00.000Z");
const sandboxId = SandboxId.make("sbx_0123456789abcdef0123");
const legacyId = SandboxId.make("sbx_fedcba9876543210fedc");
const projectId = ProjectId.make("project:access");
const ownerThreadId = ThreadId.make("thread:access-owner");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const thread: OrchestrationV2AppThread = {
  createdBy: "user",
  creationSource: "web",
  id: ownerThreadId,
  projectId,
  title: "Access",
  providerInstanceId: modelSelection.instanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ownerThreadId },
  forkedFrom: null,
  createdAt: t0,
  updatedAt: t0,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ownerId: alice,
  sandboxId,
};
const record = (id: SandboxId, access: SandboxAccess | undefined): OrchestrationV2Sandbox => ({
  id,
  projectId,
  ownerThreadId,
  ownerMemberId: alice,
  driverId: ComputeDriverId.make("docker"),
  size: "default",
  state: "ready",
  generation: 1,
  driverRef: null,
  admission: null,
  runnerLostAt: null,
  sleepReason: null,
  failure: null,
  ...(access === undefined ? {} : { access }),
  createdAt: t0,
  updatedAt: t0,
});
const members = (memberIds: ReadonlyArray<MemberId>): SandboxAccess => ({
  audience: "members",
  memberIds,
  updatedBy: alice,
  updatedAt: t0,
});
const at = (id: string) => ({
  id: EventId.make(`event:access:${id}`),
  threadId: ownerThreadId,
  occurredAt: t0,
});

const seed = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  yield* sink.write({
    events: [
      { ...at("thread"), type: "thread.created", payload: thread },
      { ...at("private"), type: "sandbox.updated", payload: record(sandboxId, members([])) },
      { ...at("legacy"), type: "sandbox.updated", payload: record(legacyId, undefined) },
    ],
  });
});

const share = (
  id: string,
  memberIds: ReadonlyArray<MemberId>,
  change: Pick<SandboxAccessChange, "added" | "removed">,
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const access = members(memberIds);
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      { ...at(`${id}:updated`), type: "sandbox.updated", payload: record(sandboxId, access) },
      {
        ...at(`${id}:changed`),
        type: "sandbox.access-changed",
        payload: { sandboxId, access, actorId: alice, audienceChanged: false, ...change },
      },
    ];
    yield* sink.write({ events });
  });

describe("ThreadAccess", () => {
  it.effect("follows each commit before it is published, and reports the change", () => {
    const published: Array<boolean> = [];
    return Effect.gen(function* () {
      const access = yield* ThreadAccess.ThreadAccess;
      yield* seed;
      assert.isTrue(access.allowsSandbox(alice, sandboxId));
      assert.isFalse(access.allowsSandbox(bob, sandboxId));
      assert.isTrue(access.allowsSandbox(bob, legacyId));

      const changes = yield* access.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* share("add", [bob], { added: [bob], removed: [] });
      assert.isTrue(access.allowsSandbox(bob, sandboxId));
      assert.isTrue(access.allowsThread(bob, { sandboxId, ownerId: alice }));
      yield* access.assertThread(bob, ownerThreadId);

      yield* share("remove", [], { added: [], removed: [bob] });
      assert.isFalse(access.allowsSandbox(bob, sandboxId));
      assert.deepStrictEqual(published, [true, false]);
      assert.deepStrictEqual(
        (yield* Fiber.join(changes)).map((change) => [change.added, change.removed]),
        [
          [[bob], []],
          [[], [bob]],
        ],
      );

      // Refused as a missing thread is, so the refusal confirms nothing.
      const refused = yield* access.assertThread(bob, ownerThreadId).pipe(Effect.flip);
      assert.instanceOf(refused, ProjectionStore.ProjectionStoreThreadNotFoundError);
      assert.isFalse(access.allowsSandbox(erin, sandboxId));
      assert.isFalse(access.allowsSandbox(alice, SandboxId.make("sbx_00000000000000000000")));

      yield* access.assertPath(alice, `/t3-sandbox/${sandboxId}/repo`);
      yield* access.assertPath(bob, "/Users/bob/project");
      for (const path of [
        `/t3-sandbox/${sandboxId}/repo`,
        `/t3-sandbox/other/../${sandboxId}/repo`,
        "/t3-sandbox",
      ]) {
        const error = yield* access.assertPath(bob, path).pipe(Effect.flip);
        assert.instanceOf(error, WorkspaceHostUnavailableError);
      }
    }).pipe(Effect.provide(makeLayer(published)));
  });

  it.effect("waits for a commit its read already saw before checking", () =>
    Effect.gen(function* () {
      const read = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const access = yield* ThreadAccess.ThreadAccess;
        const index = yield* ThreadAccess.ThreadAccessIndex;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* seed;
        // As `EventSink` does: the lane is held from before COMMIT until the index has the commit.
        yield* index.lane.take(1);
        const event: OrchestrationV2DomainEvent = {
          ...at("gap"),
          type: "sandbox.updated",
          payload: record(sandboxId, members([bob])),
        };
        yield* projections.apply(event);
        const check = yield* access
          .assertThread(bob, ownerThreadId)
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(read);
        yield* index.observeCommitted([{ sequence: 10, commandId: null, event }]);
        yield* index.lane.release(1);
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(check)));
      }).pipe(Effect.provide(makeLayer([], Deferred.succeed(read, undefined).pipe(Effect.asVoid))));
    }),
  );

  it.effect("loads every machine at startup, a record from before access as team", () =>
    Effect.gen(function* () {
      yield* seed;
      const context = yield* Layer.buildWithMemoMap(
        ThreadAccess.layerIndex,
        yield* Layer.makeMemoMap,
        yield* Scope.Scope,
      );
      const { entries } = Context.get(context, ThreadAccess.ThreadAccessIndex);
      assert.deepStrictEqual(entries.get(sandboxId), entry("members", []));
      assert.deepStrictEqual(entries.get(legacyId), entry("team", []));
    }).pipe(Effect.provide(makeLayer([]))),
  );
});
