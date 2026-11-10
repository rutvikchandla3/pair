import { describe, expect, it } from "@effect/vitest";
import {
  type AuthMcpClientAccess,
  ComputeDriverId,
  EnvironmentId,
  GuestMessageId,
  MemberId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  ProviderInstanceId,
  RunId,
  SandboxId,
  ScheduledTaskId,
  type TeamImageBuild,
  TeamImageBuildId,
  TeamImageProposalId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import type * as Members from "../../../persistence/Members.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as TeamImageAuthority from "../../../sandbox/image/TeamImageAuthority.ts";
import * as TeamImageService from "../../../sandbox/image/TeamImageService.ts";
import * as TeamState from "../../../team/TeamState.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as SandboxImageHandlers from "./handlers.ts";
import { SandboxImageToolkit } from "./tools.ts";

const EPOCH = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const environmentId = EnvironmentId.make("environment:team-image");
const threadId = ThreadId.make("thread:team-image");
const runId = RunId.make("run:mcp-test");
const ada = MemberId.make("member-ada");
const bob = MemberId.make("member-bob");
const cy = MemberId.make("member-cy");
const dee = MemberId.make("member-dee");

const record = (
  id: MemberId,
  name: string,
  role: "admin" | "member",
  removed = false,
): Members.MemberRecord => ({
  id,
  name,
  role,
  gitName: null,
  gitEmail: null,
  isOwner: id === ada,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
  removedAt: removed ? "2026-02-01T00:00:00.000Z" : null,
});

const message = (
  id: string,
  fields: Partial<OrchestrationV2ConversationMessage>,
): OrchestrationV2ConversationMessage => ({
  createdBy: "user",
  creationSource: "web",
  id: MessageId.make(id),
  threadId,
  runId,
  nodeId: null,
  role: "user",
  text: id,
  attachments: [],
  streaming: false,
  createdAt: EPOCH,
  updatedAt: EPOCH,
  ...fields,
});

const running: TeamImageBuild = {
  id: TeamImageBuildId.make("tib_00000000000000000003"),
  number: 3,
  status: "running",
  phase: "install",
  recipeRevision: 2,
  driverId: ComputeDriverId.make("docker"),
  requestedBy: { kind: "member", memberId: ada },
  activateOnSuccess: true,
  requestedAt: EPOCH,
  startedAt: EPOCH,
  finishedAt: null,
  imageDeletedAt: null,
};

type Caller =
  | { readonly thread: ReadonlyArray<OrchestrationV2ConversationMessage> | "idle" }
  | { readonly client: AuthMcpClientAccess; readonly memberId: MemberId };

interface Calls {
  saveInstall: Array<Parameters<TeamImageService.TeamImageService["Service"]["saveInstall"]>[0]>;
  startBuild: Array<Parameters<TeamImageService.TeamImageService["Service"]["startBuild"]>[0]>;
  cancelBuild: Array<Parameters<TeamImageService.TeamImageService["Service"]["cancelBuild"]>[0]>;
  fileProposal: Array<Parameters<TeamImageService.TeamImageService["Service"]["fileProposal"]>[0]>;
}

const callTool = (
  caller: Caller,
  name: keyof typeof SandboxImageToolkit.tools,
  params: Record<string, unknown>,
  options: { readonly localThread?: true } = {},
) =>
  Effect.gen(function* () {
    const calls: Calls = { saveInstall: [], startBuild: [], cancelBuild: [], fileProposal: [] };
    const messages = "thread" in caller && caller.thread !== "idle" ? caller.thread : [];
    const services = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:team-image",
        thread:
          "thread" in caller
            ? {
                threadId,
                providerSessionId: "provider:team-image",
                providerInstanceId: ProviderInstanceId.make("codex"),
              }
            : undefined,
        client:
          "client" in caller
            ? {
                sessionId: "client:team-image",
                memberId: caller.memberId,
                label: "Outside client",
                access: caller.client,
              }
            : undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed({
            ...liveThreadShell(id),
            ...(options.localThread === undefined
              ? { sandboxId: SandboxId.make("sbx_00000000000000000009") }
              : {}),
          }),
      }),
      TeamImageAuthority.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            TeamState.layerTest([
              record(ada, "Ada", "admin"),
              record(bob, "Bob", "member"),
              record(cy, "Cy", "admin"),
              record(dee, "Dee", "admin", true),
            ]),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadShell: (id) =>
                Effect.succeed(
                  liveThreadShell(id, {
                    activeRunId: "thread" in caller && caller.thread === "idle" ? null : runId,
                  }),
                ),
              listRunUserMessages: () => Effect.succeed(messages),
            }),
          ),
        ),
      ),
      Layer.mock(TeamImageService.TeamImageService)({
        snapshot: Effect.succeed({
          recipe: null,
          activeBuildId: null,
          builds: [running],
          proposals: [],
          keepSucceeded: 5,
        }),
        readBuildLog: () => Effect.succeed({ build: running, text: "one\ntwo\nthree\nfour\n" }),
        saveInstall: (input) => {
          calls.saveInstall.push(input);
          return Effect.succeed({
            revision: 3,
            recipe: {
              base: { type: "pair" },
              projectIds: [],
              buildEnv: {},
              buildSecrets: {},
              install: input.install,
            },
            savedAt: EPOCH,
            savedBy: input.by,
          });
        },
        startBuild: (input) => {
          calls.startBuild.push(input);
          return Effect.succeed({ ...running, number: 4, requestedBy: input.by });
        },
        cancelBuild: (input) => {
          calls.cancelBuild.push(input);
          return Effect.void;
        },
        fileProposal: (input) => {
          calls.fileProposal.push(input);
          return Effect.succeed({
            ...input,
            id: TeamImageProposalId.make("tip_00000000000000000001"),
            baseRevision: 2,
            status: "open",
            createdAt: EPOCH,
            closedAt: null,
          });
        },
      }),
      Layer.mock(ProjectService.ProjectService)({}),
    );
    const result = yield* Effect.gen(function* () {
      const toolkit = yield* SandboxImageToolkit;
      const events = yield* toolkit
        .handle(name, params as never)
        .pipe(Stream.unwrap, Stream.runCollect);
      return events.at(-1)?.result;
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(SandboxImageHandlers.layer).pipe(
          Layer.provideMerge(services),
        ),
      ),
    );
    return { result, calls };
  });

const prompt = (authorId: MemberId) => message("prompt", { authorId });
const steer = (authorId: MemberId) => message("steer", { authorId });
const notAdmin = (text: string) => ({ _tag: "TeamImageError", reason: "not-admin", message: text });

describe("who may change the team image", () => {
  const rows: ReadonlyArray<{
    readonly name: string;
    readonly caller: Caller;
    readonly allowed?: { readonly by: unknown };
    readonly refused?: unknown;
  }> = [
    {
      name: "a run written only by admins",
      caller: { thread: [prompt(ada), steer(cy)] },
      allowed: { by: { kind: "agent", threadId, runId, authorIds: [ada, cy] } },
    },
    {
      name: "a member's run",
      caller: { thread: [prompt(bob)] },
      refused: notAdmin(
        "Bob is not an admin, so this turn cannot change the team image. Ask an admin to make the change, or propose it with t3_team_image_propose.",
      ),
    },
    {
      name: "an admin's run a member steered",
      caller: { thread: [prompt(ada), steer(bob)] },
      refused: { reason: "not-admin", message: expect.stringContaining("Bob is not an admin") },
    },
    {
      name: "a run with a guest's message",
      caller: {
        thread: [
          prompt(ada),
          message("guest", {
            authorId: ada,
            context: {
              version: 1,
              guest: { guestMessageId: GuestMessageId.make("guest:1"), name: "Eve", text: "hi" },
              records: [],
            },
          }),
        ],
      },
      refused: { reason: "not-admin", message: expect.stringContaining("A guest wrote") },
    },
    {
      name: "a scheduled run, which no person wrote",
      caller: {
        thread: [message("prompt", { scheduledTaskId: ScheduledTaskId.make("task:nightly") })],
      },
      refused: { reason: "not-admin", message: expect.stringContaining("No admin wrote") },
    },
    {
      name: "a run by an admin who has since been removed",
      caller: { thread: [prompt(dee)] },
      refused: { reason: "not-admin", message: expect.stringContaining("Dee is not an admin") },
    },
    {
      name: "a thread with no running turn",
      caller: { thread: "idle" },
      refused: notAdmin("Only a running turn can change the team image."),
    },
    {
      name: "an admin's full-access client",
      caller: { client: "full-access", memberId: ada },
      allowed: { by: { kind: "member", memberId: ada } },
    },
    {
      name: "a member's full-access client",
      caller: { client: "full-access", memberId: bob },
      refused: { reason: "not-admin", message: expect.stringContaining("Bob is not an admin") },
    },
    {
      name: "an admin's read-only client",
      caller: { client: "read-only", memberId: ada },
      refused: { _tag: "OrchestratorMcpFailure", code: "capability_denied" },
    },
  ];

  it.effect.each(rows)("$name", (row) =>
    Effect.gen(function* () {
      const { result, calls } = yield* callTool(row.caller, "t3_team_image_recipe_update", {
        install: "sudo apt-get install -y postgresql-client",
        baseRevision: 2,
      });
      if (row.allowed !== undefined) {
        expect(result).toEqual({ revision: 3 });
        expect(calls.saveInstall).toEqual([
          {
            by: row.allowed.by,
            baseRevision: 2,
            install: "sudo apt-get install -y postgresql-client",
          },
        ]);
      } else {
        expect(result).toMatchObject(row.refused as object);
        expect(calls.saveInstall).toEqual([]);
      }
    }),
  );
});

describe("team image tools", () => {
  const membersRun: Caller = { thread: [prompt(bob)] };
  const adminsRun: Caller = { thread: [prompt(ada)] };

  it.effect("a member's run can read the image and a build's log", () =>
    Effect.gen(function* () {
      const read = yield* callTool(membersRun, "t3_team_image_read", {});
      expect(read.result).toMatchObject({
        recipe: null,
        builds: [{ build: 3, status: "running" }],
      });
      const log = yield* callTool(membersRun, "t3_team_image_build_log", { build: 3, tail: 2 });
      expect(log.result).toEqual({
        build: 3,
        status: "running",
        totalLines: 4,
        from: 3,
        text: "three\nfour",
      });
    }),
  );

  it.effect("each change refuses a member's run without calling the service", () =>
    Effect.gen(function* () {
      for (const [name, params] of [
        ["t3_team_image_build_start", { recipeRevision: 2 }],
        ["t3_team_image_build_cancel", { build: 3 }],
      ] as const) {
        const { result, calls } = yield* callTool(membersRun, name, params);
        expect(result).toMatchObject({ reason: "not-admin" });
        expect(calls).toEqual({
          saveInstall: [],
          startBuild: [],
          cancelBuild: [],
          fileProposal: [],
        });
      }
    }),
  );

  it.effect("an agent's build records its run and waits for an admin to activate it", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* callTool(adminsRun, "t3_team_image_build_start", {
        recipeRevision: 2,
      });
      expect(result).toMatchObject({ build: 4 });
      expect(calls.startBuild).toEqual([
        {
          by: { kind: "agent", threadId, runId, authorIds: [ada] },
          input: { recipeRevision: 2 },
          activateOnSuccess: false,
        },
      ]);
    }),
  );

  it.effect("cancel finds the running build by its number", () =>
    Effect.gen(function* () {
      const { calls } = yield* callTool(adminsRun, "t3_team_image_build_cancel", { build: 3 });
      expect(calls.cancelBuild).toEqual([
        { by: { kind: "agent", threadId, runId, authorIds: [ada] }, imageBuildId: running.id },
      ]);
      const missing = yield* callTool(adminsRun, "t3_team_image_build_cancel", { build: 9 });
      expect(missing.result).toMatchObject({ reason: "not-found" });
    }),
  );

  it.effect("any cloud session's run files a proposal against its own thread and project", () =>
    Effect.gen(function* () {
      const params = { install: "sudo apt-get install -y postgresql-client", reason: "psql" };
      for (const caller of [membersRun, adminsRun, { thread: "idle" as const }]) {
        const { result, calls } = yield* callTool(caller, "t3_team_image_propose", params);
        expect(result).toEqual({ note: "Proposed. An admin will see it in Team image." });
        expect(calls.fileProposal).toEqual([
          { threadId, projectId: liveThreadShell(threadId).projectId, ...params },
        ]);
      }
    }),
  );

  it.effect("a local thread, and a caller that is no thread, cannot propose", () =>
    Effect.gen(function* () {
      const params = { install: "true", reason: "psql" };
      const local = yield* callTool(membersRun, "t3_team_image_propose", params, {
        localThread: true,
      });
      expect(local.result).toMatchObject({ _tag: "TeamImageError", reason: "not-available" });
      const client = yield* callTool(
        { client: "full-access", memberId: bob },
        "t3_team_image_propose",
        params,
      );
      expect(client.result).toMatchObject({ _tag: "OrchestratorMcpFailure" });
      expect([...local.calls.fileProposal, ...client.calls.fileProposal]).toEqual([]);
    }),
  );
});
