import {
  type Bot,
  type BotAsk,
  BotAskId,
  BotId,
  type BotJob,
  BotJobId,
  type BotNote,
  BotNoteId,
  MemberId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { BriefInput, BriefSessionInput } from "./botBrief.ts";

/** A sentence-like filler of exactly `length` characters. */
const filler = (length: number, seed = "word"): string =>
  `${seed} `.repeat(Math.ceil(length / (seed.length + 1))).slice(0, length);

const start = DateTime.makeUnsafe("2026-11-01T00:00:00.000Z");
/** An ISO time `minute` minutes into the fixture. */
export const at = (minute: number): string =>
  DateTime.formatIso(DateTime.add(start, { minutes: minute }));

const model = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "high" }],
};

const heavyBotId = BotId.make("bot:heavy");

/**
 * A bot that has run for months: 50 open jobs with long requests and many finished sessions,
 * 200 finished jobs, 200 notes, 30 open Asks, 80 projects and a long playbook. Times run from
 * `at(0)` to `at(1_000)`.
 */
export const heavyBriefInput = (): BriefInput => {
  const bot: Bot = {
    id: heavyBotId,
    ownerId: MemberId.make("member:heavy"),
    name: "Chief of staff",
    color: "#6366f1",
    shape: "round",
    voice: "crisp",
    picture: null,
    charter: filler(5_000, "charter"),
    instructions: filler(20_000, "instruction"),
    limits: ["merge", "spend-money"],
    models: { brain: model, worker: model, reviewer: model },
    homeThreadId: ThreadId.make("thread:heavy-home"),
    homeProjectId: ProjectId.make("project:heavy-home"),
    paused: false,
    lastSeenAt: null,
    nextJobNumber: 251,
    createdAt: at(0),
    updatedAt: at(10),
  };
  const jobs: Array<BotJob> = [];
  const sessions: Array<BriefSessionInput> = [];
  for (let index = 0; index < 250; index++) {
    const open = index < 50;
    const id = BotJobId.make(`job:${index}`);
    jobs.push({
      id,
      botId: heavyBotId,
      number: index + 1,
      title: `Job ${index} ${filler(60, "title")}` as BotJob["title"],
      request: filler(3_000, `request${index}`),
      projectId: ProjectId.make(`project:${index % 80}`),
      status: open ? "working" : "done",
      headline: filler(500, "headline"),
      headlineAt: at(100 + index),
      pullRequests: [
        { number: index + 1, url: `https://example.test/pr/${index + 1}`, state: "open" },
      ],
      report: open
        ? null
        : { changed: filler(2_000, "changed"), evidence: [], openQuestions: [], next: null },
      createdAt: at(index),
      updatedAt: at(100 + index),
      finishedAt: open ? null : at(400 + index),
      archivedAt: null,
    });
    if (!open) continue;
    for (let session = 0; session < 8; session++) {
      sessions.push({
        session: {
          threadId: ThreadId.make(`thread:job-${index}-session-${session}`),
          botId: heavyBotId,
          jobId: id,
          role: session % 2 === 0 ? "worker" : "reviewer",
          title: `Session ${session} for job ${index}` as BotJob["title"],
          projectId: ProjectId.make(`project:${index % 80}`),
          takenOver: false,
          createdAt: at(200 + index * 8 + session),
          modelSelection: model,
        },
        status: "idle",
        pendingRequest: null,
        lastAssistantText: filler(800, "report"),
        changedAt: at(300 + index),
      });
    }
  }
  const notes: Array<BotNote> = Array.from({ length: 200 }, (_, index) => ({
    id: BotNoteId.make(`note:${index}`),
    botId: heavyBotId,
    text: filler(400, `note${index}`) as BotNote["text"],
    source: "From Chat",
    sourceJobId: null,
    citedCount: index % 7,
    createdAt: at(index),
    updatedAt: at(index),
  }));
  const asks: Array<BotAsk> = Array.from({ length: 130 }, (_, index) => ({
    id: BotAskId.make(`ask:${index}`),
    botId: heavyBotId,
    jobId: BotJobId.make(`job:${index % 50}`),
    question: filler(600, `question${index}`) as BotAsk["question"],
    why: filler(300, "why"),
    options: [filler(300, "a"), filler(300, "b"), filler(300, "c")],
    pick: filler(300, "a"),
    status: index < 30 ? "open" : "answered",
    answerKind: index < 30 ? null : "text",
    answer: index < 30 ? null : filler(400, `answer${index}`),
    remember: false,
    noteId: null,
    homeRunId: null,
    createdAt: at(500 + index),
    answeredAt: index < 30 ? null : at(600 + index),
  }));
  return {
    bot,
    jobs,
    sessions,
    asks,
    notes,
    projects: Array.from({ length: 80 }, (_, index) => ({
      projectId: ProjectId.make(`project:${index}`),
      title: `Project ${index}`,
      workspaceRoot: `/home/user/code/${filler(60, "segment")}/project-${index}`,
    })),
    cloud: { environmentId: null, label: "this server's cloud machines" },
    now: at(1_000),
    since: null,
  };
};
