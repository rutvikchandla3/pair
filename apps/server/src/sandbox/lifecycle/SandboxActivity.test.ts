import { assert, it } from "@effect/vitest";
import { MemberId, SandboxId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ThreadAccess from "../../team/ThreadAccess.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as SandboxActivity from "./SandboxActivity.ts";

const owner = MemberId.make("member-owner");
const bob = MemberId.make("member-bob");
const sandboxId = SandboxId.make("sbx_aaaaaaaaaaaaaaaaaaaa");
const threadId = ThreadId.make("thread-machine");

it.effect("stops counting a member's viewing lease once they lose the machine", () => {
  const machines = new Map<SandboxId, ThreadAccess.SandboxAccessEntry>([
    [sandboxId, { ownerMemberId: owner, audience: "members", memberIds: new Set([bob]) }],
  ]);
  return Effect.gen(function* () {
    const activity = yield* SandboxActivity.SandboxActivity;
    yield* TestClock.adjust("1 minute");
    assert.isTrue(yield* activity.view(threadId, bob));
    assert.equal((yield* activity.read([threadId])).viewedAt, 60_000);

    machines.set(sandboxId, { ownerMemberId: owner, audience: "members", memberIds: new Set() });
    assert.isNull((yield* activity.read([threadId])).viewedAt);
    // The owner's renewal still keeps it awake; Bob's lease no longer covers it.
    yield* TestClock.adjust("1 minute");
    assert.isTrue(yield* activity.view(threadId, owner));
    assert.equal((yield* activity.read([threadId])).viewedAt, 120_000);
  }).pipe(
    Effect.provide(
      SandboxActivity.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadShell: () => Effect.succeed({ sandboxId } as never),
            }),
            Layer.mock(TerminalManager.TerminalManager)({
              lastActivityAt: () => Effect.succeed(null),
            }),
            ThreadAccess.layerTest({ serverOwnerId: owner, machines }),
            SqlitePersistence.layerMemory,
          ),
        ),
      ),
    ),
  );
});
