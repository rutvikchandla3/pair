import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MemberId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2StoredEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TeamState from "../team/TeamState.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import { personalStateOf } from "./MemberThreadState.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const makeLayer = (team: boolean) => {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerTeam = team ? TeamState.layer.pipe(Layer.provide(layerDatabase)) : Layer.empty;
  return Layer.mergeAll(
    layerDatabase,
    layerTeam,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "member-state" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ).pipe(Layer.provide(layerTeam)),
  );
};
const layerTeam = makeLayer(true);
const layerSolo = makeLayer(false);

const bob = MemberId.make("member:bob");
const carol = MemberId.make("member:carol");
const dave = MemberId.make("member:dave");
const threadId = ThreadId.make("thread:member-state");
const later = "1970-01-02T00:00:00.000Z";
const resetAt = "1970-01-01T06:00:00.000Z";

type Command = OrchestrationV2Command;

const dispatch = (command: Command) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) => orchestrator.dispatch(command));

const emitted = (command: Command) =>
  dispatch(command).pipe(
    Effect.map(({ storedEvents }) =>
      storedEvents.map(({ event }: OrchestrationV2StoredEvent) =>
        "member" in event && event.member !== undefined
          ? `${event.type}:${event.member.memberId}`
          : event.type,
      ),
    ),
  );

const serverOwner = Effect.map(
  Effect.serviceOption(TeamState.TeamState),
  Option.match({ onNone: () => undefined, onSome: (team) => team.ownerId }),
);

const createThread = dispatch({
  type: "thread.create",
  commandId: CommandId.make("create"),
  threadId,
  projectId: ProjectId.make("project:member-state"),
  title: "Member state",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdBy: "user",
  creationSource: "web",
});

const send = (id: string, actorId: MemberId) =>
  emitted({
    type: "message.dispatch",
    commandId: CommandId.make(`send:${id}`),
    threadId,
    messageId: MessageId.make(id),
    text: id,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "user",
    creationSource: "web",
    actorId,
  });

/** Leaves one run that hit a usage limit, so the thread can settle, be marked unread and snooze until the reset. */
const failRunOnUsageLimit = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  yield* dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("start"),
    threadId,
    messageId: MessageId.make("start"),
    text: "start",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
  const now = yield* DateTime.now;
  yield* projections.apply({
    id: EventId.make("event:run-failed"),
    type: "run.updated",
    threadId,
    runId: run.id,
    occurredAt: now,
    payload: { ...run, status: "failed", completedAt: now },
  });
  yield* projections.apply({
    id: EventId.make("event:usage-limit"),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: TurnItemId.make("item:usage-limit"),
      type: "error",
      threadId,
      runId: run.id,
      nodeId: run.rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "failed",
      title: "Usage limit reached",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      failure: {
        class: "usage_limit",
        message: "Plan limit reached.",
        resetAt,
        code: "usageLimitExceeded",
        retryable: null,
      },
    },
  });
  return run.id;
});

const readState = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return {
    row: yield* projections.getThread(threadId),
    members: new Map(
      (yield* projections.listThreadMemberStates(threadId)).map((entry) => [
        entry.memberId,
        entry.state,
      ]),
    ),
  };
});

it.effect("a single member reaches the solo end state and writes no member rows", () =>
  Effect.gen(function* () {
    const run = Effect.gen(function* () {
      const actorId = yield* serverOwner;
      const actor = actorId === undefined ? {} : { actorId };
      yield* createThread;
      const runId = yield* failRunOnUsageLimit;
      const steps = [
        yield* emitted({
          type: "thread.metadata.update",
          commandId: CommandId.make("limit-snooze"),
          threadId,
          limitRecovery: { runId, resetAt, snooze: true },
          ...actor,
        }),
        yield* emitted({
          type: "thread.snooze",
          commandId: CommandId.make("snooze"),
          threadId,
          snoozedUntil: later,
          ...actor,
        }),
        yield* emitted({ type: "thread.settle", commandId: CommandId.make("settle"), threadId }),
        yield* emitted({
          type: "thread.pin",
          commandId: CommandId.make("pin"),
          threadId,
          orderKey: "a0",
          ...actor,
        }),
        yield* emitted({
          type: "thread.visit",
          commandId: CommandId.make("visit"),
          threadId,
          visitedAt: "1970-01-01T00:00:01.000Z",
          opened: true,
          ...actor,
        }),
        yield* emitted({
          type: "thread.mark-unread",
          commandId: CommandId.make("mark-unread"),
          threadId,
          ...actor,
        }),
      ];
      return { owner: actorId, steps, ...(yield* readState) };
    });
    const team = yield* run.pipe(Effect.provide(layerTeam));
    const solo = yield* run.pipe(Effect.provide(layerSolo));
    assert.deepEqual(team.row, solo.row);
    assert.equal(team.members.size, 0);
    assert.deepEqual(solo.steps, [
      ["thread.metadata-updated"],
      ["thread.snoozed"],
      ["thread.settled"],
      ["thread.pinned"],
      ["thread.visited"],
      ["thread.marked-unread"],
    ]);
    assert.deepEqual(team.steps, [
      ["thread.metadata-updated"],
      // Clearing the limit snooze is shared, so it goes out before the holder's own snooze.
      ["thread.metadata-updated", `thread.snoozed:${team.owner}`],
      ["thread.settled"],
      ["thread.unsettled", `thread.pinned:${team.owner}`],
      [`thread.visited:${team.owner}`],
      [`thread.marked-unread:${team.owner}`],
    ]);
  }),
);

it.effect("a non-holder's pin, snooze, visit and mark-unread change only their own state", () =>
  Effect.gen(function* () {
    yield* createThread;
    const runId = yield* failRunOnUsageLimit;
    yield* dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("owner-limit-snooze"),
      threadId,
      limitRecovery: { runId, resetAt, snooze: true },
    });
    yield* dispatch({ type: "thread.settle", commandId: CommandId.make("settle"), threadId });
    const before = (yield* readState).row;

    assert.deepEqual(
      yield* emitted({
        type: "thread.pin",
        commandId: CommandId.make("bob-pin"),
        threadId,
        orderKey: "b0",
        actorId: bob,
      }),
      ["thread.unsettled", `thread.pinned:${bob}`],
    );
    yield* TestClock.adjust("1 second");
    assert.deepEqual(
      yield* emitted({
        type: "thread.snooze",
        commandId: CommandId.make("bob-snooze"),
        threadId,
        snoozedUntil: later,
        actorId: bob,
      }),
      [`thread.snoozed:${bob}`],
    );
    yield* dispatch({
      type: "thread.visit",
      commandId: CommandId.make("bob-visit"),
      threadId,
      visitedAt: "1970-01-01T00:00:05.000Z",
      actorId: bob,
    });
    yield* dispatch({
      type: "thread.visit",
      commandId: CommandId.make("carol-visit"),
      threadId,
      visitedAt: "1970-01-01T00:00:05.000Z",
      actorId: carol,
    });
    yield* dispatch({
      type: "thread.mark-unread",
      commandId: CommandId.make("bob-mark-unread"),
      threadId,
      actorId: bob,
    });

    const { row, members } = yield* readState;
    assert.deepEqual(personalStateOf(row), personalStateOf(before));
    assert.deepEqual(
      [row.settledOverride, row.ownerId, row.limitRecovery?.snooze],
      ["active", null, true],
    );
    const bobState = members.get(bob)!;
    assert.deepEqual(
      [bobState.pinOrderKey, bobState.pinnedAt === null, bobState.snoozedUntil],
      ["b0", false, DateTime.makeUnsafe(later)],
    );
    // Mark-unread rewinds only bob's watermark to just before the failed run completed.
    assert.deepEqual(bobState.lastVisitedAt, DateTime.makeUnsafe(-1));
    assert.deepEqual(members.get(carol)!.lastVisitedAt, DateTime.makeUnsafe(5_000));
  }).pipe(Effect.provide(layerTeam)),
);

it.effect("a non-holder's limit snooze is personal and arms nothing shared", () =>
  Effect.gen(function* () {
    yield* createThread;
    const runId = yield* failRunOnUsageLimit;
    const before = (yield* readState).row;
    assert.deepEqual(
      yield* emitted({
        type: "thread.metadata.update",
        commandId: CommandId.make("bob-limit-snooze"),
        threadId,
        limitRecovery: { runId, resetAt, snooze: true },
        actorId: bob,
      }),
      [`thread.snoozed:${bob}`],
    );
    assert.deepEqual((yield* readState).row, before);
    assert.deepEqual(
      (yield* readState).members.get(bob)!.snoozedUntil,
      DateTime.makeUnsafe(resetAt),
    );

    assert.deepEqual(
      yield* emitted({
        type: "thread.metadata.update",
        commandId: CommandId.make("bob-limit-resume"),
        threadId,
        limitRecovery: { runId, resetAt, autoResume: true, snooze: false },
        actorId: bob,
      }),
      ["thread.metadata-updated", `thread.unsnoozed:${bob}`],
    );
    const { row, members } = yield* readState;
    assert.deepEqual(
      [row.limitRecovery?.autoResume, row.limitRecovery?.snooze, row.snoozedUntil],
      [true, false, null],
    );
    assert.deepEqual(
      [members.get(bob)!.snoozedUntil, members.get(bob)!.lastSnoozeWakeAt],
      [null, DateTime.makeUnsafe(0)],
    );
  }).pipe(Effect.provide(layerTeam)),
);

it.effect("settle clears every member's pin and snooze and keeps their visits", () =>
  Effect.gen(function* () {
    yield* createThread;
    yield* failRunOnUsageLimit;
    yield* dispatch({
      type: "thread.pin",
      commandId: CommandId.make("bob-pin"),
      threadId,
      actorId: bob,
    });
    yield* dispatch({
      type: "thread.snooze",
      commandId: CommandId.make("carol-snooze"),
      threadId,
      snoozedUntil: later,
      actorId: carol,
    });
    for (const memberId of [bob, dave]) {
      yield* dispatch({
        type: "thread.visit",
        commandId: CommandId.make(`visit:${memberId}`),
        threadId,
        visitedAt: "1970-01-01T00:00:01.000Z",
        actorId: memberId,
      });
    }
    assert.deepEqual(
      yield* emitted({ type: "thread.settle", commandId: CommandId.make("settle"), threadId }),
      ["thread.settled", `thread.settled:${bob}`, `thread.settled:${carol}`],
    );
    const { row, members } = yield* readState;
    assert.equal(row.settledOverride, "settled");
    assert.deepEqual(
      [...members].map(([memberId, state]) => [
        memberId,
        state.pinnedAt,
        state.snoozedUntil,
        state.lastVisitedAt,
      ]),
      [
        [bob, null, null, DateTime.makeUnsafe(1_000)],
        [carol, null, null, null],
        [dave, null, null, DateTime.makeUnsafe(1_000)],
      ],
    );
  }).pipe(Effect.provide(layerTeam)),
);

it.effect("a message ends only its sender's snooze", () =>
  Effect.gen(function* () {
    const owner = (yield* serverOwner)!;
    yield* createThread;
    for (const actorId of [owner, bob, carol]) {
      yield* dispatch({
        type: "thread.snooze",
        commandId: CommandId.make(`snooze:${actorId}`),
        threadId,
        snoozedUntil: later,
        actorId,
      });
    }
    assert.include(yield* send("from-bob", bob), `thread.unsnoozed:${bob}`);
    let state = yield* readState;
    assert.deepEqual(
      [
        state.row.snoozedUntil,
        state.members.get(bob)!.snoozedUntil,
        state.members.get(carol)!.snoozedUntil,
      ],
      [DateTime.makeUnsafe(later), null, DateTime.makeUnsafe(later)],
    );
    yield* send("from-owner", owner);
    state = yield* readState;
    assert.deepEqual(
      [state.row.snoozedUntil, state.members.get(carol)!.snoozedUntil],
      [null, DateTime.makeUnsafe(later)],
    );
  }).pipe(Effect.provide(layerTeam)),
);

it.effect("owner.set hands the holder's state to the new owner and back", () =>
  Effect.gen(function* () {
    const owner = (yield* serverOwner)!;
    yield* createThread;
    yield* dispatch({
      type: "thread.pin",
      commandId: CommandId.make("owner-pin"),
      threadId,
      orderKey: "owner",
      actorId: owner,
    });
    yield* dispatch({
      type: "thread.pin",
      commandId: CommandId.make("bob-pin"),
      threadId,
      orderKey: "bob",
      actorId: bob,
    });
    assert.deepEqual(
      yield* emitted({
        type: "thread.owner.set",
        commandId: CommandId.make("to-bob"),
        threadId,
        ownerId: bob,
        actorId: owner,
      }),
      ["thread.metadata-updated", `thread.metadata-updated:${owner}`],
    );
    let state = yield* readState;
    assert.deepEqual(
      [state.row.ownerId, state.row.pinOrderKey, [...state.members.keys()]],
      [bob, "bob", [owner]],
    );
    assert.equal(state.members.get(owner)!.pinOrderKey, "owner");

    yield* dispatch({
      type: "thread.owner.set",
      commandId: CommandId.make("to-owner"),
      threadId,
      ownerId: owner,
      actorId: bob,
    });
    state = yield* readState;
    assert.deepEqual(
      [state.row.ownerId, state.row.pinOrderKey, [...state.members.keys()]],
      [owner, "owner", [bob]],
    );
    assert.equal(state.members.get(bob)!.pinOrderKey, "bob");
  }).pipe(Effect.provide(layerTeam)),
);

it.effect("automatic settlement rejects a member change made after its snapshot", () =>
  Effect.gen(function* () {
    yield* createThread;
    const snapshotAt = (yield* readState).row.updatedAt;
    yield* TestClock.adjust("1 second");
    yield* dispatch({
      type: "thread.visit",
      commandId: CommandId.make("bob-visit"),
      threadId,
      visitedAt: "1970-01-01T00:00:01.000Z",
      actorId: bob,
    });
    const rejected = yield* dispatch({
      type: "thread.auto-settle",
      commandId: CommandId.make("auto-settle-stale"),
      threadId,
      snapshotAt,
    }).pipe(Effect.flip);
    assert.equal(rejected._tag, "OrchestratorDispatchError");
    yield* dispatch({
      type: "thread.auto-settle",
      commandId: CommandId.make("auto-settle-fresh"),
      threadId,
      snapshotAt: yield* DateTime.now,
    });
    assert.equal((yield* readState).row.settledOverride, "settled");
  }).pipe(Effect.provide(layerTeam)),
);
