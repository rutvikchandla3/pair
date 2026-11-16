import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  MemberId,
  ProjectId,
  type ServerSettings as ServerSettingsShape,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ChiefOfStaffHost } from "./ChiefOfStaffHost.ts";
import * as ChiefOfStaffHome from "./ChiefOfStaffHome.ts";
import * as ChiefOfStaffMemory from "./ChiefOfStaffMemory.ts";
import { homeThreadsFile, readHomeThreads } from "./homeThreads.ts";
import { homeInstructions } from "./chiefOfStaffProtocol.ts";

const member = { memberId: MemberId.make("member-a"), scopes: [] };
const HOME_THREAD = ThreadId.make("thread-home");
const HOME_PROJECT = ProjectId.make("project-home");

interface SetupOptions {
  readonly storedThreadId?: string;
  /**
   * The shell for the stored thread. Omitted derives: live once the id is saved, else missing.
   * null means no thread is ever found, so `ensureHome` always creates.
   */
  readonly shell?: "live" | "archived" | "deleted" | null;
  readonly settings?: Partial<ServerSettingsShape["chiefOfStaff"]>;
}

/** One fake host, project service and launch service, like ChiefOfStaffVoice.test.ts. */
const setup = (options: SetupOptions = {}) =>
  Effect.gen(function* () {
    const saved: Array<[string, string]> = [];
    const bootstrapped: Array<ProjectService.ProjectBootstrapInput> = [];
    const launched: Array<ThreadLaunch.ThreadLaunchRequest> = [];
    const dispatches: Array<{ readonly type: string }> = [];
    const stored = yield* Ref.make<Record<string, string>>(
      options.storedThreadId === undefined
        ? {}
        : { [`home:${member.memberId}`]: options.storedThreadId },
    );

    const host = Layer.succeed(
      ChiefOfStaffHost,
      ChiefOfStaffHost.of({
        workspaceDir: Effect.succeed("/state/chief-of-staff/workspace"),
        t3Home: Effect.succeed("/state"),
        openAppServer: () => Effect.die("voice is not under test"),
        loadThreadId: (key) => Ref.get(stored).pipe(Effect.map((ids) => ids[key])),
        saveThreadId: (key, threadId) =>
          Effect.andThen(
            Ref.update(stored, (ids) => ({ ...ids, [key]: threadId })),
            Effect.sync(() => void saved.push([key, threadId])),
          ),
        statusSnapshot: () => Effect.succeed(""),
        statusChanges: Stream.empty,
      }),
    );
    const projects = Layer.mock(ProjectService.ProjectService)({
      bootstrap: (input) => {
        bootstrapped.push(input);
        return Effect.succeed({
          created: true,
          project: {
            id: HOME_PROJECT,
            title: input.title,
            workspaceRoot: input.workspaceRoot,
            repositoryIdentity: null,
            faviconPath: null,
            scripts: [],
            defaultModelSelection: input.defaultModelSelection ?? null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            deletedAt: null,
          },
        });
      },
    });
    const launches = Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) => {
        launched.push(input);
        return Effect.succeed({
          threadId: HOME_THREAD,
          projection: { thread: { id: HOME_THREAD, projectId: input.projectId }, runs: [] },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    });
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.gen(function* () {
          if (options.shell === null) return null;
          const current = (yield* Ref.get(stored))[`home:${member.memberId}`];
          if (current !== threadId) return null;
          return {
            id: threadId,
            projectId: HOME_PROJECT,
            archivedAt: options.shell === "archived" ? "2026-01-01T00:00:00Z" : null,
            deletedAt: options.shell === "deleted" ? "2026-01-01T00:00:00Z" : null,
          } as unknown as OrchestrationV2ThreadShell;
        }),
      dispatch: (command) => {
        dispatches.push(command);
        return Effect.succeed({
          sequence: dispatches.length,
          events: [],
        } as unknown as Orchestrator.OrchestratorV2DispatchResult);
      },
    });
    const instances = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: () => Effect.undefined,
    });

    const layerNode = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
    // One ServerConfig (and its temp dir) shared by Memory and the rest of the test.
    const common = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-cos-home-test-",
    }).pipe(Layer.provideMerge(layerNode));
    const dependencies = yield* Layer.build(
      Layer.mergeAll(
        host,
        projects,
        launches,
        threads,
        instances,
        ChiefOfStaffMemory.layer.pipe(Layer.provide(common)),
        ServerSettings.layerTest({ chiefOfStaff: { enabled: true, ...options.settings } }),
        common,
      ),
    );
    const context = yield* Layer.build(
      ChiefOfStaffHome.layer.pipe(Layer.provide(Layer.succeedContext(dependencies))),
    );
    return {
      home: Context.get(context, ChiefOfStaffHome.ChiefOfStaffHome),
      config: Context.get(dependencies, ServerConfig.ServerConfig),
      fileSystem: Context.get(dependencies, FileSystem.FileSystem),
      path: Context.get(dependencies, Path.Path),
      saved,
      bootstrapped,
      launched,
      dispatches,
    };
  });

it.effect("returns the stored home thread without creating anything", () =>
  Effect.gen(function* () {
    const fake = yield* setup({
      storedThreadId: HOME_THREAD,
      shell: "live",
    });
    const info = yield* fake.home.ensureHome(member);
    assert.deepEqual(info, { threadId: HOME_THREAD, projectId: HOME_PROJECT });
    assert.lengthOf(fake.bootstrapped, 0);
    assert.lengthOf(fake.launched, 0);
    assert.lengthOf(fake.dispatches, 0);
  }).pipe(Effect.scoped),
);

it.effect("unarchives the stored home thread", () =>
  Effect.gen(function* () {
    const fake = yield* setup({
      storedThreadId: HOME_THREAD,
      shell: "archived",
    });
    const info = yield* fake.home.ensureHome(member);
    assert.deepEqual(info, { threadId: HOME_THREAD, projectId: HOME_PROJECT });
    assert.deepEqual(
      fake.dispatches.map((command) => command.type),
      ["thread.unarchive"],
    );
    assert.lengthOf(fake.launched, 0);
  }).pipe(Effect.scoped),
);

it.effect("creates the home project and thread, writing the persona", () =>
  Effect.gen(function* () {
    const fake = yield* setup({ shell: null });
    const info = yield* fake.home.ensureHome(member);
    assert.equal(info.threadId, HOME_THREAD);
    assert.equal(info.projectId, HOME_PROJECT);
    assert.deepEqual(fake.saved, [[`home:${member.memberId}`, HOME_THREAD]]);
    assert.lengthOf(fake.bootstrapped, 1);
    assert.lengthOf(fake.launched, 1);

    const directory = fake.path.join(
      fake.config.stateDir,
      "chief-of-staff",
      "home",
      member.memberId,
    );
    assert.equal(
      yield* fake.fileSystem.readFileString(fake.path.join(directory, "AGENTS.md")),
      `${homeInstructions()}\n`,
    );
    assert.equal(
      yield* fake.fileSystem.readFileString(fake.path.join(directory, "CLAUDE.md")),
      "@AGENTS.md\n",
    );
    // MEMORY.md exists from turn one, before the home thread's first reply.
    assert.include(
      yield* fake.fileSystem.readFileString(fake.path.join(directory, "MEMORY.md")),
      "Generated by Chief of staff from its memory blocks",
    );
  }).pipe(Effect.scoped),
);

it.effect("creates only one home thread under concurrent calls", () =>
  Effect.gen(function* () {
    const fake = yield* setup({});
    const results = yield* Effect.all(
      [fake.home.ensureHome(member), fake.home.ensureHome(member)],
      { concurrency: "unbounded" },
    );
    assert.deepEqual(results, [
      { threadId: HOME_THREAD, projectId: HOME_PROJECT },
      { threadId: HOME_THREAD, projectId: HOME_PROJECT },
    ]);
    assert.lengthOf(fake.launched, 1);
    assert.lengthOf(fake.bootstrapped, 1);
    assert.deepEqual(fake.saved, [[`home:${member.memberId}`, HOME_THREAD]]);
  }).pipe(Effect.scoped),
);

it.effect("remembers a home thread already on disk", () =>
  Effect.gen(function* () {
    const fake = yield* setup({ storedThreadId: HOME_THREAD, shell: null });
    assert.equal(yield* fake.home.homeThreadId(member.memberId), HOME_THREAD);
    assert.equal(yield* fake.home.homeThreadId(MemberId.make("member-b")), undefined);
  }).pipe(Effect.scoped),
);

it.effect("invalidates the home-thread cache, so a new home thread is seen at once", () =>
  Effect.gen(function* () {
    const fake = yield* setup({ shell: null });
    const withServices = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.provideService(ServerConfig.ServerConfig, fake.config),
        Effect.provideService(Path.Path, fake.path),
        Effect.provideService(FileSystem.FileSystem, fake.fileSystem),
      );
    const file = homeThreadsFile(fake.config.stateDir, fake.path);
    yield* fake.fileSystem.makeDirectory(fake.path.dirname(file), { recursive: true });
    // Cache a stale map, as a request before the first ensureHome would.
    yield* fake.fileSystem.writeFileString(
      file,
      JSON.stringify({ [`home:${member.memberId}`]: "thread-stale" }),
    );
    assert.equal(
      (yield* withServices(readHomeThreads)).get("thread-stale"),
      String(member.memberId),
    );
    // A later writer changes the file while the cache is still fresh.
    yield* fake.fileSystem.writeFileString(
      file,
      JSON.stringify({ [`home:${member.memberId}`]: HOME_THREAD }),
    );
    yield* fake.home.ensureHome(member);
    const threads = yield* withServices(readHomeThreads);
    assert.equal(threads.get(String(HOME_THREAD)), String(member.memberId));
    assert.isUndefined(threads.get("thread-stale"));
  }).pipe(Effect.scoped),
);
