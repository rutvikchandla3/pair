import {
  BotId,
  CommandId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SessionRotation from "../orchestration-v2/SessionRotation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import { type Brief, loadBrief } from "./botBrief.ts";
import * as BotSessions from "./BotSessions.ts";
import * as BotService from "./BotService.ts";
import { BotThreads } from "./botThreads.ts";

/**
 * A bot's home thread is one long conversation, so its provider session would grow until the
 * provider compacts it, and each compaction summarizes the last summary. Past this many tokens of
 * context, the bot saves what it needs (the flush turn) and its next turn starts a fresh session
 * seeded from stored state. 0 starts every turn fresh.
 */
const sessionTokenBudget = Config.Int("T3CODE_BOT_SESSION_TOKEN_BUDGET").pipe(
  Config.withDefault(150_000),
  Config.map((value) => Math.max(0, value)),
);
/** A cold session smaller than this is cheaper to re-read than to replace with a seed. */
const IDLE_ROTATION_MIN_TOKENS = 50_000;
/** The idle flush runs this long before the prompt cache expires, while the session reads cheap. */
const FLUSH_LEAD_MS = 2 * 60_000;
const SEED_MESSAGES = 30;
const SEED_MESSAGE_CHARS = 2_000;
const SEED_MESSAGES_CHARS = 40_000;

export const FLUSH_MESSAGE_PREFIX = "message:bot-flush:";
const FLUSH_LABEL = "Saving notes before a fresh session";
const FLUSH_TEXT =
  "[Pair] After this turn, this chat moves to a fresh session that keeps only your notes, your brief and the last messages. Save anything from this conversation you will still need that is not in your notes yet with bot_learn, one short rule each. Then end the turn without writing a message.";

export interface SessionUsage {
  readonly usedTokens: number;
  readonly promptCacheExpiresAt: string | null;
}

const cacheExpiresAtMs = (usage: SessionUsage): number | null => {
  const at =
    usage.promptCacheExpiresAt === null ? Number.NaN : Date.parse(usage.promptCacheExpiresAt);
  return Number.isFinite(at) ? at : null;
};

/**
 * Whether a home-thread turn starts a fresh session: always at budget 0; past the budget; or once
 * the prompt cache expired on a session big enough to be worth replacing. Never for the flush,
 * which saves what the session it runs on knows.
 */
export const rotationDue = (input: {
  readonly budget: number;
  readonly usage: SessionUsage | null;
  readonly nowMs: number;
  readonly flush: boolean;
}): boolean => {
  if (input.flush) return false;
  if (input.budget === 0) return true;
  if (input.usage === null) return false;
  if (input.usage.usedTokens >= input.budget) return true;
  const expiresAt = cacheExpiresAtMs(input.usage);
  return (
    expiresAt !== null &&
    input.nowMs >= expiresAt &&
    input.usage.usedTokens >= IDLE_ROTATION_MIN_TOKENS
  );
};

/**
 * When to send the flush after a home-thread run completes: now when the session passed the
 * budget, just before its cache expires when it could go cold, or never. Never after a flush, and
 * never at budget 0, where no session outlives its turn.
 */
export const flushPlan = (input: {
  readonly budget: number;
  readonly usage: SessionUsage | null;
  readonly afterFlush: boolean;
}): { readonly atMs: number | "now" } | null => {
  if (input.budget === 0 || input.afterFlush || input.usage === null) return null;
  if (input.usage.usedTokens >= input.budget) return { atMs: "now" };
  if (input.usage.usedTokens < IDLE_ROTATION_MIN_TOKENS) return null;
  const expiresAt = cacheExpiresAtMs(input.usage);
  return expiresAt === null ? null : { atMs: expiresAt - FLUSH_LEAD_MS };
};

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

const speaker = (message: OrchestrationV2ConversationMessage) =>
  message.role === "assistant" ? "You" : message.createdBy === "user" ? "User" : "Pair";

/**
 * What a fresh session starts with: the brief and the chat's last messages, newest kept first
 * when they run long. Built from stored state each time, never from the last session.
 */
export const composeSeed = (input: {
  readonly brief: Brief;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
}): string => {
  const lines: Array<string> = [];
  let chars = 0;
  for (const message of input.messages.toReversed()) {
    const text = message.text.trim();
    if (text === "") continue;
    const line = `${speaker(message)} (${DateTime.formatIso(message.createdAt)}): ${clip(text, SEED_MESSAGE_CHARS)}`;
    if (chars + line.length > SEED_MESSAGES_CHARS) break;
    chars += line.length;
    lines.unshift(line);
  }
  return [
    "[Pair] This chat now runs on a fresh session, so your earlier turns are not in it. Start from what follows instead.",
    `Your brief as of ${input.brief.asOf} (pass that as since to bot_brief):\n${JSON.stringify(input.brief)}`,
    lines.length === 0
      ? "This chat has no earlier messages."
      : `The last ${lines.length} messages of this chat, oldest first:\n${lines.join("\n\n")}`,
  ].join("\n\n");
};

export class BotRotation extends Context.Service<
  BotRotation,
  {
    /** Registers the turn start's rotation and flushes after each completed home-thread run. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/bots/BotRotation") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const bots = yield* BotService.BotService;
  const briefContext = yield* Effect.context<
    BotService.BotService | BotSessions.BotSessions | ProjectService.ProjectService
  >();
  const budget = yield* sessionTokenBudget;
  const registerRotation = yield* SessionRotation.makeRegister;

  const freshSessionSeed: SessionRotation.SessionRotationShape["freshSessionSeed"] = Effect.fn(
    "BotRotation.freshSessionSeed",
  )(
    function* (input) {
      const botId = BotThreads.homeBotId(input.threadId);
      if (botId === undefined) return null;
      const due = rotationDue({
        budget,
        usage: input.usage,
        nowMs: DateTime.toEpochMillis(yield* DateTime.now),
        flush: input.messageId.startsWith(FLUSH_MESSAGE_PREFIX),
      });
      if (!due) return null;
      const brief = yield* loadBrief(BotId.make(botId), { since: null }).pipe(
        Effect.provide(briefContext),
      );
      const recent = yield* projections.getRecentMessages(input.threadId, SEED_MESSAGES * 2);
      const runIds = [...new Set(recent.flatMap((message) => message.runId ?? []))];
      const { runs } = yield* projections.getThreadRecords(input.threadId, ["runs"], { runIds });
      const ordinals = new Map(runs.map((run) => [run.id, run.ordinal]));
      const ordinal = (message: (typeof recent)[number]) =>
        message.runId === null ? 0 : (ordinals.get(message.runId) ?? 0);
      // Earlier runs only, in run order: the turn's own message follows the seed, and messages
      // queued behind it arrive in their own turns. Timestamps can tie.
      const messages = recent
        .filter((message) => ordinal(message) < input.runOrdinal)
        .filter((message) => !message.id.startsWith(FLUSH_MESSAGE_PREFIX))
        .toSorted(
          (left, right) =>
            ordinal(left) - ordinal(right) ||
            Number(left.role === "assistant") - Number(right.role === "assistant") ||
            DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
        )
        .slice(-SEED_MESSAGES);
      return composeSeed({ brief, messages });
    },
    // A seed that can't be built leaves the turn on its current session.
    (effect) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("bot session rotation skipped", { cause }).pipe(Effect.as(null)),
        ),
      ),
  );

  /** Sends the flush once the run's session passed the budget, or just before it goes cold. */
  const flushAfterRun = Effect.fn("BotRotation.flushAfterRun")(
    function* (threadId: ThreadId, runId: RunId) {
      while (true) {
        const thread = yield* projections.getThread(threadId);
        const active =
          thread.activeProviderThreadId === null ? [] : [thread.activeProviderThreadId];
        const records = yield* projections.getThreadRecords(
          threadId,
          ["runs", "providerThreads", "providerTurns"],
          {
            runStatuses: ["queued", "preparing", "starting", "running", "waiting"],
            includeLatestRun: true,
            providerThreadIds: active,
            providerTurnThreadIds: active,
            latestProviderTurnUsageOnly: true,
          },
        );
        // A newer run is going or done; its own completion decides.
        // A removed queued message leaves a cancelled run that never started.
        const latest = records.runs
          .filter((run) => run.status !== "cancelled" || run.startedAt !== null)
          .reduce<(typeof records.runs)[number] | undefined>(
            (found, run) => (found === undefined || run.ordinal > found.ordinal ? run : found),
            undefined,
          );
        if (latest?.id !== runId || latest.status !== "completed") return;
        // The latest turn is on the current native session: sessions only move forward.
        const turnUsage = records.providerTurns.find(
          (turn) => turn.tokenUsage !== undefined,
        )?.tokenUsage;
        const plan = flushPlan({
          budget,
          usage: SessionRotation.currentSessionUsage(
            turnUsage === undefined
              ? undefined
              : {
                  usage: turnUsage,
                  ...(turnUsage.promptCacheExpiresAt === undefined
                    ? {}
                    : { promptCacheExpiresAt: turnUsage.promptCacheExpiresAt }),
                },
            records.providerThreads[0] ?? { contextUsage: null },
          ),
          afterFlush: latest.userMessageId.startsWith(FLUSH_MESSAGE_PREFIX),
        });
        if (plan === null) return;
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        if (plan.atMs !== "now" && nowMs < plan.atMs) {
          yield* Effect.sleep(Duration.millis(plan.atMs - nowMs));
          continue;
        }
        const botId = BotThreads.homeBotId(threadId);
        if (botId === undefined) return;
        const bot = Option.getOrNull(yield* bots.getBot(BotId.make(botId)));
        // A paused bot takes no turns of its own; its next turn rotates without a flush.
        if (bot === null || bot.paused) return;
        yield* engine.dispatch({
          type: "message.dispatch",
          // One flush per completed run, even across duplicate events.
          commandId: CommandId.make(`server:bot-flush:${threadId}:${runId}`),
          threadId,
          messageId: MessageId.make(`${FLUSH_MESSAGE_PREFIX}${runId}`),
          text: FLUSH_TEXT,
          notification: {
            source: { kind: "system" },
            outcome: "updated",
            summary: FLUSH_LABEL,
            detail: FLUSH_TEXT,
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        });
        return;
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) => Effect.logWarning("bot flush skipped", { threadId, cause })),
      ),
  );

  const start: BotRotation["Service"]["start"] = Effect.fn("BotRotation.start")(function* () {
    yield* registerRotation({ freshSessionSeed });
    // Keyed by thread: a newer completed run replaces the one waiting to flush.
    const timers = yield* FiberMap.make<ThreadId>();
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        event.type === "run.updated" &&
        event.payload.status === "completed" &&
        BotThreads.homeBotId(event.threadId) !== undefined
          ? FiberMap.run(timers, event.threadId, flushAfterRun(event.threadId, event.payload.id))
          : Effect.void,
      ),
    );
  });

  return { start } satisfies BotRotation["Service"];
});

export const layer = Layer.effect(BotRotation, make);
