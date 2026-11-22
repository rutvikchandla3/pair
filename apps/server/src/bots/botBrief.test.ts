import { describe, expect, it } from "vite-plus/test";

import { BRIEF_TOKEN_CAP, composeBrief, estimateTokens } from "./botBrief.ts";
import { at, heavyBriefInput } from "./botFixtures.testkit.ts";

describe("composeBrief", () => {
  it("keeps a heavy bot's brief under its cap and still accounts for every open job and note", () => {
    const input = heavyBriefInput();
    const brief = composeBrief(input);

    expect(estimateTokens(JSON.stringify(brief))).toBeLessThanOrEqual(BRIEF_TOKEN_CAP);
    expect(brief.jobs.length).toBeGreaterThan(0);
    expect(brief.jobs.length + brief.otherOpenJobs.length + brief.moreJobs).toBe(50);
    expect(brief.playbook.notes.length + brief.playbook.moreNotes).toBe(200);
    expect(brief.openAsks.length + brief.moreAsks).toBe(30);
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
    expect(brief.playbook.instructions).toBeNull();
    expect(brief.projects).toBeNull();
    expect(brief.finishedJobs).toEqual([]);
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
  });
});
