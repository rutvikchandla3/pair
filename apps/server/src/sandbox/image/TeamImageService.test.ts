import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ComputeDriverId,
  type DockerSandboxDriver,
  MemberId,
  ProjectId,
  RunId,
  SandboxId,
  SecretProviderId,
  type TeamImageBuildId,
  type TeamImageError,
  TeamImageBuildId as TeamImageBuildIdSchema,
  type TeamImageRecipe,
  type TeamImageRequester,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import type * as Members from "../../persistence/Members.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TeamState from "../../team/TeamState.ts";
import {
  ComputeDriverNotConfiguredError,
  ComputeDriverRegistry,
} from "../compute/ComputeDriverRegistry.ts";
import * as FakeComputeDriver from "../compute/ComputeDriverTesting.ts";
import * as SandboxAdmission from "../lifecycle/SandboxAdmission.ts";
import * as LiveTeamImageBuild from "./LiveTeamImageBuild.ts";
import * as TeamImageBuildLog from "./TeamImageBuildLog.ts";
import * as TeamImageBuildSecrets from "./TeamImageBuildSecrets.ts";
import * as TeamImageService from "./TeamImageService.ts";
import * as TeamImageStore from "./TeamImageStore.ts";
import * as TeamImageWorker from "./TeamImageWorker.ts";

const docker = ComputeDriverId.make("docker");
const dockerDriver: DockerSandboxDriver = { kind: "docker", id: docker, label: "Docker" };
const admin = MemberId.make("member-owner");
const member = MemberId.make("member-plain");
const secondAdmin = MemberId.make("member-second-admin");
const recipe: TeamImageRecipe = {
  base: { type: "pair" },
  projectIds: [],
  buildEnv: {},
  buildSecrets: {},
  install: "npm i -g pnpm",
};

const agentOf = (...authorIds: ReadonlyArray<MemberId>): TeamImageRequester => ({
  kind: "agent",
  threadId: ThreadId.make("thread-agent"),
  runId: RunId.make("run-agent"),
  authorIds,
});

const memberRecord = (id: MemberId, role: "admin" | "member"): Members.MemberRecord => ({
  id,
  name: id,
  role,
  gitName: null,
  gitEmail: null,
  isOwner: role === "admin",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
  removedAt: null,
});

const freeSlots: SandboxAdmission.AdmissionSnapshot = {
  running: 0,
  waiting: 0,
  cap: 2,
  startAvailable: true,
  draining: false,
};

const layerDatabase = SqlitePersistence.layerMemory;

const layerSettings = ServerSettings.layerTest({
  sandbox: { drivers: [dockerDriver], defaultDriverId: docker },
});

// A driver that never resolves its base: the snapshot falls back to this server's own image.
const layerUnresolvedDrivers = Layer.mock(ComputeDriverRegistry)({
  get: (driverId) => Effect.fail(new ComputeDriverNotConfiguredError({ driverId })),
});

/** The real service; admission answers a fixed snapshot. Each build is a fresh process. */
const layerService = (
  slots: SandboxAdmission.AdmissionSnapshot = freeSlots,
  drivers: Layer.Layer<
    ComputeDriverRegistry,
    never,
    ServerSettings.ServerSettingsService
  > = layerUnresolvedDrivers,
) =>
  TeamImageService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        TeamImageStore.layer,
        LiveTeamImageBuild.layer,
        EventSink.layer,
        CommandReceiptStore.layer,
        Layer.mock(SandboxAdmission.SandboxAdmission)({
          withLock: (effect) => effect,
          snapshot: () => Effect.succeed(slots),
          takeStart: Effect.void,
        }),
        Layer.mock(TeamImageBuildLog.TeamImageBuildLog)({}),
        drivers.pipe(Layer.provide(layerSettings)),
        layerSettings,
        TeamState.layerTest([
          memberRecord(admin, "admin"),
          memberRecord(member, "member"),
          memberRecord(secondAdmin, "admin"),
        ]),
        NodeCrypto.layer,
        ServerSecretStore.layerMemory(),
        Layer.succeed(ServerConfig.ServerConfig, {
          cloudOnly: true,
        } as ServerConfig.ServerConfig["Service"]),
      ),
    ),
  );

const layerStorage = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(layerDatabase),
);

/** The service over its own SQLite database. */
const layerTest = (
  slots: SandboxAdmission.AdmissionSnapshot = freeSlots,
  drivers?: Layer.Layer<ComputeDriverRegistry, never, ServerSettings.ServerSettingsService>,
) => layerService(slots, drivers).pipe(Layer.provideMerge(layerStorage));

const saveFirstRecipe = Effect.gen(function* () {
  const service = yield* TeamImageService.TeamImageService;
  return yield* service.saveRecipe({
    by: { kind: "member", memberId: admin },
    input: { baseRevision: null, recipe },
  });
});

it.effect("the snapshot names the base a rebuild would use, reading the driver once", () =>
  Effect.gen(function* () {
    const { driver, calls } = yield* FakeComputeDriver.make(docker);
    const baseImage = {
      ref: "ghcr.io/pair/t3-sandbox:9.9.9",
      digest: "sha256:new",
      version: "9.9.9",
    };
    const fallback = yield* Effect.gen(function* () {
      const service = yield* TeamImageService.TeamImageService;
      return (yield* service.snapshot).currentBase;
    }).pipe(Effect.provide(layerTest()));
    assert.isNull(fallback?.digest);
    assert.isNotNull(fallback?.version);

    const bases = yield* Effect.gen(function* () {
      const service = yield* TeamImageService.TeamImageService;
      const reading = yield* Effect.forkChild(service.snapshot);
      const health = yield* Queue.take(calls);
      if (health._tag !== "health") return yield* Effect.die(`Expected health, got ${health._tag}`);
      yield* Deferred.succeed(health.reply, {
        isolation: "container",
        privateNetworkBlock: { applied: true },
        baseImage,
      });
      const first = (yield* Fiber.join(reading)).currentBase;
      // A second health read would wait on a reply nobody sends.
      return [first, (yield* service.snapshot).currentBase];
    }).pipe(Effect.provide(layerTest(freeSlots, FakeComputeDriver.layerRegistry(driver))));
    assert.deepStrictEqual(bases, [baseImage, baseImage]);
  }),
);

it.effect("a replayed command id returns its first receipt", () =>
  Effect.gen(function* () {
    const service = yield* TeamImageService.TeamImageService;
    const save = (commandId: string, baseRevision: number | null) =>
      service.dispatch({
        type: "team-image.recipe.save",
        commandId: CommandId.make(commandId),
        baseRevision,
        recipe,
        savedBy: { kind: "member", memberId: admin },
      });

    assert.lengthOf(yield* save("save:first", null), 1);
    // Applied again, this save would conflict; its receipt says it was accepted.
    assert.deepStrictEqual(yield* save("save:first", null), []);

    const refused = yield* save("save:stale", 5).pipe(Effect.flip);
    // Applied again, this save would succeed; its receipt says it was refused.
    const replayed = yield* save("save:stale", 1).pipe(Effect.flip);
    assert.deepStrictEqual(replayed, refused);
    assert.deepInclude(replayed, { _tag: "TeamImageError", reason: "recipe-changed" });
    assert.strictEqual((yield* service.snapshot).recipe?.revision, 1);
  }).pipe(Effect.provide(layerTest())),
);

it.effect(
  "a member, or an agent run with a member among its authors, cannot change the recipe",
  () =>
    Effect.gen(function* () {
      const service = yield* TeamImageService.TeamImageService;
      for (const by of [
        { kind: "member", memberId: member },
        agentOf(admin, member),
        agentOf(),
      ] satisfies ReadonlyArray<TeamImageRequester>) {
        const error = yield* service
          .saveRecipe({ by, input: { baseRevision: null, recipe } })
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "not-admin");
      }
      assert.isNull((yield* service.snapshot).recipe);
    }).pipe(Effect.provide(layerTest())),
);

it.effect("an agent replaces only the install script, and its build waits for an admin", () =>
  Effect.gen(function* () {
    const service = yield* TeamImageService.TeamImageService;
    const full: TeamImageRecipe = {
      ...recipe,
      projectIds: [ProjectId.make("project-1")],
      buildEnv: { NODE_ENV: "production" },
      buildSecrets: {
        NPM_TOKEN: { provider: SecretProviderId.make("vault"), reference: "team/npm" },
      },
    };
    yield* service.saveRecipe({
      by: { kind: "member", memberId: admin },
      input: { baseRevision: null, recipe: full },
    });
    const agent = agentOf(admin, secondAdmin);
    const saved = yield* service.saveInstall({
      by: agent,
      baseRevision: 1,
      install: "sudo apt-get install -y postgresql",
    });
    assert.deepStrictEqual(saved.recipe, {
      ...full,
      install: "sudo apt-get install -y postgresql",
    });
    assert.deepStrictEqual(saved.savedBy, agent);

    const stale = yield* service
      .saveInstall({ by: agent, baseRevision: 1, install: "true" })
      .pipe(Effect.flip);
    assert.strictEqual(stale.reason, "recipe-changed");

    const build = yield* service.startBuild({
      by: agent,
      input: { recipeRevision: 2 },
      activateOnSuccess: true,
    });
    assert.deepInclude(build, { requestedBy: agent, activateOnSuccess: false });
  }).pipe(Effect.provide(layerTest())),
);

const NPM_SECRET = "npm-secret-value";

/** Every row of every table, so a test can say a value is nowhere in the database. */
const databaseText = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `;
  const rows = yield* Effect.forEach(tables, ({ name }) =>
    sql.unsafe(`SELECT * FROM "${name.replaceAll('"', '""')}"`),
  );
  return JSON.stringify(rows, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
});

it.effect("an admin keeps a build secret's value on the server, and only its name leaves", () =>
  Effect.gen(function* () {
    const service = yield* TeamImageService.TeamImageService;
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const name = "NPM_TOKEN";
    const set = (actorId: MemberId, value: string) =>
      service.setBuildSecret({ actorId, name, value: Redacted.make(value) });
    const withSecret: TeamImageRecipe = {
      ...recipe,
      buildSecrets: { NPM_TOKEN: { kind: "server" } },
    };
    const save = (baseRevision: number | null, saved: TeamImageRecipe) =>
      service.saveRecipe({
        by: { kind: "member", memberId: admin },
        input: { baseRevision, recipe: saved },
      });
    const errors: Array<unknown> = [];
    const refused = <A>(effect: Effect.Effect<A, TeamImageError>) =>
      effect.pipe(
        Effect.flip,
        Effect.tap((error) => Effect.sync(() => errors.push(error))),
      );
    const adminView = service.changes({ withStoredSecrets: true }).pipe(Stream.runHead);

    const first = yield* refused(save(null, withSecret));
    assert.deepInclude(first, {
      reason: "secret-not-set",
      message: "An admin must add NPM_TOKEN's value on the Team image page first.",
    });
    assert.strictEqual((yield* refused(set(member, NPM_SECRET))).reason, "not-admin");
    assert.strictEqual((yield* refused(set(admin, " abc\n"))).reason, "invalid-recipe");
    assert.strictEqual(
      (yield* refused(
        service.setBuildSecret({
          actorId: admin,
          name: "T3CODE_HOME",
          value: Redacted.make(NPM_SECRET),
        }),
      )).reason,
      "invalid-recipe",
    );
    assert.deepStrictEqual(Option.getOrNull(yield* adminView)?.storedSecrets, []);

    yield* set(admin, `old-${NPM_SECRET}`);
    yield* set(admin, `${NPM_SECRET}\n`);
    assert.deepStrictEqual(
      Object.entries(yield* TeamImageBuildSecrets.read(secretStore)).map(([key, { value }]) => [
        key,
        value,
      ]),
      [["NPM_TOKEN", NPM_SECRET]],
    );
    assert.strictEqual((yield* save(null, withSecret)).revision, 1);
    assert.deepStrictEqual(
      Option.getOrNull(yield* adminView)?.storedSecrets?.map((stored) => stored.name),
      ["NPM_TOKEN"],
    );
    assert.notProperty(yield* service.snapshot, "storedSecrets");

    const inUse = yield* refused(service.removeBuildSecret({ actorId: admin, name }));
    assert.deepInclude(inUse, {
      reason: "wrong-state",
      message: "The saved recipe still uses NPM_TOKEN. Remove it from the recipe and save first.",
    });
    assert.strictEqual(
      (yield* refused(service.removeBuildSecret({ actorId: member, name }))).reason,
      "not-admin",
    );

    const snapshots = [yield* service.snapshot, Option.getOrNull(yield* adminView)];
    const database = yield* databaseText;
    for (const text of [JSON.stringify(snapshots), JSON.stringify(errors), database]) {
      assert.notInclude(text, NPM_SECRET);
    }
    assert.include(database, "NPM_TOKEN");

    yield* save(1, recipe);
    yield* service.removeBuildSecret({ actorId: admin, name });
    assert.deepStrictEqual(Option.getOrNull(yield* adminView)?.storedSecrets, []);
    // A restored revision that names it is refused until an admin adds the value again.
    const restored = yield* refused(save(2, withSecret));
    assert.strictEqual(restored.reason, "secret-not-set");
  }).pipe(Effect.provide(layerTest())),
);

it.effect("an agent's install change is refused while a kept build secret has no value", () =>
  Effect.gen(function* () {
    const service = yield* TeamImageService.TeamImageService;
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    yield* service.setBuildSecret({
      actorId: admin,
      name: "NPM_TOKEN",
      value: Redacted.make(NPM_SECRET),
    });
    yield* service.saveRecipe({
      by: { kind: "member", memberId: admin },
      input: {
        baseRevision: null,
        recipe: { ...recipe, buildSecrets: { NPM_TOKEN: { kind: "server" } } },
      },
    });
    // The value is lost outside Pair, as a wiped secrets directory would lose it.
    yield* TeamImageBuildSecrets.write(secretStore, {});
    const error = yield* service
      .saveInstall({ by: agentOf(admin), baseRevision: 1, install: "true" })
      .pipe(Effect.flip);
    assert.deepInclude(error, {
      reason: "secret-not-set",
      message: "An admin must add NPM_TOKEN's value on the Team image page first.",
    });
  }).pipe(Effect.provide(layerTest())),
);

it.effect("a proposal waits in the snapshot until an admin saves it or dismisses it", () =>
  Effect.gen(function* () {
    const service = yield* TeamImageService.TeamImageService;
    const file = (threadId: string) =>
      service.fileProposal({
        threadId: ThreadId.make(threadId),
        projectId: ProjectId.make("project-1"),
        install: "sudo apt-get install -y postgresql-client",
        reason: "The api tests need psql",
      });
    const first = yield* file("thread-a");
    const second = yield* file("thread-b");
    assert.strictEqual(first.baseRevision, null);
    assert.deepStrictEqual(
      (yield* service.snapshot).proposals.map(({ id }) => id),
      [second.id, first.id],
    );
    assert.strictEqual((yield* file("thread-a").pipe(Effect.flip)).reason, "proposal-open");
    assert.isNull((yield* service.snapshot).recipe);

    const dismissedBy = (actorId: MemberId) =>
      service.dismissProposal({ actorId, proposalId: second.id });
    assert.strictEqual((yield* dismissedBy(member).pipe(Effect.flip)).reason, "not-admin");
    yield* dismissedBy(admin);
    yield* dismissedBy(secondAdmin);
    assert.deepStrictEqual(
      (yield* service.snapshot).proposals.map(({ id }) => id),
      [first.id],
    );
    // A dismissed thread may file again.
    const refiled = yield* file("thread-b");
    assert.strictEqual(refiled.status, "open");

    yield* service.saveRecipe({
      by: { kind: "member", memberId: admin },
      input: {
        baseRevision: null,
        recipe: { ...recipe, install: first.install },
        acceptsProposalId: first.id,
      },
    });
    const after = yield* service.snapshot;
    assert.deepStrictEqual(
      after.proposals.map(({ id }) => id),
      [refiled.id],
    );
    // The proposal is the thread's again to file, now against the saved revision.
    assert.strictEqual((yield* file("thread-a")).baseRevision, 1);
  }).pipe(Effect.provide(layerTest())),
);

it.effect("a build at the cap is refused", () =>
  Effect.gen(function* () {
    const { revision } = yield* saveFirstRecipe;
    const service = yield* TeamImageService.TeamImageService;
    const error = yield* service
      .startBuild({
        by: { kind: "member", memberId: admin },
        input: { recipeRevision: revision },
        activateOnSuccess: true,
      })
      .pipe(Effect.flip);
    assert.strictEqual(error.reason, "no-capacity");
    assert.deepStrictEqual((yield* service.snapshot).builds, []);
  }).pipe(Effect.provide(layerTest({ ...freeSlots, running: 1, waiting: 1 }))),
);

it.effect("a build while draining is refused", () =>
  Effect.gen(function* () {
    const { revision } = yield* saveFirstRecipe;
    const service = yield* TeamImageService.TeamImageService;
    const error = yield* service
      .startBuild({
        by: { kind: "member", memberId: admin },
        input: { recipeRevision: revision },
        activateOnSuccess: true,
      })
      .pipe(Effect.flip);
    assert.strictEqual(error.reason, "draining");
  }).pipe(Effect.provide(layerTest({ ...freeSlots, draining: true }))),
);

it.effect("the live build follows a build until it times out", () =>
  Effect.gen(function* () {
    const { revision } = yield* saveFirstRecipe;
    const service = yield* TeamImageService.TeamImageService;
    const liveBuild = yield* LiveTeamImageBuild.LiveTeamImageBuild;
    const sweep = yield* TeamImageWorker.makeSweep;

    const build = yield* service.startBuild({
      by: { kind: "member", memberId: admin },
      input: { recipeRevision: revision },
      activateOnSuccess: true,
    });
    assert.deepInclude(build, { number: 1, status: "queued", driverId: docker });
    assert.deepStrictEqual(yield* liveBuild.current, { imageBuildId: build.id, driverId: docker });
    const second = yield* service
      .startBuild({
        by: { kind: "member", memberId: admin },
        input: { recipeRevision: revision },
        activateOnSuccess: true,
      })
      .pipe(Effect.flip);
    assert.strictEqual(second.reason, "build-running");

    yield* TestClock.adjust("44 minutes");
    yield* sweep();
    assert.strictEqual((yield* service.snapshot).builds[0]?.status, "queued");

    yield* TestClock.adjust("1 minute");
    yield* sweep();
    const [timedOut] = (yield* service.snapshot).builds;
    assert.strictEqual(timedOut?.status, "failed");
    assert.strictEqual(timedOut?.failure?.phase, "timed-out");
    assert.isNull(yield* liveBuild.current);

    const cancel = yield* service
      .cancelBuild({ by: { kind: "member", memberId: admin }, imageBuildId: build.id })
      .pipe(Effect.flip);
    assert.strictEqual(cancel.reason, "wrong-state");
  }).pipe(Effect.provide(layerTest())),
);

it.effect("a restart fails a running build as interrupted", () =>
  Effect.gen(function* () {
    const imageBuildId = yield* Effect.gen(function* () {
      const { revision } = yield* saveFirstRecipe;
      const service = yield* TeamImageService.TeamImageService;
      const build = yield* service.startBuild({
        by: { kind: "member", memberId: admin },
        input: { recipeRevision: revision },
        activateOnSuccess: true,
      });
      yield* service.dispatch({
        type: "team-image.build.attached",
        commandId: CommandId.make("attached"),
        imageBuildId: build.id,
      });
      assert.strictEqual((yield* service.snapshot).builds[0]?.status, "running");
      return build.id;
    }).pipe(Effect.provide(layerService()));

    const restarted = yield* Effect.gen(function* () {
      const service = yield* TeamImageService.TeamImageService;
      const liveBuild = yield* LiveTeamImageBuild.LiveTeamImageBuild;
      return { build: (yield* service.snapshot).builds[0], live: yield* liveBuild.current };
    }).pipe(Effect.provide(layerService()));
    assert.strictEqual(restarted.build?.id, imageBuildId);
    assert.strictEqual(restarted.build?.status, "failed");
    assert.deepInclude(restarted.build?.failure, {
      phase: "interrupted",
      detail: "Pair Cloud restarted during this build.",
    });
    assert.isNull(restarted.live);
  }).pipe(Effect.provide(layerStorage)),
);

const manifest = {
  base: { ref: "pair:1", digest: null, pairVersion: "1" },
  providers: [],
  repos: [],
  serverVersion: "1",
  imageEnv: {},
  sizeBytes: null,
};

/** Drives a requested build through its program and capture, as the effects would. */
const succeed = (imageBuildId: TeamImageBuildId) =>
  Effect.gen(function* () {
    const service = yield* TeamImageService.TeamImageService;
    const step = (name: string) => CommandId.make(`${name}:${imageBuildId}`);
    yield* service.dispatch({
      type: "team-image.build.attached",
      commandId: step("attached"),
      imageBuildId,
    });
    yield* service.dispatch({
      type: "team-image.build.program-finished",
      commandId: step("program-finished"),
      imageBuildId,
      manifest,
    });
    yield* service.dispatch({
      type: "team-image.build.captured",
      commandId: step("captured"),
      imageBuildId,
      imageRef: `sha256:${imageBuildId}`,
      sizeBytes: 1,
    });
  });

it.effect("a page build goes live when it succeeds, and activating an older one rolls back", () =>
  Effect.gen(function* () {
    const { revision } = yield* saveFirstRecipe;
    const service = yield* TeamImageService.TeamImageService;
    const first = yield* service.startBuild({
      by: { kind: "member", memberId: admin },
      input: { recipeRevision: revision },
      activateOnSuccess: true,
    });
    yield* succeed(first.id);
    assert.strictEqual((yield* service.snapshot).activeBuildId, first.id);
    const second = yield* service.startBuild({
      by: { kind: "member", memberId: admin },
      input: { recipeRevision: revision },
      activateOnSuccess: true,
    });
    yield* succeed(second.id);
    assert.strictEqual((yield* service.snapshot).activeBuildId, second.id);

    const notAdmin = yield* service
      .activateBuild({ actorId: member, imageBuildId: first.id })
      .pipe(Effect.flip);
    assert.strictEqual(notAdmin.reason, "not-admin");
    yield* service.activateBuild({ actorId: admin, imageBuildId: first.id });
    assert.strictEqual((yield* service.snapshot).activeBuildId, first.id);
  }).pipe(Effect.provide(layerTest())),
);

it.effect("a finished build is announced to its member, or to its agent run's admin authors", () =>
  Effect.gen(function* () {
    const { revision } = yield* saveFirstRecipe;
    const service = yield* TeamImageService.TeamImageService;
    const announced = yield* service.buildFinished.pipe(
      Stream.take(2),
      Stream.runCollect,
      Effect.forkScoped({ startImmediately: true }),
    );

    const memberBuild = yield* service.startBuild({
      by: { kind: "member", memberId: admin },
      input: { recipeRevision: revision },
      activateOnSuccess: true,
    });
    yield* service.dispatch({
      type: "team-image.build.fail",
      commandId: CommandId.make("fail:member"),
      imageBuildId: memberBuild.id,
      failure: { phase: "install", detail: "exit 1", logTail: [] },
    });

    const agentBuild = TeamImageBuildIdSchema.make("tib_00000000000000000a9e");
    yield* service.dispatch({
      type: "team-image.build.request",
      commandId: CommandId.make("request:agent"),
      imageBuildId: agentBuild,
      machineSandboxId: SandboxId.make("sbx_00000000000000000a9e"),
      recipeRevision: revision,
      driverId: docker,
      // `member` was an admin when the run asked; a demoted author no longer hears of it.
      requestedBy: {
        kind: "agent",
        threadId: ThreadId.make("thread-agent"),
        runId: RunId.make("run-agent"),
        authorIds: [admin, member, secondAdmin],
      },
      activateOnSuccess: false,
    });
    yield* service.cancelBuild({
      by: { kind: "member", memberId: admin },
      imageBuildId: agentBuild,
    });

    const [memberFinished, agentFinished] = yield* Fiber.join(announced);
    assert.deepStrictEqual(
      [memberFinished?.build.status, memberFinished?.recipients],
      ["failed", [admin]],
    );
    assert.deepStrictEqual(
      [agentFinished?.build.status, agentFinished?.recipients],
      ["cancelled", [secondAdmin]],
    );
  }).pipe(Effect.provide(layerTest())),
);
