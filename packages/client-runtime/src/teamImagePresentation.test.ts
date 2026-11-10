import {
  ComputeDriverId,
  MemberId,
  RunId,
  TeamImageBuildId,
  ThreadId,
  type TeamImageBuild,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  teamImageBuildPresentation,
  teamImageFailureMessage,
  teamImageFinishedMessage,
  teamImageImageLine,
} from "./teamImagePresentation.ts";

const alice = MemberId.make("member-alice");
const bob = MemberId.make("member-bob");
const memberName = (id: MemberId) => (id === alice ? "Alice" : id === bob ? "Bob" : null);
const at = DateTime.makeUnsafe("2026-11-10T10:00:00Z");

const idFor = (number: number) =>
  TeamImageBuildId.make(`tib_${number.toString(16).padStart(20, "0")}`);

const build = (number: number, change: Partial<TeamImageBuild> = {}): TeamImageBuild => ({
  id: idFor(number),
  number,
  status: "succeeded",
  phase: null,
  recipeRevision: 1,
  driverId: ComputeDriverId.make("docker"),
  requestedBy: { kind: "member", memberId: alice },
  activateOnSuccess: true,
  requestedAt: at,
  startedAt: at,
  finishedAt: at,
  imageDeletedAt: null,
  ...change,
});

const agent = {
  kind: "agent",
  threadId: ThreadId.make("thread-1"),
  runId: RunId.make("run-1"),
  authorIds: [alice, bob],
} as const;

describe("teamImageBuildPresentation", () => {
  it.each([
    {
      name: "the active build",
      build: build(14),
      active: 14,
      status: "Active",
      canActivate: false,
    },
    {
      name: "an older page build",
      build: build(13),
      active: 14,
      status: "Succeeded",
      canActivate: true,
    },
    {
      name: "an agent build newer than the active one",
      build: build(15, { requestedBy: agent, activateOnSuccess: false }),
      active: 14,
      status: "Ready",
      canActivate: true,
    },
    {
      name: "an agent build older than the active one",
      build: build(12, { requestedBy: agent, activateOnSuccess: false }),
      active: 14,
      status: "Succeeded",
      canActivate: true,
    },
    {
      name: "a build whose image was removed",
      build: build(11, { imageDeletedAt: at }),
      active: 14,
      status: "Image removed",
      canActivate: false,
    },
    {
      name: "a running install",
      build: build(15, { status: "running", phase: "install" }),
      active: 14,
      status: "Building · install",
      canActivate: false,
    },
    {
      name: "a capture",
      build: build(15, { status: "capturing", phase: "manifest" }),
      active: 14,
      status: "Building · capture",
      canActivate: false,
    },
    {
      name: "a queued build",
      build: build(15, { status: "queued", phase: null }),
      active: 14,
      status: "Queued",
      canActivate: false,
    },
    {
      name: "a cancelled build",
      build: build(15, { status: "cancelled" }),
      active: 14,
      status: "Cancelled",
      canActivate: false,
    },
    {
      name: "a failed build",
      build: build(15, {
        status: "failed",
        failure: { phase: "install", detail: "x", exitCode: 100, logTail: [] },
      }),
      active: 14,
      status: "Failed",
      canActivate: false,
    },
  ])("words $name as $status", ({ build: subject, active, status, canActivate }) => {
    const presentation = teamImageBuildPresentation(subject, idFor(active), {
      memberName,
      activeBuildNumber: active,
    });
    expect(presentation.status).toBe(status);
    expect(presentation.canActivate).toBe(canActivate);
  });

  it("names who asked", () => {
    const line = (subject: TeamImageBuild) =>
      teamImageBuildPresentation(subject, null, { memberName }).requester;
    expect(line(build(1))).toBe("Alice");
    expect(line(build(2, { requestedBy: agent }))).toBe("agent, prompted by Alice, Bob");
    expect(line(build(3, { requestedBy: { ...agent, authorIds: [] } }))).toBe("agent");
    expect(
      line(build(4, { requestedBy: { kind: "member", memberId: MemberId.make("gone") } })),
    ).toBe("a member");
  });

  it("calls an agent build ready when nothing is active", () => {
    expect(
      teamImageBuildPresentation(build(1, { requestedBy: agent, activateOnSuccess: false }), null)
        .status,
    ).toBe("Ready");
  });
});

describe("teamImageFailureMessage", () => {
  it.each([
    {
      phase: "install",
      exitCode: 100,
      detail: "d",
      message: "The install script exited with 100.",
    },
    {
      phase: "install",
      detail: "The build failed during install.",
      message: "The build failed during install.",
    },
    {
      phase: "clone",
      detail: "d",
      message: "Could not clone a project. Check that the GitHub App can read it.",
    },
    { phase: "interrupted", detail: "d", message: "The server restarted during this build." },
    { phase: "timed-out", detail: "d", message: "The build ran past 45 minutes." },
    {
      phase: "leak",
      detail: "NPM_TOKEN's value was found in /home/t3/.npmrc. Use ${NPM_TOKEN} instead.",
      message: "NPM_TOKEN's value was found in /home/t3/.npmrc. Use ${NPM_TOKEN} instead.",
    },
    {
      phase: "preflight",
      detail: "A recipe project (p) no longer exists.",
      message: "A recipe project (p) no longer exists.",
    },
    { phase: "capture", detail: " ", message: "The build failed during capture." },
  ] as const)("reads a $phase failure", ({ message, ...failure }) => {
    expect(teamImageFailureMessage({ ...failure, logTail: [] })).toBe(message);
  });
});

describe("teamImageFinishedMessage", () => {
  it.each([
    { name: "a page build", subject: build(15), active: 15, message: "Build 15 is active." },
    {
      name: "an agent build",
      subject: build(15, { requestedBy: agent, activateOnSuccess: false }),
      active: 14,
      message: "Build 15 is ready. Activate it in Team image.",
    },
    {
      name: "a failed install",
      subject: build(15, {
        status: "failed",
        failure: { phase: "install", detail: "", logTail: [] },
      }),
      active: 14,
      message: "Build 15 failed at install.",
    },
    { name: "a cancel", subject: build(15, { status: "cancelled" }), active: 14, message: null },
  ])("tells $name", ({ subject, active, message }) => {
    expect(teamImageFinishedMessage(subject, idFor(active))).toBe(message);
  });
});

describe("teamImageImageLine", () => {
  it("joins the build to the base it was made on", () => {
    const manifest = {
      base: { ref: "r", digest: null, pairVersion: "0.1.7" },
      providers: [],
      repos: [],
      serverVersion: "1",
      imageEnv: {},
      sizeBytes: null,
    };
    expect(teamImageImageLine(build(14, { manifest }))).toBe("Build 14 · Pair base 0.1.7");
    expect(teamImageImageLine(build(14))).toBe("Build 14");
  });
});
