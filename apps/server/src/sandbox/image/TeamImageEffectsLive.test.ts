import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ComputeDriverId,
  type DockerSandboxDriver,
  EnvironmentId,
  MemberId,
  type Project,
  ProjectId,
  type SandboxId,
  SecretProviderId,
  type TeamImageBuild,
  type TeamImageBuildStatus,
  type TeamImageRecipe,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import type * as Members from "../../persistence/Members.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { MemberGitHub } from "../../team/MemberGitHub.ts";
import * as TeamState from "../../team/TeamState.ts";
import { SANDBOX_ROOT, type WorkspaceHost } from "../../workspaceHost/WorkspaceHost.ts";
import { WorkspaceHosts } from "../../workspaceHost/WorkspaceHosts.ts";
import * as WorkspaceHostTesting from "../../workspaceHost/WorkspaceHostTesting.ts";
import { ComputeDriverError } from "../compute/ComputeDriver.ts";
import * as ComputeDriverTesting from "../compute/ComputeDriverTesting.ts";
import { GitHubAppInstallationTokens } from "../credentials/GitHubAppInstallationTokens.ts";
import * as SandboxAdmission from "../lifecycle/SandboxAdmission.ts";
import { SandboxBootstrapSource } from "../lifecycle/SandboxBootstrapSource.ts";
import type { RunnerConnection } from "../runnerHub/RunnerConnection.ts";
import { RunnerHub, type RunnerBoot } from "../runnerHub/RunnerHub.ts";
import * as LiveTeamImageBuild from "./LiveTeamImageBuild.ts";
import * as TeamImageBuildLog from "./TeamImageBuildLog.ts";
import { TeamImageEffects } from "./TeamImageEffects.ts";
import * as TeamImageEffectsLive from "./TeamImageEffectsLive.ts";
import * as TeamImageService from "./TeamImageService.ts";
import * as TeamImageStore from "./TeamImageStore.ts";
import {
  TEAM_IMAGE_BUILD_OUTPUT,
  TEAM_IMAGE_LEAK_MARKER,
  TEAM_IMAGE_PHASE_MARKER,
} from "./teamImageBuildProgram.ts";

const docker = ComputeDriverId.make("docker");
const dockerDriver: DockerSandboxDriver = { kind: "docker", id: docker, label: "Docker" };
const admin = MemberId.make("member-owner");
const projectId = ProjectId.make("project-web");
const recipe: TeamImageRecipe = {
  base: { type: "pair" },
  projectIds: [projectId],
  buildEnv: { NODE_ENV: "production" },
  buildSecrets: {},
  install: "npm i -g pnpm",
};

const NPM_SECRET = "npm-secret-value";
const secretRecipe: TeamImageRecipe = {
  ...recipe,
  buildSecrets: { NPM_TOKEN: { provider: SecretProviderId.make("vault"), reference: "npm" } },
};

const memberRecord: Members.MemberRecord = {
  id: admin,
  name: "Ada",
  role: "admin",
  gitName: null,
  gitEmail: null,
  isOwner: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
  removedAt: null,
};

const project: Project = {
  id: projectId,
  title: "web",
  workspaceRoot: "/work/web",
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

const buildOutput = JSON.stringify({
  pairVersion: "1.2.3",
  providers: { claudeAgent: "2.0.0", codex: "0.50.0" },
  repos: [{ projectId, path: "/t3-sandbox/.image/github.com/acme/web", headSha: "abc123" }],
  imageEnv: { PATH: "/home/t3/.local/bin:/usr/bin" },
});

interface Program {
  /** Output lines; the stream then ends with `exitCode`, or never ends when it is null. */
  readonly lines: ReadonlyArray<string>;
  readonly exitCode: number | null;
}

const phaseLine = (phase: string) => `${TEAM_IMAGE_PHASE_MARKER}${phase}`;

/** The services the effects layer reaches outside Pair's own state, each recording what it saw. */
const makeWorld = Effect.fn("TeamImageEffectsLive.test.makeWorld")(function* (input: {
  readonly program: Program;
  readonly snapshot: "succeed" | "fail";
  /** What every build secret reference reads as. */
  readonly secretValue?: string;
}) {
  const fake = yield* ComputeDriverTesting.make(docker);
  const boots = yield* Queue.unbounded<RunnerBoot>();
  const created = yield* Deferred.make<{ sandboxId: SandboxId; driverRef: string }>();
  const spawned = yield* Deferred.make<ChildProcess.StandardCommand>();
  const killed = yield* Deferred.make<void>();
  const destroyed: Array<string> = [];
  const snapshots: Array<string> = [];
  const revokedTokens: Array<SandboxId> = [];
  const revokedGrants: Array<SandboxId> = [];
  const files = new Map<string, string>([[TEAM_IMAGE_BUILD_OUTPUT, buildOutput]]);

  // The test is the backend: create, snapshot and destroy answer here.
  yield* Queue.take(fake.calls).pipe(
    Effect.flatMap((call) => {
      switch (call._tag) {
        case "create":
          return Deferred.succeed(created, {
            sandboxId: call.input.sandboxId,
            driverRef: call.input.name,
          }).pipe(
            Effect.andThen(
              Deferred.succeed(call.reply, {
                driverRef: call.input.name,
                baseImage: { ref: "ghcr.io/pair/base:1", digest: "sha256:base", version: "1" },
              }),
            ),
          );
        case "snapshot":
          snapshots.push(call.name);
          return input.snapshot === "succeed"
            ? Deferred.succeed(call.reply, { imageRef: `image:${call.name}`, sizeBytes: 2048 })
            : Deferred.fail(
                call.reply,
                new ComputeDriverError({
                  driverId: docker,
                  operation: "snapshot",
                  reason: "unavailable",
                  retryable: true,
                }),
              );
        case "destroy":
          destroyed.push(call.ref);
          return Deferred.succeed(call.reply, undefined);
        default:
          return Effect.die(new Error(`unexpected driver call ${call._tag}`));
      }
    }),
    Effect.forever,
    Effect.forkScoped,
  );

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("piped command");
      yield* Effect.addFinalizer(() => Deferred.succeed(killed, undefined));
      yield* Deferred.succeed(spawned, command);
      const output = Stream.make(...input.program.lines.map((line) => `${line}\n`)).pipe(
        Stream.encodeText,
      );
      const { exitCode } = input.program;
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(42),
        exitCode:
          exitCode === null ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: exitCode === null ? Stream.concat(output, Stream.never) : output,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const fileSystem = FileSystem.makeNoop({
    makeDirectory: () => Effect.void,
    writeFileString: (path, data) => Effect.sync(() => void files.set(path, data)),
    readFileString: (path) => Effect.sync(() => files.get(path) ?? ""),
  });

  /** As RunnerHub does: the machine's host is registered before its boot is published. */
  const boot = Effect.fn("TeamImageEffectsLive.test.boot")(function* () {
    const { sandboxId } = yield* Deferred.await(created);
    const hosts = yield* WorkspaceHosts;
    const host = {
      ...hosts.local,
      kind: "sandbox",
      info: Effect.succeed({
        platform: "linux",
        architecture: "x64",
        homeDirectory: "/home/t3",
        environment: {},
        userId: 1000,
        executablePath: "/opt/pair-runner/build/t3",
      }),
      spawner,
      fileSystem,
    } satisfies WorkspaceHost;
    yield* hosts.register(`${SANDBOX_ROOT}/${sandboxId}`, host);
    // The watcher reads only the sandbox id.
    yield* Queue.offer(boots, { sandboxId, connection: {} as RunnerConnection });
  });

  const layer = Layer.mergeAll(
    ComputeDriverTesting.layerRegistry(fake.driver),
    Layer.mock(RunnerHub)({
      boots: Stream.fromQueue(boots),
      revoke: (sandboxId) => Effect.sync(() => void revokedGrants.push(sandboxId)),
    }),
    Layer.mock(SandboxBootstrapSource)({
      forGeneration: ({ sandboxId, generation }) =>
        Effect.succeed({
          sandboxId,
          generation,
          runnerBuildId: "runner-build",
          serverUrl: "http://pair.test",
          enrollmentSecret: Redacted.make("enroll"),
        }),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("install-1")),
    }),
    Layer.mock(GitHubAppInstallationTokens)({
      configured: Effect.succeed(true),
      tokenFor: ({ repository }) =>
        Effect.succeed({
          token: Redacted.make("installation-token"),
          expiresAt: DateTime.makeUnsafe(0),
          repository,
          permissions: { contents: "read" },
        }),
      revoke: (sandboxId) => Effect.sync(() => void revokedTokens.push(sandboxId)),
    }),
    Layer.mock(MemberGitHub)({ enabled: false, credentialFor: () => Effect.succeedNone }),
    Layer.mock(SecretResolver.SecretResolver)({
      read: (references) => Effect.succeed(references.map(() => input.secretValue)),
    }),
    Layer.mock(ProjectService)({ getById: () => Effect.succeedSome(project) }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      readRemoteUrl: () => Effect.succeed("git@github.com:acme/web.git"),
    }),
  );

  return {
    layer,
    boot,
    created,
    spawned,
    killed,
    files,
    destroyed,
    snapshots,
    revokedTokens,
    revokedGrants,
  };
});

type World = Effect.Success<ReturnType<typeof makeWorld>>;

const layerStorage = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-image-effects-" });
    return { cloudOnly: true, stateDir } as ServerConfig.ServerConfig["Service"];
  }),
);

// Only team-image effects reach this worker.
const layerExecutor = Layer.effect(
  EffectWorker.OrchestrationEffectExecutorV2,
  Effect.gen(function* () {
    const effects = yield* TeamImageEffects;
    return EffectWorker.OrchestrationEffectExecutorV2.of({
      execute: (effect, options) =>
        EffectOutbox.isTeamImageEffect(effect)
          ? effects.execute(effect, options)
          : Effect.die(new Error(`unexpected effect ${effect.request.type}`)),
      reportExhausted: (effect, cause) =>
        EffectOutbox.isTeamImageEffect(effect)
          ? effects.reportExhausted(effect, cause)
          : Effect.void,
    });
  }),
);

/** The real service, store, log and worker over SQLite; the world outside is `world`. */
const layerTest = (world: World, maxAttempts = 5) =>
  EffectWorker.layerWithOptions({ maxAttempts }).pipe(
    Layer.provideMerge(layerExecutor),
    Layer.provideMerge(TeamImageEffectsLive.layer),
    Layer.provideMerge(TeamImageService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        TeamImageStore.layer,
        LiveTeamImageBuild.layer,
        TeamImageBuildLog.layer,
        EventSink.layer,
        CommandReceiptStore.layer,
        Layer.mock(SandboxAdmission.SandboxAdmission)({
          withLock: (effect) => effect,
          snapshot: () =>
            Effect.succeed({
              running: 0,
              waiting: 0,
              cap: 2,
              startAvailable: true,
              draining: false,
            }),
          takeStart: Effect.void,
        }),
        TeamState.layerTest([memberRecord]),
        NodeCrypto.layer,
        WorkspaceHostTesting.layerFromContext,
      ),
    ),
    Layer.provideMerge(world.layer),
    Layer.provideMerge(
      ServerSettings.layerTest({ sandbox: { drivers: [dockerDriver], defaultDriverId: docker } }),
    ),
    Layer.provideMerge(layerConfig),
    Layer.provideMerge(layerStorage),
    Layer.provideMerge(NodeServices.layer),
  );

const awaitStatus = Effect.fn("TeamImageEffectsLive.test.awaitStatus")(function* (
  status: TeamImageBuildStatus,
) {
  const service = yield* TeamImageService.TeamImageService;
  yield* service.changes.pipe(
    Stream.filter((snapshot) => snapshot.builds[0]?.status === status),
    Stream.runHead,
  );
});

/** Requests a build, launches it, boots its runner and starts its program. */
const startProgram = Effect.fn("TeamImageEffectsLive.test.startProgram")(function* (
  world: World,
  buildRecipe: TeamImageRecipe = recipe,
) {
  const service = yield* TeamImageService.TeamImageService;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  const { revision } = yield* service.saveRecipe({
    actorId: admin,
    input: { baseRevision: null, recipe: buildRecipe },
  });
  const build = yield* service.startBuild({ actorId: admin, input: { recipeRevision: revision } });
  yield* worker.drain();
  assert.strictEqual((yield* service.snapshot).builds[0]?.status, "launching");
  yield* world.boot();
  yield* awaitStatus("running");
  yield* worker.drain();
  return { build, machine: yield* Deferred.await(world.created) };
});

const finished = Effect.fn("TeamImageEffectsLive.test.finished")(function* (build: {
  readonly id: TeamImageBuild["id"];
}) {
  const service = yield* TeamImageService.TeamImageService;
  const store = yield* TeamImageStore.TeamImageStore;
  const record = Option.getOrThrow(yield* store.build(build.id));
  return { build: (yield* service.snapshot).builds[0], destroyedAt: record.machine.destroyedAt };
});

const succeeding: Program = {
  lines: [
    phaseLine("preflight"),
    phaseLine("clone"),
    "Cloning into web",
    phaseLine("install"),
    phaseLine("env"),
    phaseLine("verify"),
    phaseLine("clean"),
    phaseLine("manifest"),
  ],
  exitCode: 0,
};

describe("TeamImageEffectsLive", () => {
  it.effect("a requested build runs its program and succeeds with the snapshot's image", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld({ program: succeeding, snapshot: "succeed" });
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const buildLog = yield* TeamImageBuildLog.TeamImageBuildLog;
        const { build, machine } = yield* startProgram(world);
        yield* awaitStatus("capturing");
        yield* worker.drain();

        const result = yield* finished(build);
        assert.deepInclude(result.build, {
          status: "succeeded",
          imageRef: "image:t3-team-image:1",
        });
        assert.deepStrictEqual(result.build?.manifest?.base, {
          ref: "ghcr.io/pair/base:1",
          digest: "sha256:base",
          pairVersion: "1.2.3",
        });
        assert.deepStrictEqual(
          result.build?.manifest?.providers.map(({ driver, version }) => `${driver}@${version}`),
          ["claudeAgent@2.0.0", "codex@0.50.0"],
        );
        assert.deepStrictEqual(world.snapshots, ["t3-team-image:1"]);
        assert.deepStrictEqual(world.destroyed, [machine.driverRef]);
        assert.isNotNull(result.destroyedAt);
        assert.deepStrictEqual(world.revokedGrants, [machine.sandboxId]);
        assert.include(world.revokedTokens, machine.sandboxId);

        // The clone token and build env reach the program's env, never its text.
        const command = yield* Deferred.await(world.spawned);
        assert.includeMembers(Object.keys(command.options.env ?? {}), [
          "NODE_ENV",
          "T3_CLONE_TOKEN_0",
        ]);
        const script = world.files.get("/home/t3/.t3-build/t3-build.sh") ?? "";
        assert.include(script, "https://github.com/acme/web");
        assert.notInclude(script, "installation-token");
        assert.strictEqual(world.files.get("/home/t3/.t3-build/install.sh"), recipe.install);

        const log = yield* Stream.runCollect(buildLog.read(1));
        assert.deepStrictEqual(log, [{ text: "Cloning into web\n", done: true }]);
      }).pipe(Effect.provide(layerTest(world)));
    }).pipe(Effect.scoped),
  );

  it.effect("a cancel mid-program stops the program and destroys the machine", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld({
        program: { lines: [phaseLine("preflight"), "Checking the machine"], exitCode: null },
        snapshot: "succeed",
      });
      yield* Effect.gen(function* () {
        const service = yield* TeamImageService.TeamImageService;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const { build, machine } = yield* startProgram(world);
        yield* Deferred.await(world.spawned);
        yield* service.cancelBuild({ actorId: admin, imageBuildId: build.id });
        yield* Deferred.await(world.killed);
        yield* worker.drain();

        const result = yield* finished(build);
        assert.strictEqual(result.build?.status, "cancelled");
        assert.deepStrictEqual(world.snapshots, []);
        assert.deepStrictEqual(world.destroyed, [machine.driverRef]);
        assert.isNotNull(result.destroyedAt);
        assert.include(world.revokedTokens, machine.sandboxId);
      }).pipe(Effect.provide(layerTest(world)));
    }).pipe(Effect.scoped),
  );

  it.effect("a capture that keeps failing retries, then fails the build at capture", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld({ program: succeeding, snapshot: "fail" });
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const { build, machine } = yield* startProgram(world);
        yield* awaitStatus("capturing");
        yield* worker.drain();
        assert.lengthOf(world.snapshots, 1);
        assert.strictEqual((yield* finished(build)).build?.status, "capturing");

        yield* TestClock.adjust("1 second");
        yield* worker.drain();
        const result = yield* finished(build);
        assert.lengthOf(world.snapshots, 2);
        assert.strictEqual(result.build?.status, "failed");
        assert.deepInclude(result.build?.failure, {
          phase: "capture",
          detail: "Pair Cloud could not reach the build machine's driver.",
        });
        assert.deepStrictEqual(world.destroyed, [machine.driverRef]);
        assert.isNotNull(result.destroyedAt);
        assert.include(world.revokedTokens, machine.sandboxId);
      }).pipe(Effect.provide(layerTest(world, 2)));
    }).pipe(Effect.scoped),
  );

  it.effect("a leak line fails the build at leak without a value anywhere", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld({
        program: {
          lines: [
            phaseLine("preflight"),
            `npm used ${NPM_SECRET} with installation-token`,
            phaseLine("clean"),
            `${TEAM_IMAGE_LEAK_MARKER}NPM_TOKEN::/home/t3/.npmrc`,
            `${TEAM_IMAGE_LEAK_MARKER}T3_CLONE_TOKEN_0::/home/t3/.config/git/credentials`,
          ],
          exitCode: 3,
        },
        snapshot: "succeed",
        secretValue: NPM_SECRET,
      });
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const buildLog = yield* TeamImageBuildLog.TeamImageBuildLog;
        const { build, machine } = yield* startProgram(world, secretRecipe);
        yield* awaitStatus("failed");
        yield* worker.drain();

        const result = yield* finished(build);
        assert.deepStrictEqual(result.build?.failure, {
          phase: "leak",
          detail:
            "NPM_TOKEN's value was found in /home/t3/.npmrc. 1 more place leaks a secret. Use ${NPM_TOKEN} instead.",
          logTail: [
            "npm used *** with ***",
            "NPM_TOKEN's value was found in /home/t3/.npmrc.",
            "T3_CLONE_TOKEN_0's value was found in /home/t3/.config/git/credentials.",
          ],
        });
        assert.deepStrictEqual(world.snapshots, []);
        assert.deepStrictEqual(world.destroyed, [machine.driverRef]);
        const [log] = yield* Stream.runCollect(buildLog.read(1));
        assert.notInclude(log?.text, NPM_SECRET);
        assert.notInclude(log?.text, "installation-token");
      }).pipe(Effect.provide(layerTest(world)));
    }).pipe(Effect.scoped),
  );

  it.effect("an image env that holds a secret fails the build even if the program did not", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld({
        program: succeeding,
        snapshot: "succeed",
        secretValue: NPM_SECRET,
      });
      world.files.set(
        TEAM_IMAGE_BUILD_OUTPUT,
        JSON.stringify({
          ...JSON.parse(buildOutput),
          imageEnv: { REGISTRY_AUTH: `Bearer ${NPM_SECRET}` },
        }),
      );
      yield* Effect.gen(function* () {
        const { build } = yield* startProgram(world, secretRecipe);
        yield* awaitStatus("failed");

        const result = yield* finished(build);
        assert.deepInclude(result.build?.failure, {
          phase: "leak",
          detail: "NPM_TOKEN's value was found in the image environment (REGISTRY_AUTH).",
        });
        assert.deepStrictEqual(world.snapshots, []);
        assert.notInclude(JSON.stringify(result.build), NPM_SECRET);
      }).pipe(Effect.provide(layerTest(world)));
    }).pipe(Effect.scoped),
  );

  it.effect("a build secret too short to redact fails at install before the program starts", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld({
        program: succeeding,
        snapshot: "succeed",
        secretValue: "abc",
      });
      yield* Effect.gen(function* () {
        const { build } = yield* startProgram(world, secretRecipe);
        yield* awaitStatus("failed");

        const result = yield* finished(build);
        assert.deepStrictEqual(result.build?.failure, {
          phase: "install",
          detail: "NPM_TOKEN is too short to keep out of the log.",
          logTail: [],
        });
        assert.isFalse(world.files.has("/home/t3/.t3-build/t3-build.sh"));
      }).pipe(Effect.provide(layerTest(world)));
    }).pipe(Effect.scoped),
  );
});
