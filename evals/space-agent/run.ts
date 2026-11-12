#!/usr/bin/env node
// An eval script, not server code: it writes result files and calls the Messages API directly.
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off globalTimers:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  MemberId,
  MessageId,
  ProjectId,
  RunId,
  SpaceActionId,
  SpaceId,
  SpaceNoteId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Space,
  type SpaceAction,
  type SpaceNoteItem,
  type SpaceRoomEntry,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ProjectionStoreV2 } from "../../apps/server/src/orchestration-v2/ProjectionStore.ts";
import { SPACE_AGENT_REQUEST_OPTIONS } from "../../apps/server/src/space/SpaceAgentAdapter.ts";
import {
  SpaceAgentTools,
  SpaceContext,
  type SpaceAgentRequest,
} from "../../apps/server/src/space/SpaceAgentRuntime.ts";
import { SPACE_AGENT_TOOL_DEFINITIONS } from "../../apps/server/src/space/SpaceAgentTools.ts";
import * as SpaceContextLive from "../../apps/server/src/space/SpaceContext.ts";
import { TeamState } from "../../apps/server/src/team/TeamState.ts";
import { cases, MEMBERS, type Case } from "./cases.ts";
import { gradeSample, type SampleCall } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", multiple: true },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
    concurrency: { type: "string", default: "4" },
    budget: { type: "string", default: "10" },
    context: { type: "boolean", default: false },
  },
});
const models = values.model ?? ["claude-opus-5-5", "claude-sonnet-5-5"];
const selected = values.case
  ? cases.filter((entry) => values.case!.some((id) => entry.id.startsWith(id)))
  : cases;
if (selected.length === 0) throw new Error("No case matches --case.");

/** $ per million tokens. Cache writes: 1.25x input for 5 minutes, 2x for 1 hour. */
const PRICES: Record<
  string,
  { readonly input: number; readonly output: number; readonly cacheRead: number }
> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
};
const MAX_MODEL_CALLS = 8;

const spaceId = SpaceId.make("spc_00000000000000000ac0");
const roomThreadId = ThreadId.make("thread-room");
const triggerOf = (entry: Case) => entry.posts.at(-1)!;
const runId = RunId.make("run-pair");

/** The case's room as the projections hold it; times are relative to now. */
const world = (entry: Case, now: DateTime.Utc) => {
  const ago = (minutes: number) => DateTime.subtract(now, { minutes });
  const iso = (minutes: number) => DateTime.formatIso(ago(minutes));
  const members = MEMBERS.map((member) => MemberId.make(member.id));
  const space: Space = {
    id: spaceId,
    roomThreadId,
    name: "Data export" as Space["name"],
    brief: entry.brief as Space["brief"],
    projectId: ProjectId.make("project-acme-app"),
    ownerId: members[0]!,
    members: members.map((memberId) => ({
      memberId,
      addedBy: members[0]!,
      joinedAt: iso(60 * 24 * 7),
      removedAt: null,
    })) as unknown as Space["members"],
    joinRequests: [],
    pairBilling: { type: "team" },
    createdBy: members[0]!,
    createdAt: iso(60 * 24 * 7),
    updatedAt: iso(60),
    archivedAt: null,
    archivedBy: null,
  };
  const entries: ReadonlyArray<SpaceRoomEntry> = entry.posts.map((post) => ({
    type: "post",
    id: MessageId.make(post.id),
    spaceId,
    authorId: MemberId.make(post.author),
    authorKind: post.kind ?? "user",
    text: post.text as never,
    mentions: post.text.includes("@pair") ? [{ type: "pair" }] : [],
    pairRequested: post.text.includes("@pair"),
    createdAt: iso(post.minutesAgo),
  }));
  const shells = entry.tasks.map(
    (task) =>
      ({
        id: ThreadId.make(task.id),
        title: task.title,
        ownerId: MemberId.make(task.owner),
        latestRunId: task.state === "not-started" ? null : RunId.make(`run-${task.id}`),
        activeRunId: task.state === "working" ? RunId.make(`run-${task.id}`) : null,
        status: task.state === "done" ? "completed" : task.state === "working" ? "running" : "idle",
        pendingRuntimeRequest:
          task.state === "needs-approval" ? { kind: "command", blocking: true } : null,
        lastErrorClass: null,
        limitRecovery: null,
        linkedPullRequest: null,
        branchPullRequest: null,
        pullRequests: [],
        settledAt: null,
        deletedAt: null,
        updatedAt: ago(task.minutesAgo),
        modelSelection: { instanceId: "codex", model: "gpt-5.1-codex" },
        space: {
          kind: "task",
          spaceId,
          createdBy: MemberId.make(task.owner),
          description: task.description,
          base: { baseRef: "main" },
        },
      }) as unknown as OrchestrationV2ThreadShell,
  );
  const notes: ReadonlyArray<SpaceNoteItem> = (entry.notes ?? []).map((note) => {
    const writer =
      note.by === "pair"
        ? { type: "pair" as const, askedBy: MemberId.make("member-ana"), runId }
        : { type: "member" as const, memberId: MemberId.make(note.by) };
    return {
      id: SpaceNoteId.make(note.id),
      spaceId,
      section: note.section,
      text: note.text as never,
      sources: [
        {
          messageId: MessageId.make(note.source),
          threadId: roomThreadId,
          authorId: members[0]!,
          at: iso(120),
        },
      ],
      createdBy: writer,
      lastEditedBy: writer,
      version: 1 as never,
      createdAt: iso(120),
      updatedAt: iso(120),
    };
  });
  const trigger = triggerOf(entry);
  const actions: ReadonlyArray<SpaceAction> = (entry.actions ?? []).map((action) => ({
    id: SpaceActionId.make(`space-action:${trigger.id}:${action.key}`),
    spaceId,
    request: {
      type: "task.create",
      title: action.outcome.title as never,
      description: action.outcome.title as never,
      ownerId: MemberId.make(action.outcome.ownerId),
    },
    actorId: MemberId.make(entry.tagger),
    via: { runId, roomMessageId: MessageId.make(trigger.id) },
    state: "done",
    outcome: {
      type: "task.created",
      threadId: ThreadId.make(action.outcome.threadId),
      ownerId: MemberId.make(action.outcome.ownerId),
      title: action.outcome.title as never,
      started: true,
    },
    proposal: null,
    undo: null,
    resolvedBy: null,
    createdAt: iso(trigger.minutesAgo - 1),
    updatedAt: iso(trigger.minutesAgo - 1),
  }));
  const projections = Layer.mock(ProjectionStoreV2)({
    getSpace: () => Effect.succeed(space),
    listSpaceNotes: () => Effect.succeed(notes),
    listSpaceRoomEntries: () => Effect.succeed(entries),
    getSpaceRoomEntry: (id: MessageId) =>
      Effect.succeed(entries.find((candidate) => candidate.id === id) ?? null),
    listSpaceRoomReplies: () => Effect.succeed([]),
    listSpaceActions: () => Effect.succeed(actions),
    listSpaceTaskThreadIds: () => Effect.succeed(shells.map((shell) => shell.id)),
    getThreadShell: (id: ThreadId) =>
      Effect.succeed(shells.find((shell) => shell.id === id) ?? null),
  } as never);
  const team = Layer.effect(
    TeamState,
    Effect.map(
      Ref.make(
        new Map(
          MEMBERS.map((member) => [
            MemberId.make(member.id),
            {
              id: MemberId.make(member.id),
              name: member.name,
              role: member.role,
              gitName: null,
              gitEmail: null,
              isOwner: member.id === "member-ana",
              createdAt: iso(60 * 24 * 30),
              updatedAt: null,
              removedAt: null,
            },
          ]),
        ),
      ),
      (members) => ({ members }) as never,
    ),
  );
  const tools = Layer.succeed(SpaceAgentTools, {
    definitions: SPACE_AGENT_TOOL_DEFINITIONS,
    call: Effect.fn("SpaceAgentTools.call")(() => Effect.die("The eval mocks tool results")),
  });
  return SpaceContextLive.layer.pipe(Layer.provide(Layer.mergeAll(projections, team, tools)));
};

const assembleRequest = Effect.fn("spaceAgentEval.assemble")(function* (entry: Case) {
  const now = yield* DateTime.now;
  const context = yield* SpaceContext.pipe(Effect.provide(world(entry, now)));
  return yield* context.assemble({
    spaceId,
    roomThreadId,
    runId,
    taggerId: MemberId.make(entry.tagger),
    roomMessageId: MessageId.make(triggerOf(entry).id),
  });
});
const assemble = (entry: Case) => Effect.runPromise(assembleRequest(entry));

const estimate = (text: string) => Math.ceil(text.length / 4);
const contextReport = (request: SpaceAgentRequest) => {
  const user = request.messages[0]!;
  const blocks = typeof user.content === "string" ? [] : user.content;
  const rows: Array<readonly [string, number]> = [
    ["tools", estimate(JSON.stringify(request.tools))],
    ["instructions", estimate(request.system.map((block) => block.text).join(""))],
    ...blocks.map((block): readonly [string, number] => {
      const text = block.type === "text" ? block.text : "";
      return [/^<(\w+)/.exec(text)?.[1] ?? block.type, estimate(text)];
    }),
    ["system message", estimate(String(request.messages[1]?.content ?? ""))],
  ];
  return rows.map(([name, tokens]) => `${name.padEnd(16)} ~${tokens}`).join("\n");
};

/** Default results for tools a case doesn't mock: plausible reads, and writes that succeed. */
const defaultTool = (entry: Case, name: string, input: Record<string, unknown>): unknown => {
  switch (name) {
    case "space_task_read": {
      const task = entry.tasks.find((candidate) => candidate.id === input.taskId);
      if (task === undefined) {
        return {
          status: "refused",
          reason: "not_in_space",
          message: `${String(input.taskId)} is not a task in this space.`,
        };
      }
      const owner = MEMBERS.find((member) => member.id === task.owner)!.name;
      return {
        taskId: task.id,
        title: task.title,
        owner: task.owner,
        ownerName: owner,
        status: {
          "not-started": `Not started, waiting for ${owner}`,
          working: "Working",
          "needs-approval": `Needs ${owner}: approval`,
          done: "Done",
        }[task.state],
        description: task.description,
        pendingRequest:
          task.state === "needs-approval"
            ? {
                kind: "command",
                note: "Only people who can open the task answer it, in the task. Pair can't.",
              }
            : null,
        queue: [],
        latestTurn: null,
      };
    }
    case "space_search":
      return { hits: [] };
    case "space_message_read":
      return { messageId: input.messageId, page: 1, pages: 1, text: "(no more text)" };
    case "space_task_create":
      return { status: "done", taskId: "t_new", title: input.title, started: true };
    case "space_task_message":
      return { status: "done", note: "Queued after the task's current turn." };
    case "space_notes_edit":
      return { status: "done", note: "Shown to the room in this reply's receipt, with Undo." };
    default:
      return { status: "refused", reason: "not_allowed", message: `No tool ${name}.` };
  }
};

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}
const costOf = (model: string, usage: Usage) => {
  const price = PRICES[model] ?? PRICES["claude-opus-5-5"]!;
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * price.cacheRead +
      usage.cacheWrite5m * price.input * 1.25 +
      usage.cacheWrite1h * price.input * 2) /
    1_000_000
  );
};

const apiKey = process.env.ANTHROPIC_API_KEY;
const baseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
let spent = 0;
const budget = Number(values.budget);

interface ApiBlock {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

const callModel = async (model: string, request: SpaceAgentRequest, messages: Array<unknown>) => {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey!,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      body: JSON.stringify({
        model,
        system: request.system,
        tools: request.tools,
        messages,
        ...SPACE_AGENT_REQUEST_OPTIONS,
      }),
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
      continue;
    }
    const body = (await response.json()) as {
      content?: ReadonlyArray<ApiBlock>;
      stop_reason?: string | null;
      usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
        cache_creation?: {
          ephemeral_5m_input_tokens?: number;
          ephemeral_1h_input_tokens?: number;
        } | null;
      };
      error?: { message: string };
    };
    if (!response.ok) throw new Error(`${response.status}: ${body.error?.message ?? "error"}`);
    return body;
  }
};

const runSample = async (model: string, entry: Case, request: SpaceAgentRequest) => {
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  const messages: Array<unknown> = [...request.messages];
  const calls: Array<SampleCall> = [];
  let finalText = "";
  let stopReason: string | null = null;
  for (let index = 1; index <= MAX_MODEL_CALLS; index++) {
    const body = await callModel(model, request, messages);
    const u = body.usage!;
    usage.input += u.input_tokens;
    usage.output += u.output_tokens;
    usage.cacheRead += u.cache_read_input_tokens ?? 0;
    const oneHour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    usage.cacheWrite1h += oneHour;
    usage.cacheWrite5m += (u.cache_creation_input_tokens ?? 0) - oneHour;
    stopReason = body.stop_reason ?? null;
    const content = body.content ?? [];
    messages.push({ role: "assistant", content });
    finalText = content
      .flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []))
      .join("");
    const uses = content.filter((block) => block.type === "tool_use");
    if (stopReason !== "tool_use" || uses.length === 0) break;
    messages.push({
      role: "user",
      content: uses.map((use) => {
        const input = use.input ?? {};
        const mock = entry.tools?.[use.name!];
        const output = mock === undefined ? defaultTool(entry, use.name!, input) : mock(input);
        const status =
          typeof output === "object" && output !== null && "status" in output
            ? String(output.status)
            : null;
        calls.push({ tool: use.name!, input, status });
        return {
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify(output),
          ...(status === "refused" ? { is_error: true } : {}),
        };
      }),
    });
  }
  const cost = costOf(model, usage);
  spent += cost;
  const run = { calls, finalText, stopReason };
  const alreadyDone = (entry.actions ?? []).map(() => "space_task_create");
  const checks = gradeSample(entry.expect, run, alreadyDone);
  return {
    model,
    case: entry.id,
    pass: checks.every((check) => check.pass),
    checks,
    ...run,
    usage,
    cost,
  };
};

const main = async () => {
  const requests = new Map<string, SpaceAgentRequest>();
  for (const entry of selected) requests.set(entry.id, await assemble(entry));
  if (values.context) {
    for (const entry of selected) {
      const request = requests.get(entry.id)!;
      console.log(`# ${entry.id}\n${contextReport(request)}\n`);
      if (process.env.SPACE_EVAL_DUMP) console.log(JSON.stringify(request.messages, null, 1));
    }
    return;
  }
  if (!values.out) throw new Error("Use --out <directory> [--model <id>] [--case <id>].");
  if (!apiKey) throw new Error("Set ANTHROPIC_API_KEY in the repo root .env.");
  NodeFS.mkdirSync(values.out, { recursive: true });
  const rowsFile = NodePath.join(values.out, "results.jsonl");
  const jobs = models.flatMap((model) =>
    selected.flatMap((entry) =>
      Array.from({ length: Number(values.samples) }, () => ({ model, entry })),
    ),
  );
  const rows: Array<Awaited<ReturnType<typeof runSample>>> = [];
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (next < jobs.length && !stopped) {
      if (spent >= budget) {
        stopped = true;
        break;
      }
      const job = jobs[next++]!;
      try {
        const row = await runSample(job.model, job.entry, requests.get(job.entry.id)!);
        rows.push(row);
        NodeFS.appendFileSync(rowsFile, `${JSON.stringify(row)}\n`);
        const failed = row.checks.filter((check) => !check.pass).map((check) => check.check);
        console.log(
          `${row.pass ? "PASS" : "FAIL"} ${job.model} ${job.entry.id} $${row.cost.toFixed(3)}${failed.length === 0 ? "" : ` — ${failed.join("; ")}`}`,
        );
      } catch (error) {
        console.log(`ERROR ${job.model} ${job.entry.id}: ${String(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));

  // A case fails when half or more of its samples fail (evals/README.md).
  const lines = [
    `# space-agent run`,
    "",
    `Spent: $${spent.toFixed(2)}${stopped ? ` (stopped at the $${budget} budget; ${jobs.length - rows.length} samples not run)` : ""}`,
    "",
  ];
  for (const model of models) {
    const mine = rows.filter((row) => row.model === model);
    const byCase = selected.map((entry) => {
      const samples = mine.filter((row) => row.case === entry.id);
      const passed = samples.filter((row) => row.pass).length;
      return {
        id: entry.id,
        passed,
        total: samples.length,
        ok: samples.length > 0 && passed > samples.length / 2,
      };
    });
    const usage = mine.reduce(
      (sum, row) => ({
        input: sum.input + row.usage.input,
        cacheRead: sum.cacheRead + row.usage.cacheRead,
        cacheWrite: sum.cacheWrite + row.usage.cacheWrite5m + row.usage.cacheWrite1h,
        cost: sum.cost + row.cost,
      }),
      { input: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    );
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
    lines.push(
      `## ${model}`,
      "",
      `Cases passing: ${byCase.filter((row) => row.ok).length}/${byCase.length}. Samples passing: ${mine.filter((row) => row.pass).length}/${mine.length}. Cost $${usage.cost.toFixed(2)}, cache read ${prompt === 0 ? 0 : Math.round((usage.cacheRead / prompt) * 100)}% of prompt tokens.`,
      "",
      "| Case | Passed |",
      "| --- | --- |",
      ...byCase.map((row) => `| ${row.id} | ${row.passed}/${row.total}${row.ok ? "" : " FAIL"} |`),
      "",
    );
  }
  NodeFS.writeFileSync(NodePath.join(values.out, "summary.md"), lines.join("\n"));
  console.log(lines.join("\n"));
};

await main();
