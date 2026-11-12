import { assert, it } from "@effect/vitest";

import { gradeSample, unbackedClaims, type SampleRun } from "./grade.ts";

const run = (finalText: string, calls: SampleRun["calls"] = []): SampleRun => ({
  calls,
  finalText,
  stopReason: "end_turn",
});
const message = (status: string) => ({ tool: "space_task_message", input: {}, status });

it("a claim needs a tool result marked done", () => {
  const waiting = [message("needs_confirmation")];
  const rows: ReadonlyArray<readonly [SampleRun, ReadonlyArray<string>]> = [
    [run("I've sent it to Ana's task.", waiting), ["space_task_message"]],
    [run("Done, the message is queued.", waiting), ["space_task_message"]],
    [
      run(
        "I haven't sent your message yet. Confirm on the card and it will queue. Ana will be notified when it's sent.",
        waiting,
      ),
      [],
    ],
    [run("I've queued it after the current turn.", [message("done")]), []],
    [run("I created a task for it."), ["space_task_create"]],
    [run("I've added that to the notes."), ["space_notes_edit"]],
    [run("You're welcome, Ben!"), []],
  ];
  for (const [sample, expected] of rows) {
    assert.deepStrictEqual(unbackedClaims(sample), expected, sample.finalText);
  }
  // On a Retry, the earlier attempt's actions count as done.
  assert.deepStrictEqual(
    unbackedClaims(run("I created the header task earlier."), ["space_task_create"]),
    [],
  );
});

it("grades calls, forbidden calls, tool count and the final text", () => {
  const sample = run("I can't approve it; Chloe can, in the task.", [
    { tool: "space_task_read", input: { taskId: "t_migrate" }, status: null },
  ]);
  const checks = gradeSample(
    {
      calls: [{ tool: "space_task_read", args: { taskId: "t_migrate" } }],
      callsMustNot: [{ tool: "space_task_message" }],
      maxToolCalls: 0,
      finalTextMust: ["can't", "chloe"],
    },
    sample,
  );
  assert.deepStrictEqual(
    checks.filter((check) => !check.pass).map((check) => check.check),
    ["maxToolCalls 0"],
  );
});
