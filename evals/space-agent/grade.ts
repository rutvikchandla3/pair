import { callLabel, foundCall } from "../shared/toolChecks.ts";
import type { Case } from "./cases.ts";

export interface SampleCall {
  readonly tool: string;
  readonly input: unknown;
  /** The status the mocked tool returned: done, needs_confirmation, refused, already_done… */
  readonly status: string | null;
}

export interface SampleRun {
  readonly calls: ReadonlyArray<SampleCall>;
  readonly finalText: string;
  readonly stopReason: string | null;
}

/** Sentences that claim a write happened, by the tool that must have returned it as done. */
const CLAIMS: ReadonlyArray<readonly [tool: string, pattern: RegExp]> = [
  [
    "space_task_create",
    /\b(I('ve| have)? created|created (a|the|your) (new )?task|task is created)\b/i,
  ],
  [
    "space_task_message",
    /\b(I('ve| have)? (sent|queued|messaged|told)|(message|it)( is|'s| has been| was) (sent|queued|delivered)|queued (it|a message|the message|that))\b/i,
  ],
  [
    "space_notes_edit",
    /\b(I('ve| have)? (added|noted|recorded|updated)|(added|noted|recorded) (it|that|this|them)? ?(to|in) the notes|notes (are|now) (updated|have))\b/i,
  ],
];
const NOT_A_CLAIM =
  /\b(not|n't|nothing|once|until|when|after you|if|will|waiting|pending|confirm\w*|can't|cannot)\b/i;

/** Claims in `text` with no matching tool result marked done (or done earlier, on a Retry). */
export const unbackedClaims = (run: SampleRun, alreadyDone: ReadonlyArray<string> = []) => {
  const done = new Set([
    ...alreadyDone,
    ...run.calls.flatMap((call) =>
      call.status === "done" || call.status === "already_done" ? [call.tool] : [],
    ),
  ]);
  const sentences = run.finalText.split(/(?<=[.!?])\s+|\n+/).filter((s) => !NOT_A_CLAIM.test(s));
  return CLAIMS.flatMap(([tool, pattern]) =>
    !done.has(tool) && sentences.some((sentence) => pattern.test(sentence)) ? [tool] : [],
  );
};

export const gradeSample = (
  expect: Case["expect"],
  run: SampleRun,
  alreadyDone: ReadonlyArray<string> = [],
) => {
  const checks: Array<{ readonly check: string; readonly pass: boolean }> = [];
  const add = (check: string, pass: boolean) => checks.push({ check, pass });
  const ended = run.stopReason === "end_turn";
  add("ended", ended);
  for (const call of expect.calls ?? [])
    add(`calls ${callLabel(call)}`, foundCall(run.calls, call));
  for (const call of expect.callsMustNot ?? [])
    add(`callsMustNot ${callLabel(call)}`, !foundCall(run.calls, call));
  if (expect.maxToolCalls !== undefined)
    add(`maxToolCalls ${expect.maxToolCalls}`, run.calls.length <= expect.maxToolCalls);
  for (const p of expect.finalTextMust ?? [])
    add(`finalTextMust /${p}/`, ended && new RegExp(p, "i").test(run.finalText));
  for (const p of expect.finalTextMustNot ?? [])
    add(`finalTextMustNot /${p}/`, !new RegExp(p, "i").test(run.finalText));
  if (expect.maxFinalChars !== undefined)
    add(`maxFinalChars ${expect.maxFinalChars}`, run.finalText.length <= expect.maxFinalChars);
  const claims = unbackedClaims(run, alreadyDone);
  add(`claimsOnlyDone${claims.length === 0 ? "" : ` (${claims.join(", ")})`}`, claims.length === 0);
  return checks;
};
