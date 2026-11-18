import {
  BOT_WAKE_BATCH_MS,
  type Bot,
  type BotId,
  BotsError,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import { BotService, type BotWake } from "./BotService.ts";
import { botPersona } from "./botPersona.ts";

const notFound = (message: string) => new BotsError({ reason: "not-found", message });
const unavailable = (message: string) => new BotsError({ reason: "unavailable", message });

/** Every character outside this set becomes `_`, so the folder name is safe on every filesystem. */
const botFolderName = (botId: string): string => botId.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * Wakes waiting for one bot. `held` are wakes that arrived while it was paused; `batch` is the
 * current batching window, or null when none is open. Pure, so the delivery rules are testable
 * without the engine or the clock.
 */
export interface WakeState {
  readonly held: ReadonlyArray<BotWake>;
  readonly batch: ReadonlyArray<BotWake> | null;
}

export const initialWakeState: WakeState = { held: [], batch: null };

export type WakeEffect = "drop" | "hold" | "open" | "append";

interface WakeArrival {
  readonly state: WakeState;
  readonly effect: WakeEffect;
}

/**
 * One wake arrives: dropped when its bot is gone, held while it is paused, otherwise added to the
 * open batch (opening one on the first wake). Held wakes are merged in front of the new one, so a
 * resume delivers everything that piled up with the wake that resumed it.
 */
export const wakeArrived = (
  state: WakeState,
  wake: BotWake,
  options: { readonly exists: boolean; readonly paused: boolean },
): WakeArrival => {
  if (!options.exists) return { state, effect: "drop" };
  if (options.paused) {
    return { state: { held: [...state.held, wake], batch: state.batch }, effect: "hold" };
  }
  const batch = [...(state.batch ?? []), ...state.held, wake];
  return { state: { held: [], batch }, effect: state.batch === null ? "open" : "append" };
};

/** The batching window closes: hand back the wakes to deliver and clear the batch. */
export const windowClosed = (
  state: WakeState,
): { readonly state: WakeState; readonly wakes: ReadonlyArray<BotWake> } => ({
  state: { held: state.held, batch: null },
  wakes: state.batch ?? [],
});

const WAKE_LABELS: Record<string, string> = {
  created: "Bot created",
  "job-started": "New job",
  "job-stopped": "Job stopped",
  "job-reopened": "Job reopened",
  "ask-answered": "You answered",
  "ask-remember": "Remember this",
  "decision-corrected": "You corrected a decision",
  "playbook-changed": "Playbook changed",
  resumed: "Resumed",
  "session-handed-back": "Session handed back",
  "session-finished": "Session finished",
  "session-failed": "Session failed",
  "session-stopped": "Session stopped",
  "session-request": "Session is waiting",
  "session-usage-limit": "Session hit a usage limit",
  "session-quiet": "Session is quiet",
  "session-taken-over": "You took over a session",
};

/** The short label the home thread shows above a wake message. */
export const wakeSummary = (wakes: ReadonlyArray<BotWake>): string => {
  const first = wakes[0];
  if (first === undefined) return "Pair update";
  if (wakes.length > 1) return `${wakes.length} updates from Pair`;
  return WAKE_LABELS[first.reason] ?? "Pair update";
};

/** The one line, or list, the home thread hears. */
export const formatWakeText = (wakes: ReadonlyArray<BotWake>): string => {
  const first = wakes[0];
  if (first === undefined) return "[Pair]";
  if (wakes.length === 1) return `[Pair] ${first.text}`;
  return `[Pair] ${wakes.length} updates:\n${wakes.map((wake) => `- ${wake.text}`).join("\n")}`;
};

export class BotHome extends Context.Service<
  BotHome,
  {
    readonly ensureHome: (
      botId: BotId,
    ) => Effect.Effect<{ readonly threadId: ThreadId; readonly projectId: ProjectId }, BotsError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/bots/BotHome") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const botService = yield* BotService;
  const projects = yield* ProjectService.ProjectService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const engine = yield* Orchestrator.OrchestratorV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  // One lock per bot, so two wakes never create two home threads.
  const locks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());

  const semaphoreFor = (botId: BotId) =>
    SynchronizedRef.modify(locks, (current) => {
      const existing = current.get(botId);
      if (existing !== undefined) return [existing, current] as const;
      const created = Semaphore.makeUnsafe(1);
      const next = new Map(current);
      next.set(botId, created);
      return [created, next] as const;
    });

  const homeDir = (botId: BotId) => path.join(config.stateDir, "bots", botFolderName(botId));

  const writePersona = Effect.fn("BotHome.writePersona")(function* (bot: Bot, directory: string) {
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.writeFileString(path.join(directory, "AGENTS.md"), botPersona(bot));
    yield* fileSystem.writeFileString(path.join(directory, "CLAUDE.md"), "@AGENTS.md\n");
  });

  const ensureHomeUnlocked = Effect.fn("BotHome.ensureHomeUnlocked")(function* (botId: BotId) {
    const bot = Option.getOrNull(yield* botService.getBot(botId));
    if (bot === null) return yield* notFound("That bot is gone.");
    const directory = homeDir(botId);
    // The persona is regenerated every time, so a renamed bot or edited charter reaches an
    // existing home thread on its next turn.
    yield* writePersona(bot, directory).pipe(
      Effect.mapError(() => unavailable("Could not write the bot's folder.")),
    );
    if (bot.homeThreadId !== null) {
      const shell = yield* threads
        .getThreadShell(bot.homeThreadId)
        .pipe(Effect.mapError(() => unavailable("Could not read the bot's home thread.")));
      if (shell !== null && shell.deletedAt === null) {
        if (shell.archivedAt !== null) {
          yield* threads
            .dispatch({
              type: "thread.unarchive",
              commandId: CommandId.make(`server:bot-home:${yield* random.uuidV4()}`),
              threadId: bot.homeThreadId,
              actorId: bot.ownerId,
            })
            .pipe(Effect.mapError(() => unavailable("Could not restore the bot's home thread.")));
        }
        return { threadId: bot.homeThreadId, projectId: shell.projectId };
      }
    }

    const project = yield* projects
      .bootstrap({
        commandId: CommandId.make(`server:bot-home:${yield* random.uuidV4()}`),
        projectId: ProjectId.make(`bot-project:${yield* random.uuidV4()}`),
        title: `${bot.name} (bot)`,
        workspaceRoot: directory,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: bot.models.brain,
      })
      .pipe(Effect.mapError(() => unavailable("Could not create the bot's project.")));
    const launched = yield* launches
      .launch({
        commandId: CommandId.make(`server:bot-home:${yield* random.uuidV4()}`),
        projectId: project.project.id,
        title: bot.name,
        modelSelection: bot.models.brain,
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy: { type: "root" },
        createdBy: "system",
        creationSource: "server",
        ownerId: bot.ownerId,
      })
      .pipe(Effect.mapError(() => unavailable("Could not create the bot's home thread.")));
    yield* botService
      .setHome(botId, { homeThreadId: launched.threadId, homeProjectId: project.project.id })
      .pipe(Effect.mapError(() => unavailable("Could not record the bot's home thread.")));
    return { threadId: launched.threadId, projectId: project.project.id };
  });

  const ensureHome: BotHome["Service"]["ensureHome"] = Effect.fn("BotHome.ensureHome")(
    function* (botId) {
      const lock = yield* semaphoreFor(botId);
      return yield* lock.withPermits(1)(ensureHomeUnlocked(botId));
    },
  );

  const deliver = Effect.fn("BotHome.deliver")(
    function* (botId: BotId, wakes: ReadonlyArray<BotWake>) {
      const home = yield* ensureHome(botId);
      const suffix = yield* random.uuidV4();
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:bot-wake:${suffix}`),
        threadId: home.threadId,
        messageId: MessageId.make(`message:bot-wake:${suffix}`),
        text: formatWakeText(wakes),
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary: wakeSummary(wakes),
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
    },
    (effect) =>
      effect.pipe(
        Effect.catchCause((cause) => Effect.logWarning("bot wake delivery failed", { cause })),
      ),
  );

  const slots = yield* SynchronizedRef.make(new Map<string, WakeState>());

  const closeWindow = Effect.fn("BotHome.closeWindow")(function* (botId: BotId) {
    const result = yield* SynchronizedRef.modify(slots, (map) => {
      const current = map.get(botId) ?? initialWakeState;
      const closed = windowClosed(current);
      const next = new Map(map);
      next.set(botId, closed.state);
      return [closed.wakes, next] as const;
    });
    if (result.length > 0) yield* deliver(botId, result);
  });

  const handleWake = Effect.fn("BotHome.handleWake")(function* (wake: BotWake) {
    const bot = Option.getOrNull(yield* botService.getBot(wake.botId));
    const arrival = yield* SynchronizedRef.modify(slots, (map) => {
      const current = map.get(wake.botId) ?? initialWakeState;
      const decision = wakeArrived(current, wake, {
        exists: bot !== null,
        paused: bot?.paused ?? false,
      });
      const next = new Map(map);
      next.set(wake.botId, decision.state);
      return [decision, next] as const;
    });
    if (arrival.effect !== "open") return;
    yield* Effect.forkScoped(
      Effect.sleep(Duration.millis(BOT_WAKE_BATCH_MS)).pipe(
        Effect.andThen(closeWindow(wake.botId)),
      ),
    );
  });

  const start: BotHome["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(botService.wakes, handleWake).pipe(
        Effect.catchCause((cause) => Effect.logWarning("bot wake stream failed", { cause })),
      ),
    );

  return { ensureHome, start } satisfies BotHome["Service"];
});

export const layer = Layer.effect(BotHome, make);
