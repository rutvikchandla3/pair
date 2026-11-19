import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type Bot,
  type BotId,
  BotId as BotIdValue,
  MemberId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { BotService, type BotWake } from "./BotService.ts";
import {
  BotHome,
  formatWakeText,
  initialWakeState,
  splitWakeMessages,
  wakeArrived,
  wakeSummary,
  windowClosed,
  layer,
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

const at = "2026-11-19T00:00:00.000Z";
const model = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" };
const savedBot = (id: string, homeThreadId: string | null): Bot => ({
  id: BotIdValue.make(id),
  ownerId: MemberId.make("member:owner"),
  name: "Atlas",
  color: "#6366f1",
  shape: "round",
  voice: "candid",
  charter: "",
  instructions: "",
  limits: [],
  models: { brain: model, worker: model, reviewer: model },
  homeThreadId: homeThreadId === null ? null : ThreadId.make(homeThreadId),
  homeProjectId: null,
  paused: false,
  lastSeenAt: null,
  nextJobNumber: 1,
  createdAt: at,
  updatedAt: at,
});

describe("refreshHomes", () => {
  it.effect("rewrites an existing bot's persona and deny list, and skips bots with no home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-bot-home-" });
      const services = Layer.mergeAll(
        Layer.mock(BotService)({
          listAllBots: () =>
            Effect.succeed([savedBot("bot:atlas", "thread:home"), savedBot("bot:nova", null)]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(Orchestrator.OrchestratorV2)({}),
        SecureRandom.layerWebCrypto,
      );
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const homes = path.join(config.stateDir, "bots");
        const staleHome = path.join(homes, "bot_atlas");
        yield* fs.makeDirectory(staleHome, { recursive: true });
        yield* fs.writeFileString(
          path.join(staleHome, "AGENTS.md"),
          "# You are Atlas\n(old rules)\n",
        );

        yield* (yield* BotHome).refreshHomes();

        const persona = yield* fs.readFileString(path.join(staleHome, "AGENTS.md"));
        expect(persona).toContain("## Keep this chat free");
        expect(persona).toContain("Your voice is Candid");
        const settings = yield* fs.readFileString(path.join(staleHome, ".claude", "settings.json"));
        expect(JSON.parse(settings).permissions.deny).toContain("Bash");
        expect(yield* fs.exists(path.join(homes, "bot_nova"))).toBe(false);
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
            Layer.provide(services),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
