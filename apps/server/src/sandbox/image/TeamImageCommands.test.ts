import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ComputeDriverId,
  MemberId,
  RunId,
  SandboxId,
  SecretProviderId,
  type TeamImageBuildStatus,
  TeamImageBuildId,
  type TeamImageError,
  type TeamImageProposal,
  TeamImageProposalId,
  type TeamImageRecipe,
  type TeamImageRequester,
  ProjectId,
  ThreadId,
  UnknownUnionMember,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import {
  decideTeamImageCommand,
  MAX_OPEN_PROPOSALS,
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
    activeBuildId: null,
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
    openProposals: 0,
    proposal: null,
    threadHasOpenProposal: false,
    storedSecretNames: new Set(),
  };
};

const proposal: TeamImageProposal = {
  id: TeamImageProposalId.make("tip_00000000000000000001"),
  threadId: ThreadId.make("thread:one"),
  projectId: ProjectId.make("project:one"),
  baseRevision: 1,
  install: "sudo apt-get install -y postgresql-client",
  reason: "The api tests need psql",
  status: "open",
  createdAt: earlier,
  closedAt: null,
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

  it("refuses a save naming a server-held secret with no value on the server", () => {
    const save = (buildSecrets: TeamImageRecipe["buildSecrets"]): TeamImageCommand => ({
      type: "team-image.recipe.save",
      commandId,
      baseRevision: 1,
      recipe: { ...recipe, buildSecrets },
      savedBy: { kind: "member", memberId: admin },
    });
    const missing = decide(state(null), save({ NPM_TOKEN: { kind: "server" } }));
    assert.deepInclude(Result.isFailure(missing) ? missing.failure : null, {
      reason: "secret-not-set",
      message: "An admin must add NPM_TOKEN's value on the Team image page first.",
    });
    const stored = { ...state(null), storedSecretNames: new Set(["NPM_TOKEN"]) };
    decided(decide(stored, save({ NPM_TOKEN: { kind: "server" }, GH_TOKEN: secret })));
    // A newer client's kind would fail to encode into the event.
    const unknown = save({ NPM_TOKEN: new UnknownUnionMember("kind", "vault") });
    assert.strictEqual(refused(decide(stored, unknown)), "invalid-recipe");
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
      by: { kind: "member", memberId: admin },
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

  it("activates only a succeeded build whose image remains, and the active build is a no-op", () => {
    const activate: TeamImageCommand = {
      type: "team-image.build.activate",
      commandId,
      imageBuildId,
      by: admin,
    };
    const previous = TeamImageBuildId.make("tib_00000000000000000009");
    const succeeded = { ...state("succeeded"), activeBuildId: previous };
    assert.strictEqual(refused(decide(state("failed"), activate)), "wrong-state");
    const deleted = {
      ...record("succeeded"),
      build: { ...record("succeeded").build, imageDeletedAt: now },
    };
    assert.strictEqual(
      refused(decide({ ...succeeded, build: deleted }, activate)),
      "image-deleted",
    );
    assert.deepStrictEqual(
      decided(decide({ ...succeeded, activeBuildId: imageBuildId }, activate)),
      {
        events: [],
        effects: [],
      },
    );
    assert.deepStrictEqual(decided(decide(succeeded, activate)).events, [
      {
        type: "team-image.active-changed",
        activeBuildId: imageBuildId,
        previousBuildId: previous,
        by: admin,
        at: now,
      },
    ]);
  });

  it("activates a page build when it succeeds and leaves an agent's build ready", () => {
    const captured: TeamImageCommand = {
      type: "team-image.build.captured",
      commandId,
      imageBuildId,
      imageRef: "image",
      sizeBytes: 10,
    };
    const capturing = (activateOnSuccess: boolean, requestedBy: TeamImageRequester) => {
      const current = state("capturing");
      const build = { ...record("capturing").build, activateOnSuccess, requestedBy };
      return { ...current, build: { ...record("capturing"), build } };
    };
    const page = decided(decide(capturing(true, { kind: "member", memberId: admin }), captured));
    assert.deepStrictEqual(
      page.events.map((event) => event.type),
      ["team-image.build-updated", "team-image.active-changed"],
    );
    assert.deepInclude(page.events[1], { activeBuildId: imageBuildId, by: admin });
    const agent = decided(
      decide(
        capturing(false, {
          kind: "agent",
          threadId: ThreadId.make("thread-1"),
          runId: RunId.make("run-1"),
          authorIds: [admin],
        }),
        captured,
      ),
    );
    assert.deepStrictEqual(
      agent.events.map((event) => event.type),
      ["team-image.build-updated"],
    );
  });

  it("collects a succeeded image other than the active one, marking it removed at once", () => {
    const collect: TeamImageCommand = { type: "team-image.build.collect", commandId, imageBuildId };
    const succeeded = {
      ...state("succeeded"),
      build: {
        ...record("succeeded"),
        build: { ...record("succeeded").build, imageRef: "sha256:a" },
      },
    };
    assert.strictEqual(
      refused(decide({ ...succeeded, activeBuildId: imageBuildId }, collect)),
      "wrong-state",
    );
    const decision = decided(decide(succeeded, collect));
    const [event] = decision.events;
    assert(event?.type === "team-image.build-updated");
    assert.deepStrictEqual(event.build.imageDeletedAt, now);
    assert.deepStrictEqual(decision.effects, [
      {
        type: "team-image.build.delete-image",
        imageBuildId,
        driverId: ComputeDriverId.make("docker"),
        imageRef: "sha256:a",
      },
    ]);
    const removed = { ...succeeded, build: { ...succeeded.build, build: event.build } };
    assert.deepStrictEqual(decided(decide(removed, collect)).events, []);
  });

  it("refuses a step for a build that does not exist", () => {
    assert.strictEqual(
      refused(decide(state(null), { type: "team-image.build.attached", commandId, imageBuildId })),
      "not-found",
    );
  });

  describe("proposals", () => {
    const file: TeamImageCommand = {
      type: "team-image.proposal.file",
      commandId,
      proposalId: proposal.id,
      threadId: proposal.threadId,
      projectId: proposal.projectId,
      install: proposal.install,
      reason: proposal.reason,
    };
    const dismiss: TeamImageCommand = {
      type: "team-image.proposal.dismiss",
      commandId,
      proposalId: proposal.id,
    };
    const save: TeamImageCommand = {
      type: "team-image.recipe.save",
      commandId,
      baseRevision: 1,
      recipe,
      savedBy: { kind: "member", memberId: admin },
      acceptsProposalId: proposal.id,
    };

    it("files one open proposal per thread, up to 20 on the server", () => {
      assert.deepStrictEqual(decided(decide(state(null), file)).events, [
        {
          type: "team-image.proposal-updated",
          proposal: { ...proposal, createdAt: now },
        },
      ]);
      assert.strictEqual(
        refused(decide({ ...state(null), threadHasOpenProposal: true }, file)),
        "proposal-open",
      );
      assert.strictEqual(
        refused(decide({ ...state(null), openProposals: MAX_OPEN_PROPOSALS }, file)),
        "too-many-proposals",
      );
      assert.strictEqual(
        decided(decide({ ...state(null), openProposals: MAX_OPEN_PROPOSALS - 1 }, file)).events
          .length,
        1,
      );
    });

    it("records no recipe revision to file against when none exists", () => {
      const [event] = decided(decide({ ...state(null), latestRevision: null }, file)).events;
      assert(event?.type === "team-image.proposal-updated");
      assert.strictEqual(event.proposal.baseRevision, null);
    });

    it("closes a proposal as accepted in the save that accepts it, once", () => {
      const open = { ...state(null), proposal };
      const events = decided(decide(open, save)).events;
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["team-image.recipe-saved", "team-image.proposal-updated"],
      );
      const [, closed] = events;
      assert(closed?.type === "team-image.proposal-updated");
      assert.deepStrictEqual(closed.proposal, { ...proposal, status: "accepted", closedAt: now });
      for (const status of ["accepted", "dismissed"] as const) {
        assert.deepStrictEqual(
          decided(decide({ ...state(null), proposal: { ...proposal, status } }, save)).events.map(
            (event) => event.type,
          ),
          ["team-image.recipe-saved"],
        );
      }
      assert.deepStrictEqual(
        decided(decide(state(null), save)).events.map((event) => event.type),
        ["team-image.recipe-saved"],
      );
    });

    it("keeps a proposal open when its save is refused", () => {
      assert.strictEqual(
        refused(decide({ ...state(null), proposal }, { ...save, baseRevision: null })),
        "recipe-changed",
      );
    });

    it("dismisses an open proposal, and a second dismissal changes nothing", () => {
      const [event] = decided(decide({ ...state(null), proposal }, dismiss)).events;
      assert(event?.type === "team-image.proposal-updated");
      assert.deepStrictEqual(event.proposal, { ...proposal, status: "dismissed", closedAt: now });
      assert.deepStrictEqual(
        decided(decide({ ...state(null), proposal: event.proposal }, dismiss)).events,
        [],
      );
      assert.strictEqual(refused(decide(state(null), dismiss)), "not-found");
    });
  });
});
