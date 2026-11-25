import { it as effectIt } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";

import * as ProjectService from "../project/ProjectService.ts";
import { BRIEF_TOKEN_CAP, composeBrief, estimateTokens, loadBrief } from "./botBrief.ts";
import { at, heavyBriefInput } from "./botFixtures.testkit.ts";
import { BotSessions } from "./BotSessions.ts";
import { BotService } from "./BotService.ts";

describe("composeBrief", () => {
  it("keeps a heavy bot's brief under its cap and still accounts for every open job and note", () => {
    const input = heavyBriefInput();
    const brief = composeBrief(input);

    expect(estimateTokens(JSON.stringify(brief))).toBeLessThanOrEqual(BRIEF_TOKEN_CAP);
    // Instructions saved under the editor's limit arrive whole; older, longer ones say they were cut.
    expect(brief.playbook.instructions).toContain(input.bot.instructions.slice(0, 16_000));
    expect(brief.playbook.instructions).toMatch(/ask the user for the rest\.\]$/);
    expect(brief.jobs.length).toBeGreaterThan(0);
    expect(brief.jobs.length + brief.otherOpenJobs.length + brief.moreJobs).toBe(50);
    expect(brief.playbook.notes.length + brief.playbook.moreNotes).toBe(200);
    expect(brief.openAsks.length + brief.moreAsks).toBe(30);
    // An answered Ask leaves openAsks but its answer stays, newest first.
    expect(brief.recentAnswers.map((answer) => answer.askId)).toEqual([
      "ask:129",
      "ask:128",
      "ask:127",
      "ask:126",
      "ask:125",
    ]);
    // Most recently changed first, and the most cited notes first.
    expect(brief.jobs[0]?.jobId).toBe("job:49");
    expect(brief.playbook.notes[0]?.citedCount).toBe(6);
  });

  it("with since, lists only what changed after it, and a session's last text only then", () => {
    const input = heavyBriefInput();
    const sessions = input.sessions.map((entry) =>
      entry.session.threadId === "thread:job-3-session-7"
        ? { ...entry, changedAt: at(2_000) }
        : entry.session.threadId === "thread:job-3-session-6"
          ? { ...entry, status: "working", changedAt: at(2_000) }
          : entry,
    );
    const notes = input.notes.map((note) =>
      note.id === "note:5" ? { ...note, updatedAt: at(2_000) } : note,
    );
    const brief = composeBrief({ ...input, sessions, notes, since: at(1_500) });

    expect(brief.since).toBe(at(1_500));
    // The bot's own fields change only with a whole brief; its limits always come.
    expect(brief.bot).toBeNull();
    expect(brief.playbook.checkWithMeBefore.length).toBe(2);
    expect(brief.playbook.instructions).toBeNull();
    expect(brief.projects).toBeNull();
    expect(brief.finishedJobs).toEqual([]);
    expect(brief.recentAnswers).toEqual([]);
    expect(brief.playbook.notes.map((note) => note.noteId)).toEqual(["note:5"]);
    expect(brief.jobs.map((job) => job.jobId)).toEqual(["job:3"]);
    expect(
      brief.jobs[0]?.sessions.map((session) => [session.threadId, session.lastAssistantText]),
    ).toEqual([
      ["thread:job-3-session-7", expect.stringMatching(/^report /)],
      // Still working: its last text is progress, not a report.
      ["thread:job-3-session-6", null],
    ]);
    // Open Asks are always listed: they wait on the user.
    expect(brief.openAsks.length + brief.moreAsks).toBe(30);

    // A changed bot (say a note the user deleted) gets the whole brief: a diff can't show removals.
    const changedBot = { ...input.bot, updatedAt: at(2_000) };
    const whole = composeBrief({ ...input, bot: changedBot, since: at(1_500) });
    expect(whole.since).toBeNull();
    expect(whole.bot?.name).toBe("Chief of staff");
    expect(whole).toEqual(composeBrief({ ...input, bot: changedBot, since: null }));
  });
});

effectIt.effect("shows a change stamped before a brief's reads but committed after them", () => {
  const input = heavyBriefInput();
  const job = input.jobs[0]!;
  let snapshotJobs = [job];
  const layer = Layer.mergeAll(
    Layer.mock(BotService)({
      snapshotForBot: () =>
        Effect.sync(
          () =>
            ({ bots: [input.bot], jobs: snapshotJobs, sessions: [], asks: [], notes: [] }) as never,
        ),
      listAllBots: () => Effect.succeed([input.bot]),
    }),
    Layer.mock(BotSessions)({ cloudTarget: () => Effect.succeed(null) }),
    Layer.mock(ProjectService.ProjectService)({ listShells: () => Effect.succeed([]) }),
  );
  return Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(at(2_000))));
    const first = yield* loadBrief(input.bot.id, { since: null });
    // The writer stamped it a second before that brief, and it committed after the brief read.
    snapshotJobs = [{ ...job, headline: "Moved on", updatedAt: at(2_000 - 1 / 60) }];
    const next = yield* loadBrief(input.bot.id, { since: first.asOf });
    expect(next.jobs.map((entry) => entry.headline)).toEqual(["Moved on"]);
  }).pipe(Effect.provide(layer));
});
