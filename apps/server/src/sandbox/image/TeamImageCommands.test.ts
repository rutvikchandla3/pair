import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ComputeDriverId,
  MemberId,
  SandboxId,
  SecretProviderId,
  type TeamImageBuildStatus,
  TeamImageBuildId,
  type TeamImageError,
  type TeamImageRecipe,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import {
  decideTeamImageCommand,
  type TeamImageBuildRecord,
  type TeamImageCommand,
  type TeamImageDecision,
  type TeamImageState,
} from "./TeamImageCommands.ts";

const now = DateTime.makeUnsafe("2026-11-10T00:00:00.000Z");
const earlier = DateTime.makeUnsafe("2026-11-09T00:00:00.000Z");
const admin = MemberId.make("member-admin");
const imageBuildId = TeamImageBuildId.make("tib_00000000000000000001");
const commandId = CommandId.make("command:test");
const recipe: TeamImageRecipe = {
  base: { type: "pair" },
  projectIds: [],
  buildEnv: {},
  buildSecrets: {},
  install: "",
};
const secret = { provider: SecretProviderId.make("vault"), reference: "npm" };
const manifest = {
  base: { ref: "pair:1", digest: null, pairVersion: "1" },
  providers: [],
  repos: [],
  serverVersion: "1",
  imageEnv: {},
  sizeBytes: null,
};

const record = (status: TeamImageBuildStatus): TeamImageBuildRecord => ({
  build: {
    id: imageBuildId,
    number: 3,
    status,
    phase: status === "queued" ? null : "launch",
    recipeRevision: 1,
    driverId: ComputeDriverId.make("docker"),
    requestedBy: { kind: "member", memberId: admin },
    activateOnSuccess: false,
    requestedAt: earlier,
    startedAt: status === "queued" ? null : earlier,
    finishedAt: null,
    imageDeletedAt: null,
  },
  machine: {
    sandboxId: SandboxId.make("sbx_00000000000000000001"),
    driverRef: null,
    destroyedAt: null,
  },
});

const state = (status: TeamImageBuildStatus | null): TeamImageState => {
  const build = status === null ? null : record(status);
  return {
    latestRevision: 1,
    nextBuildNumber: 4,
    liveBuild:
      build !== null &&
      (status === "queued" ||
        status === "launching" ||
        status === "running" ||
        status === "capturing")
        ? build
        : null,
    build,
  };
};

const decide = (current: TeamImageState, command: TeamImageCommand) =>
  decideTeamImageCommand(current, command, now);

const decided = (result: Result.Result<TeamImageDecision, TeamImageError>) => {
  if (Result.isFailure(result)) assert.fail(result.failure.message);
  return result.success;
};

const refused = (result: Result.Result<TeamImageDecision, TeamImageError>) => {
  if (Result.isSuccess(result)) assert.fail("expected a refusal");
  return result.failure.reason;
};

const ended = { phase: "install", detail: "exit 1", logTail: [] } as const;

/** Each step with the only statuses it applies from. */
const steps: ReadonlyArray<{
  readonly command: TeamImageCommand;
  readonly from: ReadonlyArray<TeamImageBuildStatus>;
}> = [
  {
    command: { type: "team-image.build.launched", commandId, imageBuildId, driverRef: "ref" },
    from: ["queued", "running"],
  },
  {
    command: { type: "team-image.build.attached", commandId, imageBuildId },
    from: ["queued", "launching"],
  },
  {
    command: { type: "team-image.build.phase", commandId, imageBuildId, phase: "install" },
    from: ["running"],
  },
  {
    command: { type: "team-image.build.program-finished", commandId, imageBuildId, manifest },
    from: ["running"],
  },
  {
    command: {
      type: "team-image.build.captured",
      commandId,
      imageBuildId,
      imageRef: "image",
      sizeBytes: 10,
    },
    from: ["capturing"],
  },
  {
    command: { type: "team-image.build.fail", commandId, imageBuildId, failure: ended },
    from: ["queued", "launching", "running", "capturing"],
  },
];

const statuses: ReadonlyArray<TeamImageBuildStatus> = [
  "queued",
  "launching",
  "running",
  "capturing",
  "succeeded",
  "failed",
  "cancelled",
];

describe("decideTeamImageCommand", () => {
  it("refuses a save over a revision someone else saved", () => {
    const save = (baseRevision: number | null): TeamImageCommand => ({
      type: "team-image.recipe.save",
      commandId,
      baseRevision,
      recipe,
      savedBy: { kind: "member", memberId: admin },
    });
    assert.strictEqual(refused(decide(state(null), save(null))), "recipe-changed");
    for (const name of ["HOME", "PATH", "T3CODE_HOME", "T3_CLONE_TOKEN_0"]) {
      for (const field of ["buildEnv", "buildSecrets"] as const) {
        const reserved: TeamImageCommand = {
          type: "team-image.recipe.save",
          commandId,
          baseRevision: 1,
          savedBy: { kind: "member", memberId: admin },
          recipe: { ...recipe, [field]: { [name]: field === "buildEnv" ? "x" : secret } },
        };
        assert.strictEqual(refused(decide(state(null), reserved)), "invalid-recipe");
      }
    }
    assert.deepStrictEqual(decided(decide(state(null), save(1))).events, [
      {
        type: "team-image.recipe-saved",
        revision: {
          revision: 2,
          recipe,
          savedAt: now,
          savedBy: { kind: "member", memberId: admin },
        },
      },
    ]);
  });

  it("requests a build only when no build is live and the revision exists", () => {
    const request = (recipeRevision: number): TeamImageCommand => ({
      type: "team-image.build.request",
      commandId,
      imageBuildId: TeamImageBuildId.make("tib_00000000000000000002"),
      machineSandboxId: SandboxId.make("sbx_00000000000000000002"),
      recipeRevision,
      driverId: ComputeDriverId.make("docker"),
      requestedBy: { kind: "member", memberId: admin },
      activateOnSuccess: false,
    });
    assert.strictEqual(refused(decide(state(null), request(2))), "not-found");
    assert.strictEqual(refused(decide(state("capturing"), request(1))), "build-running");
    const queued = decided(decide(state("succeeded"), request(1)));
    const [event] = queued.events;
    assert(event?.type === "team-image.build-updated");
    assert.deepInclude(event.build, { number: 4, status: "queued", requestedAt: now });
    assert.deepStrictEqual(queued.effects, [
      {
        type: "team-image.build.launch",
        imageBuildId: TeamImageBuildId.make("tib_00000000000000000002"),
      },
    ]);
  });

  it("applies each step only from the status before it", () => {
    for (const { command, from } of steps) {
      for (const status of statuses) {
        const decision = decided(decide(state(status), command));
        assert.strictEqual(
          decision.events.length > 0,
          from.includes(status),
          `${command.type} from ${status}`,
        );
      }
    }
  });

  it("records the driver ref of a build whose runner said hello first", () => {
    const [event] = decided(
      decide(state("running"), {
        type: "team-image.build.launched",
        commandId,
        imageBuildId,
        driverRef: "ref",
      }),
    ).events;
    assert(event?.type === "team-image.build-updated");
    assert.strictEqual(event.build.status, "running");
    assert.strictEqual(event.machine.driverRef, "ref");
  });

  it("only moves the phase forward", () => {
    const phase = decided(
      decide(state("running"), {
        type: "team-image.build.phase",
        commandId,
        imageBuildId,
        phase: "launch",
      }),
    );
    assert.deepStrictEqual(phase.events, []);
  });

  it("ends a live build on fail or cancel, cancelling its unsettled effects", () => {
    const fail: TeamImageCommand = {
      type: "team-image.build.fail",
      commandId,
      imageBuildId,
      failure: ended,
    };
    const cancel: TeamImageCommand = {
      type: "team-image.build.cancel",
      commandId,
      imageBuildId,
      by: admin,
    };
    for (const [command, status] of [
      [fail, "failed"],
      [cancel, "cancelled"],
    ] as const) {
      const decision = decided(decide(state("running"), command));
      const [event] = decision.events;
      assert(event?.type === "team-image.build-updated");
      assert.deepInclude(event.build, { status, finishedAt: now });
      assert.deepStrictEqual(decision.effects, [
        { type: "team-image.build.destroy-machine", imageBuildId },
      ]);
      assert.deepStrictEqual(decision.cancelUnsettledEffects, {
        effectTypes: [
          "team-image.build.launch",
          "team-image.build.run-program",
          "team-image.build.capture",
        ],
        reason: "Build 3 ended.",
      });
    }
    assert.strictEqual(refused(decide(state("succeeded"), cancel)), "wrong-state");
    assert.deepStrictEqual(decided(decide(state("cancelled"), fail)).events, []);
  });

  it("records a destroyed machine once", () => {
    const destroyed: TeamImageCommand = {
      type: "team-image.build.machine-destroyed",
      commandId,
      imageBuildId,
    };
    const [event] = decided(decide(state("failed"), destroyed)).events;
    assert(event?.type === "team-image.build-updated");
    assert.deepStrictEqual(event.machine.destroyedAt, now);
    const done = { ...state("failed"), build: { ...record("failed"), machine: event.machine } };
    assert.deepStrictEqual(decided(decide(done, destroyed)).events, []);
  });

  it("refuses a step for a build that does not exist", () => {
    assert.strictEqual(
      refused(decide(state(null), { type: "team-image.build.attached", commandId, imageBuildId })),
      "not-found",
    );
  });
});
