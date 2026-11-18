import { useAtomValue } from "@effect/atom-react";
import type { BotSession, EnvironmentId } from "@t3tools/contracts";
import { EnvironmentId as EnvironmentIdSchema, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "../../state/threads";
import { type BotSessionShell, type BotSessionState, botSessionState } from "./botsModel";

function toShell(shell: EnvironmentThreadShell | null): BotSessionShell | null {
  if (shell === null) return null;
  return {
    status: shell.runtime?.status ?? null,
    hasPendingApprovals: shell.hasPendingApprovals,
    hasPendingUserInput: shell.hasPendingUserInput,
    blockedOnThreadWait: shell.blockedOnThreadWait ?? false,
    usageLimitResetAt: shell.runtime?.usageLimitResetAt ?? null,
    lastError: shell.runtime?.lastError ?? null,
    updatedAt: shell.updatedAt,
  };
}

/** Every session's live shell, keyed by the environment and the sessions' thread ids. */
const sessionShellsFamily = Atom.family((key: string) => {
  const [environmentId, ...threadIds] = key.split("\u0000");
  return Atom.make((get) =>
    threadIds.map((threadId) =>
      toShell(
        get(
          environmentThreadShells.threadShellAtom({
            environmentId: EnvironmentIdSchema.make(environmentId ?? ""),
            threadId: ThreadId.make(threadId ?? ""),
          }),
        ),
      ),
    ),
  ).pipe(Atom.withLabel(`mobile-bot-session-shells:${key}`));
});

function useBotSessionShells(
  environmentId: EnvironmentId | null,
  sessions: ReadonlyArray<BotSession>,
): ReadonlyArray<BotSessionShell | null> {
  const key =
    environmentId === null
      ? ""
      : `${environmentId}\u0000${sessions.map((session) => session.threadId).join("\u0000")}`;
  return useAtomValue(sessionShellsFamily(key));
}

/** The sessions' derived states, in the order the bot started them. */
export function useBotSessionStates(input: {
  readonly environmentId: EnvironmentId | null;
  readonly sessions: ReadonlyArray<BotSession>;
  readonly botName: string;
  readonly nowMs: number;
}): ReadonlyArray<BotSessionState> {
  const shells = useBotSessionShells(input.environmentId, input.sessions);
  return input.sessions.map((session, index) =>
    botSessionState({
      session,
      shell: shells[index] ?? null,
      botName: input.botName,
      nowMs: input.nowMs,
    }),
  );
}
