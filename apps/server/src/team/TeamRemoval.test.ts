import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ComputeDriverId,
  EventId,
  MemberId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Sandbox,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  SandboxId,
  type TeamMember,
  type TeamRemoveInput,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type * as Members from "../persistence/Members.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TeamMembers from "./TeamMembers.ts";
import * as TeamRemoval from "./TeamRemoval.ts";
import * as TeamState from "./TeamState.ts";
import * as ThreadAccess from "./ThreadAccess.ts";

const admin = MemberId.make("member-admin");
const ada = MemberId.make("member-ada");
const bob = MemberId.make("member-bob");
const carol = MemberId.make("member-carol");
const gone = MemberId.make("member-gone");
const serverOwner = MemberId.make("member-owner");

const member = (
  id: MemberId,
  fields: Partial<Members.MemberRecord> = {},
): Members.MemberRecord => ({
  id,
  name: id === ada ? "Ada" : id,
  role: "member",
  gitName: null,
  gitEmail: null,
  isOwner: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
  removedAt: null,
  ...fields,
});

const t0 = DateTime.makeUnsafe("2026-11-10T10:00:00.000Z");
const projectId = ProjectId.make("project:removal");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const adaMachine = SandboxId.make("sbx_aaaaaaaaaaaaaaaaaaaa");
const bobMachine = SandboxId.make("sbx_bbbbbbbbbbbbbbbbbbbb");

const thread = (
  id: string,
  fields: Partial<OrchestrationV2AppThread>,
): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: ThreadId.make(id),
  projectId,
  title: id,
  providerInstanceId: modelSelection.instanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: ThreadId.make(id),
  },
  forkedFrom: null,
  createdAt: t0,
  updatedAt: t0,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...fields,
});

const machine = (
  id: SandboxId,
  ownerThreadId: string,
  ownerMemberId: MemberId,
  memberIds: ReadonlyArray<MemberId>,
): OrchestrationV2Sandbox => ({
  id,
  projectId,
  ownerThreadId: ThreadId.make(ownerThreadId),
  ownerMemberId,
  driverId: ComputeDriverId.make("docker"),
  size: "default",
  state: "ready",
  generation: 1,
  driverRef: null,
  admission: null,
  runnerLostAt: null,
  sleepReason: null,
  failure: null,
  access: { audience: "members", memberIds, updatedBy: ownerMemberId, updatedAt: t0 },
  createdAt: t0,
  updatedAt: t0,
});

/**
 * Ada owns a machine with a thread, a side chat and a subagent on it, and a local thread. Bob owns
 * a machine Ada was shared on, and a side chat on Ada's machine.
 */
const seed = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const at = (id: string, threadId: string) => ({
    id: EventId.make(`event:removal:${id}`),
    threadId: ThreadId.make(threadId),
    occurredAt: t0,
  });
  const onAdaMachine = { sandboxId: adaMachine };
  const threads: ReadonlyArray<OrchestrationV2AppThread> = [
    thread("ada-main", { ownerId: ada, ...onAdaMachine }),
    thread("ada-side", {
      ownerId: ada,
      ...onAdaMachine,
      lineage: {
        parentThreadId: ThreadId.make("ada-main"),
        relationshipToParent: "fork",
        rootThreadId: ThreadId.make("ada-main"),
        sideChat: true,
      },
    }),
    thread("ada-subagent", {
      ownerId: ada,
      ...onAdaMachine,
      lineage: {
        parentThreadId: ThreadId.make("ada-main"),
        relationshipToParent: "subagent",
        rootThreadId: ThreadId.make("ada-main"),
      },
    }),
    thread("ada-local", { ownerId: ada }),
    thread("bob-main", { ownerId: bob, sandboxId: bobMachine }),
    thread("bob-side-on-ada", { ownerId: bob, ...onAdaMachine }),
  ];
  yield* sink.write({
    events: [
      ...threads.map((payload) => ({
        ...at(`thread:${payload.id}`, payload.id),
        type: "thread.created" as const,
        payload,
      })),
      {
        ...at("ada-machine", "ada-main"),
        type: "sandbox.updated" as const,
        payload: machine(adaMachine, "ada-main", ada, [bob]),
      },
      {
        ...at("bob-machine", "bob-main"),
        type: "sandbox.updated" as const,
        payload: machine(bobMachine, "bob-main", bob, [ada, carol]),
      },
    ],
  });
});

const run = (options: {
  readonly cloudOnly: boolean;
  readonly dispatched: Array<OrchestrationV2ServerCommand>;
  readonly removed: Array<MemberId>;
}) => {
  const layerStores = Layer.merge(
    Layer.merge(EventStore.layer, ThreadAccess.layerIndex),
    ProjectionStore.layer,
  ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
  const layerRemoval = TeamRemoval.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(TeamMembers.TeamMembers)({
          remove: ({ memberId }) =>
            Effect.sync(() => {
              options.removed.push(memberId);
              return {
                id: memberId,
                name: "Ada",
                role: "member",
                color: "",
                isOwner: false,
                createdAt: "2026-01-01T00:00:00.000Z",
                removedAt: "2026-11-10T10:00:00.000Z",
              } satisfies TeamMember;
            }),
        }),
        TeamState.layerTest([
          member(serverOwner, { role: "admin", isOwner: true }),
          member(admin, { role: "admin" }),
          member(ada),
          member(bob),
          member(carol),
          member(gone, { removedAt: "2026-02-01T00:00:00.000Z" }),
        ]),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: (command) =>
            Effect.sync(() => {
              options.dispatched.push(command);
              return {} as never;
            }),
        }),
        Layer.effect(
          ServerConfig.ServerConfig,
          Effect.map(ServerConfig.ServerConfig, (config) => ({
            ...config,
            cloudOnly: options.cloudOnly,
          })),
        ).pipe(
          Layer.provide(
            ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-removal-" }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
  return Layer.mergeAll(EventSink.layer, layerRemoval).pipe(Layer.provideMerge(layerStores));
};

const remove = (input: TeamRemoveInput) =>
  TeamRemoval.TeamRemoval.use((service) => service.remove(input, admin));

const summary = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  commands.map((command) => {
    switch (command.type) {
      case "thread.owner.set":
        return `give ${command.threadId} to ${command.ownerId}`;
      case "thread.delete":
        return `delete ${command.threadId}`;
      case "sandbox.discard":
        return `discard ${command.sandboxId}`;
      case "sandbox.access.set":
        return `${command.sandboxId} list ${command.memberIds.join()} by ${command.actorId}`;
      default:
        return command.type;
    }
  });

describe("TeamRemoval", () => {
  it.effect("counts the cloud threads a member owns, not local or subagent ones", () => {
    const options = { cloudOnly: true, dispatched: [], removed: [] };
    return Effect.gen(function* () {
      yield* seed;
      const count = (memberId: MemberId) =>
        TeamRemoval.TeamRemoval.use((service) => service.preview({ memberId })).pipe(
          Effect.map((preview) => preview.cloudThreadCount),
        );
      assert.strictEqual(yield* count(ada), 2);
      assert.strictEqual(yield* count(bob), 2);
      assert.strictEqual(yield* count(carol), 0);
    }).pipe(Effect.provide(run(options)));
  });

  it.effect(
    "refuses to remove a member who owns cloud threads without saying where they go",
    () => {
      const options = { cloudOnly: true, dispatched: [], removed: [] };
      return Effect.gen(function* () {
        yield* seed;
        const error = yield* remove({ memberId: ada }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "owns-cloud-threads");
        assert.strictEqual(
          error.message,
          "Ada owns 2 cloud threads. Give them to a member or delete them.",
        );
        assert.deepStrictEqual(options.dispatched, []);
        assert.deepStrictEqual(options.removed, []);
      }).pipe(Effect.provide(run(options)));
    },
  );

  it.effect(
    "gives their threads away, drops them from every machine's list, then removes them",
    () => {
      const options = {
        cloudOnly: true,
        dispatched: [] as Array<OrchestrationV2ServerCommand>,
        removed: [] as Array<MemberId>,
      };
      return Effect.gen(function* () {
        yield* seed;
        yield* remove({ memberId: ada, cloudThreads: { type: "give", toMemberId: carol } });
        assert.deepStrictEqual(summary(options.dispatched), [
          "give ada-main to member-carol",
          "give ada-side to member-carol",
          // Bob's machine listed her; the machine's owner is the one who sets its list.
          `${bobMachine} list member-carol by member-bob`,
        ]);
        assert.deepStrictEqual(options.removed, [ada]);
        assert.isTrue(options.dispatched.every((command) => "actorId" in command));
      }).pipe(Effect.provide(run(options)));
    },
  );

  it.effect("refuses a target who is not an active member, before anything moves", () => {
    const options = {
      cloudOnly: true,
      dispatched: [] as Array<OrchestrationV2ServerCommand>,
      removed: [] as Array<MemberId>,
    };
    return Effect.gen(function* () {
      yield* seed;
      for (const toMemberId of [gone, ada, MemberId.make("member-unknown")]) {
        const error = yield* remove({
          memberId: ada,
          cloudThreads: { type: "give", toMemberId },
        }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "not-found");
      }
      assert.deepStrictEqual(options.dispatched, []);
      assert.deepStrictEqual(options.removed, []);
    }).pipe(Effect.provide(run(options)));
  });

  it.effect("deletes their threads and the machine they own, then removes them", () => {
    const options = {
      cloudOnly: true,
      dispatched: [] as Array<OrchestrationV2ServerCommand>,
      removed: [] as Array<MemberId>,
    };
    return Effect.gen(function* () {
      yield* seed;
      yield* remove({ memberId: ada, cloudThreads: { type: "delete" } });
      assert.deepStrictEqual(summary(options.dispatched), [
        // A side chat goes first: deleting its thread would delete it anyway.
        "delete ada-side",
        "delete ada-main",
        `discard ${adaMachine}`,
        `${bobMachine} list member-carol by member-bob`,
      ]);
      assert.deepStrictEqual(options.removed, [ada]);
    }).pipe(Effect.provide(run(options)));
  });

  it.effect(
    "removes a member who owns no cloud thread without a choice, and cleans the lists",
    () => {
      const options = {
        cloudOnly: true,
        dispatched: [] as Array<OrchestrationV2ServerCommand>,
        removed: [] as Array<MemberId>,
      };
      return Effect.gen(function* () {
        yield* seed;
        yield* remove({ memberId: carol });
        assert.deepStrictEqual(summary(options.dispatched), [
          `${bobMachine} list member-ada by member-bob`,
        ]);
        assert.deepStrictEqual(options.removed, [carol]);
      }).pipe(Effect.provide(run(options)));
    },
  );

  it.effect("leaves a server that is not cloud-only to remove as before", () => {
    const options = {
      cloudOnly: false,
      dispatched: [] as Array<OrchestrationV2ServerCommand>,
      removed: [] as Array<MemberId>,
    };
    return Effect.gen(function* () {
      yield* seed;
      yield* remove({ memberId: ada });
      assert.deepStrictEqual(options.dispatched, []);
      assert.deepStrictEqual(options.removed, [ada]);
    }).pipe(Effect.provide(run(options)));
  });
});
