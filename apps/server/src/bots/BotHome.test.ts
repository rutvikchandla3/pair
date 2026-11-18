import { describe, expect, it } from "@effect/vitest";
import { type BotId, BotId as BotIdValue } from "@t3tools/contracts";

import type { BotWake } from "./BotService.ts";
import {
  formatWakeText,
  initialWakeState,
  splitWakeMessages,
  wakeArrived,
  wakeSummary,
  windowClosed,
} from "./BotHome.ts";

const botId = BotIdValue.make("bot:atlas") as BotId;
const wake = (text: string, label = "Pair update"): BotWake => ({
  botId,
  reason: "test",
  label,
  text,
});

describe("formatWakeText", () => {
  it("prefixes a single wake", () => {
    expect(formatWakeText([wake("Session finished")])).toBe("[Pair] Session finished");
  });

  it("lists several wakes with a count", () => {
    expect(formatWakeText([wake("Session finished"), wake("Ask answered")])).toBe(
      "[Pair] 2 updates:\n- Session finished\n- Ask answered",
    );
  });
});

describe("wakeSummary", () => {
  it("uses the wake's label, and counts the rest", () => {
    expect(wakeSummary([wake("one", "New job")])).toBe("New job");
    expect(wakeSummary([wake("one", "Sidebar flicker finished"), wake("two")])).toBe(
      "Sidebar flicker finished and 1 more",
    );
    expect(wakeSummary([])).toBe("Pair update");
  });
});

describe("splitWakeMessages", () => {
  const request = (text: string): BotWake => ({
    botId,
    reason: "session-request",
    label: `${text} is waiting`,
    text,
  });

  it("keeps one message when no request needs a decision", () => {
    expect(splitWakeMessages([wake("one"), wake("two")])).toEqual([[wake("one"), wake("two")]]);
  });

  it("rides the first request with the rest and gives each later one its own message", () => {
    const groups = splitWakeMessages([
      wake("finished"),
      request("one"),
      wake("quiet"),
      request("two"),
      request("three"),
    ]);
    expect(groups.map((group) => group.map((entry) => entry.text))).toEqual([
      ["finished", "one", "quiet"],
      ["two"],
      ["three"],
    ]);
  });

  it("returns nothing for no wakes", () => {
    expect(splitWakeMessages([])).toEqual([]);
  });
});

describe("wake batching and holding", () => {
  it("holds wakes while the bot is paused", () => {
    const first = wakeArrived(initialWakeState, wake("one"), { exists: true, paused: true });
    expect(first.effect).toBe("hold");
    const second = wakeArrived(first.state, wake("two"), { exists: true, paused: true });
    expect(second.effect).toBe("hold");
    expect(second.state.held.map((entry) => entry.text)).toEqual(["one", "two"]);
    expect(second.state.batch).toBeNull();
  });

  it("drops a wake for a bot that no longer exists", () => {
    const arrival = wakeArrived(initialWakeState, wake("gone"), { exists: false, paused: false });
    expect(arrival.effect).toBe("drop");
    expect(arrival.state).toBe(initialWakeState);
  });

  it("flushes held and new wakes together when a bot is resumed", () => {
    const held = wakeArrived(initialWakeState, wake("one"), { exists: true, paused: true }).state;
    const resumed = wakeArrived(held, wake("two"), { exists: true, paused: false });
    expect(resumed.effect).toBe("open");
    expect(resumed.state.batch?.map((entry) => entry.text)).toEqual(["one", "two"]);
    const closed = windowClosed(resumed.state);
    expect(closed.wakes.map((entry) => entry.text)).toEqual(["one", "two"]);
    expect(closed.state.batch).toBeNull();
  });

  it("opens one window and appends wakes that arrive inside it", () => {
    const opened = wakeArrived(initialWakeState, wake("one"), { exists: true, paused: false });
    expect(opened.effect).toBe("open");
    const appended = wakeArrived(opened.state, wake("two"), { exists: true, paused: false });
    expect(appended.effect).toBe("append");
    expect(windowClosed(appended.state).wakes.map((entry) => entry.text)).toEqual(["one", "two"]);
  });
});
