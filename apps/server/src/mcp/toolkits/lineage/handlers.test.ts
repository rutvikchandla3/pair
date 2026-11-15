import { describe, expect, it } from "@effect/vitest";
import {
  BranchLineageError,
  EnvironmentId,
  MemberId,
  ProviderInstanceId,
  type ThreadBranchOffDraft,
  type ThreadBranchOffInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { BranchLineageService } from "../../../lineage/BranchLineageService.ts";
import { BranchOffService } from "../../../lineage/BranchOffService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as LineageHandlers from "./handlers.ts";
import { LineageToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:rationale");
const sourceId = ThreadId.make("thread:prompt-builder");
const hanad = MemberId.make("member:hanad");
const kousik = MemberId.make("member:kousik");

const draft = (machineOwner: MemberId, allowed = true): ThreadBranchOffDraft => ({
  allowed,
  sourceTitle: "Prompt builder",
  sourceOwnerId: kousik,
  latestTurn: { turn: 7, at: null, uncommittedFiles: 0 },
  turns: [],
  machine: { state: "ready", working: 1, ownerId: machineOwner },
  audience: [kousik, hanad],
  busy: false,
  suggestedBranch: "hanad/prompt-builder",
});

const callTool = (
  name: keyof typeof LineageToolkit.tools,
  params: Record<string, unknown>,
  services: {
    readonly lineage?: Partial<BranchLineageService["Service"]>;
    readonly branchOff?: Partial<BranchOffService["Service"]>;
  },
) =>
  Effect.gen(function* () {
    const layer = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment:lineage"),
        requestNamespace: "provider:lineage",
        thread: {
          threadId,
          providerSessionId: "provider:lineage",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), ownerId: hanad }),
      }),
      Layer.mock(BranchLineageService)(services.lineage ?? {}),
      Layer.mock(BranchOffService)(services.branchOff ?? {}),
    );
    return yield* Effect.gen(function* () {
      const toolkit = yield* LineageToolkit;
      const events = yield* toolkit
        .handle(name, params as never)
        .pipe(Stream.unwrap, Stream.runCollect);
      return events.at(-1)?.result;
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(LineageHandlers.layer).pipe(Layer.provideMerge(layer)),
      ),
    );
  });

const refused = (reason: BranchLineageError["reason"], message: string) =>
  Effect.fail(new BranchLineageError({ reason, message }));

describe("lineage tools", () => {
  it.effect("refuse what the service refuses, in its words", () =>
    Effect.gen(function* () {
      expect(
        yield* callTool(
          "t3_thread_update_from_source",
          {},
          { lineage: { updatePreview: () => refused("not-owner", "Only the branch's owner.") } },
        ),
      ).toMatchObject({ code: "invalid_request", message: "Only the branch's owner." });
      expect(
        yield* callTool(
          "t3_thread_offer_changes",
          {},
          {
            lineage: {
              offerCreate: () => refused("would-conflict", "Update from Prompt builder first."),
            },
          },
        ),
      ).toMatchObject({ code: "invalid_request", message: "Update from Prompt builder first." });
      expect(
        yield* callTool(
          "t3_thread_branch_off",
          { prompt: "Add rationale" },
          {
            branchOff: {
              draft: () => Effect.succeed({ ...draft(kousik, false), reason: "branch-of-branch" }),
            },
          },
        ),
      ).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("branch-of-branch"),
      });
    }),
  );

  it.effect("starts no merge that would conflict unless asked to resolve it", () =>
    Effect.gen(function* () {
      const updates: Array<unknown> = [];
      const lineage: Partial<BranchLineageService["Service"]> = {
        updatePreview: () =>
          Effect.succeed({
            files: [{ path: "src/app.ts", status: "conflict" as const }],
            conflicts: ["src/app.ts"],
            behind: 1,
            sourceTitle: "Prompt builder",
          }),
        update: (_caller, input, options) => {
          updates.push({ input, options });
          return Effect.succeed({
            result: "conflicted" as const,
            files: 1,
            conflicts: ["src/app.ts"],
          });
        },
      };
      expect(yield* callTool("t3_thread_update_from_source", {}, { lineage })).toMatchObject({
        outcome: "not-started",
        conflicts: ["src/app.ts"],
      });
      expect(updates).toEqual([]);
      expect(
        yield* callTool("t3_thread_update_from_source", { onConflict: "resolve" }, { lineage }),
      ).toMatchObject({ outcome: "conflicted" });
      // The branch's own agent resolves in this turn.
      expect(updates).toEqual([
        { input: { threadId, onConflict: "self" }, options: { duringOwnTurn: true } },
      ]);
    }),
  );

  it.effect("branches off onto a new machine unless the source's is the caller's own", () =>
    Effect.gen(function* () {
      const calls: Array<ThreadBranchOffInput> = [];
      const branchOff = (machineOwner: MemberId): Partial<BranchOffService["Service"]> => ({
        draft: () => Effect.succeed(draft(machineOwner)),
        branchOff: (_caller, input) => {
          calls.push(input);
          return Effect.succeed({ threadId: ThreadId.make("thread:new") });
        },
      });
      const params = {
        sourceThreadId: sourceId,
        prompt: "Add rationale",
        runsOn: "source-machine",
      };
      expect(
        yield* callTool("t3_thread_branch_off", params, { branchOff: branchOff(kousik) }),
      ).toEqual({
        threadId: ThreadId.make("thread:new"),
        runsOn: "new-machine",
      });
      expect(
        yield* callTool("t3_thread_branch_off", params, { branchOff: branchOff(hanad) }),
      ).toEqual({
        threadId: ThreadId.make("thread:new"),
        runsOn: "source-machine",
      });
      expect(calls.map((call) => [call.runsOn, call.branch])).toEqual([
        ["new-machine", "hanad/prompt-builder"],
        ["source-machine", "hanad/prompt-builder"],
      ]);
    }),
  );
});
