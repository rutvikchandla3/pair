import {
  type Bot,
  BotsError,
  type EnvironmentId,
  type OrchestratorMcpFailure,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type * as PeerLinks from "../peer/PeerLinks.ts";

/** Where a bot's cloud sessions run: one of this server's links to a Pair Cloud. */
export interface BotCloudTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export const NO_CLOUD_MESSAGE =
  "This Pair server doesn't run cloud machines and no Pair Cloud is linked. Tell the user to link one in Settings → Connections, or start the session here without cloud.";

/**
 * How a bot reaches its cloud: as its home thread, under one namespace per bot, so a launch
 * retried with the same key finds the thread it started and every limit check reads the home
 * thread's modes.
 */
const botLinkScope = (
  hereId: EnvironmentId,
  bot: Pick<Bot, "id">,
  home: { readonly threadId: ThreadId; readonly providerInstanceId: ProviderInstanceId },
): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId: hereId,
  requestNamespace: `bot:${bot.id}`,
  thread: {
    threadId: home.threadId,
    providerSessionId: `bot:${bot.id}`,
    providerInstanceId: home.providerInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

/** The bot's link scope, read from its home thread; fails while the bot has no home yet. */
export const loadBotLinkScope = Effect.fn("bots.loadBotLinkScope")(function* (
  threads: ThreadManagementService.ThreadManagementService["Service"],
  hereId: EnvironmentId,
  bot: Pick<Bot, "id" | "homeThreadId">,
) {
  const home =
    bot.homeThreadId === null
      ? null
      : yield* threads.getThreadShell(bot.homeThreadId).pipe(Effect.orElseSucceed(() => null));
  if (home === null) {
    return yield* new BotsError({
      reason: "unavailable",
      message: "The bot's chat is not ready yet.",
    });
  }
  return {
    scope: botLinkScope(hereId, bot, {
      threadId: home.id,
      providerInstanceId: home.providerInstanceId,
    }),
    activeRunId: home.activeRunId,
  };
});

/**
 * The Pair Cloud a cloud session runs on, chosen as `t3 thread start --cloud` chooses: the one
 * linked cloud, or the one named when several are. Reads the stored links only.
 */
export const resolveCloudTarget = Effect.fn("bots.resolveCloudTarget")(function* (
  links: PeerLinks.PeerLinks["Service"],
  requested: EnvironmentId | undefined,
) {
  const clouds: Array<BotCloudTarget> = [];
  for (const environmentId of yield* links.agentLinks) {
    const link = Option.getOrUndefined(
      yield* links.get(environmentId).pipe(Effect.orElseSucceed(() => Option.none())),
    );
    if (link !== undefined) clouds.push({ environmentId, label: link.label });
  }
  if (requested !== undefined) {
    const named = clouds.find((cloud) => cloud.environmentId === requested);
    if (named !== undefined) return named;
    return yield* new BotsError({
      reason: "invalid-request",
      message: `No linked Pair Cloud has environmentId ${requested}. Leave out cloud.environmentId to use the linked one.`,
    });
  }
  const [only] = clouds;
  if (only === undefined) {
    return yield* new BotsError({ reason: "invalid-request", message: NO_CLOUD_MESSAGE });
  }
  if (clouds.length > 1) {
    return yield* new BotsError({
      reason: "invalid-request",
      message: `More than one Pair Cloud is linked: ${clouds
        .map((cloud) => `${cloud.label} (${cloud.environmentId})`)
        .join(", ")}. Pass cloud.environmentId.`,
    });
  }
  return only;
});

/**
 * Refusals that waiting cannot fix: the link expired or was revoked there, or it was forgotten
 * here. Anything else (a dropped route, the cloud asleep) is worth retrying.
 */
export const isLinkGone = Effect.fn("bots.isLinkGone")(function* (
  links: PeerLinks.PeerLinks["Service"],
  environmentId: EnvironmentId,
  error: OrchestratorMcpFailure,
) {
  if (error.code === "capability_denied") return true;
  if (error.code !== "invalid_request") return false;
  return Option.isNone(
    yield* links.get(environmentId).pipe(Effect.orElseSucceed(() => Option.some(null))),
  );
});
