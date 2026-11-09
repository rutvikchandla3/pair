import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ComputeDriverId,
  type DockerSandboxDriver,
  MemberId,
  RunId,
  SandboxId,
  type TeamImageBuildId,
  TeamImageBuildId as TeamImageBuildIdSchema,
  type TeamImageRecipe,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import type * as Members from "../../persistence/Members.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TeamState from "../../team/TeamState.ts";
import * as SandboxAdmission from "../lifecycle/SandboxAdmission.ts";
import * as LiveTeamImageBuild from "./LiveTeamImageBuild.ts";
import * as TeamImageBuildLog from "./TeamImageBuildLog.ts";
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

/** The real service; admission answers a fixed snapshot. Each build is a fresh process. */
const layerService = (slots: SandboxAdmission.AdmissionSnapshot = freeSlots) =>
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
        ServerSettings.layerTest({ sandbox: { drivers: [dockerDriver], defaultDriverId: docker } }),
        TeamState.layerTest([
          memberRecord(admin, "admin"),
          memberRecord(member, "member"),
          memberRecord(secondAdmin, "admin"),
        ]),
        NodeCrypto.layer,
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
const layerTest = (slots: SandboxAdmission.AdmissionSnapshot = freeSlots) =>
  layerService(slots).pipe(Layer.provideMerge(layerStorage));

const saveFirstRecipe = Effect.gen(function* () {
  const service = yield* TeamImageService.TeamImageService;
  return yield* service.saveRecipe({ actorId: admin, input: { baseRevision: null, recipe } });
});

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

it.effect("a member who is not an admin cannot change the recipe", () =>
  Effect.gen(function* () {
    const service = yield* TeamImageService.TeamImageService;
    const error = yield* service
      .saveRecipe({ actorId: member, input: { baseRevision: null, recipe } })
      .pipe(Effect.flip);
    assert.strictEqual(error.reason, "not-admin");
    assert.isNull((yield* service.snapshot).recipe);
  }).pipe(Effect.provide(layerTest())),
);

it.effect("a build at the cap is refused", () =>
  Effect.gen(function* () {
    const { revision } = yield* saveFirstRecipe;
    const service = yield* TeamImageService.TeamImageService;
    const error = yield* service
      .startBuild({ actorId: admin, input: { recipeRevision: revision } })
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
      .startBuild({ actorId: admin, input: { recipeRevision: revision } })
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
      actorId: admin,
      input: { recipeRevision: revision },
    });
    assert.deepInclude(build, { number: 1, status: "queued", driverId: docker });
    assert.deepStrictEqual(yield* liveBuild.current, { imageBuildId: build.id, driverId: docker });
    const second = yield* service
      .startBuild({ actorId: admin, input: { recipeRevision: revision } })
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
      .cancelBuild({ actorId: admin, imageBuildId: build.id })
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
        actorId: admin,
        input: { recipeRevision: revision },
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
      actorId: admin,
      input: { recipeRevision: revision },
    });
    yield* succeed(first.id);
    assert.strictEqual((yield* service.snapshot).activeBuildId, first.id);
    const second = yield* service.startBuild({
      actorId: admin,
      input: { recipeRevision: revision },
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
      actorId: admin,
      input: { recipeRevision: revision },
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
    yield* service.cancelBuild({ actorId: admin, imageBuildId: agentBuild });

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
