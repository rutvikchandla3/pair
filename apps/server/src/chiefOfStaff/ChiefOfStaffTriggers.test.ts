import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationProjectShell,
  type OrchestrationV2ShellThreadStatus,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadShellSnapshot,
  MemberId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProjectStoreV2 from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadAccess from "../team/ThreadAccess.ts";
import * as ChiefOfStaffTriggers from "./ChiefOfStaffTriggers.ts";
import { ChiefOfStaffHost } from "./ChiefOfStaffHost.ts";
import { homeThreadsFile } from "./homeThreads.ts";

const memberA = MemberId.make("member-a");
const memberB = MemberId.make("member-b");
const projectId = ProjectId.make("project-pair");
const HOME_A = "home-thread-a";
const HOME_B = "home-thread-b";

interface ShellInput {
  readonly id: string;
  readonly status: OrchestrationV2ShellThreadStatus;
  readonly title?: string;
  readonly pendingKind?: "user_input" | "permission";
  readonly lineage?: unknown;
  readonly ownerId?: MemberId | null;
}

/** Only the fields the diff, the digest and the access rule read; the rest is cast away. */
const shell = (input: ShellInput): OrchestrationV2ThreadShell =>
  ({
    id: ThreadId.make(input.id),
    projectId,
    title: input.title ?? `Thread ${input.id}`,
    status: input.status,
    pendingRuntimeRequest:
      input.pendingKind === undefined
        ? null
        : { id: "request-1", kind: input.pendingKind, createdAt: "2026-01-01T00:00:00Z" },
    lineage: input.lineage ?? { relationshipToParent: "root" },
    ownerId: input.ownerId ?? null,
    archivedAt: null,
    deletedAt: null,
  }) as unknown as OrchestrationV2ThreadShell;

const homeShell = (threadId: ThreadId): OrchestrationV2ThreadShell =>
  shell({ id: String(threadId), status: "idle", title: "Chief of staff" });

interface SetupOptions {
  readonly proactive?: boolean;
  readonly homes?: Record<string, string>;
  readonly access?: ThreadAccess.ThreadAccess["Service"];
}

const setup = (options: SetupOptions = {}) =>
  Effect.gen(function* () {
    const sends: Array<ThreadManagementService.ThreadManagementSendInput> = [];
    const threadsRef = yield* Ref.make<ReadonlyArray<OrchestrationV2ThreadShell>>([]);

    const host = Layer.succeed(
      ChiefOfStaffHost,
      ChiefOfStaffHost.of({
        workspaceDir: Effect.die("voice is not under test"),
        t3Home: Effect.succeed("/state"),
        openAppServer: () => Effect.die("voice is not under test"),
        loadThreadId: () => Effect.undefined,
        saveThreadId: () => Effect.void,
        statusSnapshot: () => Effect.succeed(""),
        statusChanges: Stream.empty,
      }),
    );
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getShellSnapshot: () =>
        Ref.get(threadsRef).pipe(
          Effect.map(
            (current) =>
              ({
                threads: current,
                archivedThreads: [],
              }) as unknown as OrchestrationV2ThreadShellSnapshot,
          ),
        ),
      getThreadShell: (threadId) => Effect.succeed(homeShell(threadId)),
      sendToThread: (input) => {
        sends.push(input);
        return Effect.succeed({} as ThreadManagementService.ThreadManagementSendResult);
      },
    });
    const projects = Layer.mock(ProjectStoreV2.ProjectStoreV2)({
      listShells: () =>
        Effect.succeed([
          { id: projectId, title: "Pair" },
        ] as unknown as ReadonlyArray<OrchestrationProjectShell>),
    });
    const accessLayer = Layer.succeed(
      ThreadAccess.ThreadAccess,
      options.access ?? ThreadAccess.makeTest(),
    );
    const common = ServerConfig.layerTest(process.cwd(), { prefix: "t3-cos-triggers-" }).pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    const dependencies = yield* Layer.build(
      Layer.mergeAll(
        host,
        threads,
        projects,
        accessLayer,
        ServerSettings.layerTest({
          chiefOfStaff: { enabled: true, proactive: options.proactive ?? true },
        }),
        common,
      ),
    );
    const context = yield* Layer.build(
      ChiefOfStaffTriggers.layer.pipe(Layer.provide(Layer.succeedContext(dependencies))),
    );
    const config = Context.get(dependencies, ServerConfig.ServerConfig);
    const fileSystem = Context.get(dependencies, FileSystem.FileSystem);
    const path = Context.get(dependencies, Path.Path);
    const file = homeThreadsFile(config.stateDir, path);
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(
      file,
      JSON.stringify(options.homes ?? { [`home:${memberA}`]: HOME_A }),
    );

    const upsert = (input: ShellInput) =>
      Ref.update(threadsRef, (current) => [
        ...current.filter((thread) => String(thread.id) !== input.id),
        shell(input),
      ]);
    const flush = Context.get(context, ChiefOfStaffTriggers.ChiefOfStaffTriggers).flush;
    return {
      flush,
      sends,
      setThreads: (next: ReadonlyArray<OrchestrationV2ThreadShell>) => Ref.set(threadsRef, next),
      // A new thread is a baseline; only its next change is a transition.
      emitRun: (id: string) =>
        Effect.gen(function* () {
          yield* upsert({ id, status: "running" });
          yield* flush();
          yield* upsert({ id, status: "completed" });
          yield* flush();
        }),
    };
  });

const tracked = (
  threadId: string,
  status: OrchestrationV2ShellThreadStatus,
  pendingKind: "approval" | "answer" | null = null,
): ChiefOfStaffTriggers.TrackedThread => ({
  threadId,
  title: threadId,
  projectId: String(projectId),
  status,
  pendingKind,
  access: {},
});

it("reports a run that reaches a terminal status, and not one that is still running", () => {
  const previous = new Map([
    ["done", tracked("done", "running")],
    ["broken", tracked("broken", "running")],
    ["stopped", tracked("stopped", "running")],
    ["still", tracked("still", "running")],
    ["old", tracked("old", "waiting")],
  ]);
  const current = [
    tracked("done", "completed"),
    tracked("broken", "failed"),
    tracked("stopped", "interrupted"),
    tracked("still", "running"),
    tracked("old", "completed"),
  ];
  assert.deepEqual(
    ChiefOfStaffTriggers.diffTransitions(previous, current).map((transition) => ({
      threadId: transition.thread.threadId,
      kind: transition.kind,
    })),
    [
      { threadId: "done", kind: "finished" },
      { threadId: "broken", kind: "failed" },
      { threadId: "stopped", kind: "interrupted" },
    ],
  );
});

it("reports a newly waiting thread and treats an unseen thread as a baseline", () => {
  const previous = new Map<string, ChiefOfStaffTriggers.TrackedThread>([
    ["approval", tracked("approval", "running")],
    ["answer", tracked("answer", "running")],
    ["settled", tracked("settled", "running", "approval")],
  ]);
  const current = [
    tracked("approval", "running", "approval"),
    tracked("answer", "running", "answer"),
    tracked("settled", "running", "approval"),
    tracked("brand-new", "completed"),
  ];
  assert.deepEqual(
    ChiefOfStaffTriggers.diffTransitions(previous, current).map((transition) => ({
      threadId: transition.thread.threadId,
      kind: transition.kind,
    })),
    [
      { threadId: "approval", kind: "approval" },
      { threadId: "answer", kind: "answer" },
    ],
  );
  assert.deepEqual(ChiefOfStaffTriggers.diffTransitions(new Map(), current), []);
});

it.effect("is silent on the baseline, then wakes the home thread with one digest", () =>
  Effect.gen(function* () {
    const fake = yield* setup();
    yield* fake.setThreads([shell({ id: "thread-1", status: "running", title: "Build it" })]);
    yield* fake.flush();
    assert.lengthOf(fake.sends, 0);

    yield* fake.setThreads([shell({ id: "thread-1", status: "completed", title: "Build it" })]);
    yield* fake.flush();

    assert.lengthOf(fake.sends, 1);
    const send = fake.sends[0]!;
    assert.equal(String(send.threadId), HOME_A);
    assert.equal(send.createdBy, "system");
    assert.equal(send.creationSource, "server");
    assert.equal(send.mode, "queue");
    assert.deepEqual(send.attachments, []);
    assert.include(send.text, "[Chief of staff event digest: automatic]");
    assert.include(send.text, '- "Build it" (project "Pair"): finished (thread thread-1)');
    assert.include(send.text, "standing orders in MEMORY.md");
  }).pipe(Effect.scoped),
);

it.effect("sends nothing while proactive is off", () =>
  Effect.gen(function* () {
    const fake = yield* setup({ proactive: false });
    yield* fake.emitRun("thread-1");
    yield* fake.emitRun("thread-2");
    assert.lengthOf(fake.sends, 0);
  }).pipe(Effect.scoped),
);

it.effect("excludes the home thread, subagents and side chats", () =>
  Effect.gen(function* () {
    const fake = yield* setup();
    yield* fake.setThreads([
      shell({ id: HOME_A, status: "running", title: "Chief of staff" }),
      shell({
        id: "subagent-1",
        status: "running",
        title: "Subagent",
        lineage: { relationshipToParent: "subagent" },
      }),
      shell({
        id: "side-chat-1",
        status: "running",
        title: "Side chat",
        lineage: { relationshipToParent: "root", sideChat: true },
      }),
      shell({ id: "real-1", status: "running", title: "Real work" }),
    ]);
    yield* fake.flush();
    yield* fake.setThreads([
      shell({ id: HOME_A, status: "completed", title: "Chief of staff" }),
      shell({
        id: "subagent-1",
        status: "completed",
        title: "Subagent",
        lineage: { relationshipToParent: "subagent" },
      }),
      shell({
        id: "side-chat-1",
        status: "completed",
        title: "Side chat",
        lineage: { relationshipToParent: "root", sideChat: true },
      }),
      shell({ id: "real-1", status: "completed", title: "Real work" }),
    ]);
    yield* fake.flush();

    assert.lengthOf(fake.sends, 1);
    assert.include(fake.sends[0]!.text, '- "Real work"');
    assert.notInclude(fake.sends[0]!.text, "Subagent");
    assert.notInclude(fake.sends[0]!.text, "Side chat");
  }).pipe(Effect.scoped),
);

it.effect("delivers each member only the transitions on threads they can open", () =>
  Effect.gen(function* () {
    const fake = yield* setup({
      homes: { [`home:${memberA}`]: HOME_A, [`home:${memberB}`]: HOME_B },
      access: {
        ...ThreadAccess.makeTest(),
        allowsThread: (memberId, thread) => thread.ownerId === memberId,
      },
    });
    yield* fake.setThreads([
      shell({ id: "a-work", status: "running", title: "A work", ownerId: memberA }),
      shell({ id: "b-work", status: "running", title: "B work", ownerId: memberB }),
    ]);
    yield* fake.flush();
    yield* fake.setThreads([
      shell({ id: "a-work", status: "completed", title: "A work", ownerId: memberA }),
      shell({ id: "b-work", status: "completed", title: "B work", ownerId: memberB }),
    ]);
    yield* fake.flush();

    assert.lengthOf(fake.sends, 2);
    const toA = fake.sends.find((send) => String(send.threadId) === HOME_A)!;
    const toB = fake.sends.find((send) => String(send.threadId) === HOME_B)!;
    assert.include(toA.text, '- "A work"');
    assert.notInclude(toA.text, "B work");
    assert.include(toB.text, '- "B work"');
    assert.notInclude(toB.text, "A work");
  }).pipe(Effect.scoped),
);

it.effect("allows one digest every 60 seconds and counts what a cap drops", () =>
  Effect.gen(function* () {
    const fake = yield* setup();
    yield* fake.emitRun("thread-1");
    assert.lengthOf(fake.sends, 1);

    // Within the 60-second window, the digest is dropped and counted.
    yield* fake.emitRun("thread-2");
    assert.lengthOf(fake.sends, 1);

    yield* TestClock.setTime(60_000);
    yield* fake.emitRun("thread-3");
    assert.lengthOf(fake.sends, 2);
    assert.include(fake.sends[1]!.text, "1 earlier event was dropped by the rate limit");
    assert.include(fake.sends[1]!.text, '- "Thread thread-3"');
  }).pipe(Effect.scoped),
);

it.effect("caps a member at 20 digests an hour", () =>
  Effect.gen(function* () {
    const fake = yield* setup();
    for (let index = 0; index < 20; index += 1) {
      yield* TestClock.setTime(index * 60_000);
      yield* fake.emitRun(`thread-${index}`);
    }
    assert.lengthOf(fake.sends, 20);

    yield* TestClock.setTime(20 * 60_000);
    yield* fake.emitRun("thread-over-cap");
    assert.lengthOf(fake.sends, 20);
  }).pipe(Effect.scoped),
);
