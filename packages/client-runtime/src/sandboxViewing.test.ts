import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { INITIAL_VIEWER_LEASE, stepViewerLease } from "./sandboxViewing.ts";

const threadX = ThreadId.make("thread-x");
const NOW = 1_000_000;
const MINUTE = 60_000;

type Tick = Partial<Parameters<typeof stepViewerLease>[1]>;

const run = (ticks: ReadonlyArray<Tick>) => {
  let state = INITIAL_VIEWER_LEASE;
  const sends: Array<ThreadId | null> = [];
  for (const tick of ticks) {
    const step = stepViewerLease(state, {
      threadId: threadX,
      cloud: true,
      visible: true,
      focused: true,
      nowMs: NOW,
      ...tick,
    });
    state = step.state;
    sends.push(step.send);
  }
  return sends;
};

describe("stepViewerLease", () => {
  it.each<{ readonly name: string; readonly ticks: ReadonlyArray<Tick>; readonly sends: unknown }>([
    {
      name: "focused cloud thread sends once, then every 5 minutes",
      ticks: [
        {},
        { nowMs: NOW + MINUTE },
        { nowMs: NOW + 4 * MINUTE },
        { nowMs: NOW + 5 * MINUTE },
      ],
      sends: [threadX, null, null, threadX],
    },
    {
      name: "hidden or unfocused sends nothing",
      ticks: [{ visible: false }, { focused: false }, { visible: false, focused: false }],
      sends: [null, null, null],
    },
    {
      name: "a local thread sends nothing",
      ticks: [{ cloud: false }, { cloud: false, nowMs: NOW + 5 * MINUTE }],
      sends: [null, null],
    },
    {
      name: "forty listed cloud threads with none focused send nothing",
      ticks: Array.from({ length: 40 }, (_, index) => ({
        threadId: ThreadId.make(`thread-${index}`),
        focused: false,
      })),
      sends: Array.from({ length: 40 }, () => null),
    },
    {
      name: "coming back into focus sends at once when the last send is stale",
      ticks: [{}, { focused: false, nowMs: NOW + 6 * MINUTE }, { nowMs: NOW + 7 * MINUTE }],
      sends: [threadX, null, threadX],
    },
  ])("$name", ({ ticks, sends }) => {
    expect(run(ticks)).toEqual(sends);
  });
});
