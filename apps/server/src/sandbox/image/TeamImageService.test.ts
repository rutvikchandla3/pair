import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ComputeDriverId,
  type DockerSandboxDriver,
  MemberId,
  type TeamImageRecipe,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import * as TeamImageEffects from "./TeamImageEffects.ts";
import * as TeamImageService from "./TeamImageService.ts";
import * as TeamImageStore from "./TeamImageStore.ts";
import * as TeamImageWorker from "./TeamImageWorker.ts";

const docker = ComputeDriverId.make("docker");
const dockerDriver: DockerSandboxDriver = { kind: "docker", id: docker, label: "Docker" };
const admin = MemberId.make("member-owner");
const member = MemberId.make("member-plain");
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

/** The real service over SQLite; admission answers a fixed snapshot. */
const layerTest = (slots: SandboxAdmission.AdmissionSnapshot = freeSlots) =>
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
        Layer.mock(TeamImageEffects.TeamImageEffects)({}),
        ServerSettings.layerTest({ sandbox: { drivers: [dockerDriver], defaultDriverId: docker } }),
        TeamState.layerTest([memberRecord(admin, "admin"), memberRecord(member, "member")]),
        NodeCrypto.layer,
        Layer.succeed(ServerConfig.ServerConfig, {
          cloudOnly: true,
        } as ServerConfig.ServerConfig["Service"]),
      ),
    ),
    Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
    Layer.provideMerge(layerDatabase),
  );

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
