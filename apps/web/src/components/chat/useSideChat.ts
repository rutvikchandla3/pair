import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRef } from "react";

import { newMessageId, newThreadId } from "~/lib/utils";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";

/**
 * Starts side chats from `threadRef`, or offers none when it is null. `open` forks the
 * thread's latest stable point, sends `prompt` there, and shows the side chat's tab. It
 * resolves false when the side chat did not start, or another one is still starting.
 */
export function useSideChat(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly onError: (message: string) => void;
}) {
  const pendingRef = useRef(false);
  const forkSideChat = useAtomCommand(threadEnvironment.forkSideChat, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const reportFailure = (
    failure: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
    fallback: string,
  ) => {
    if (isAtomCommandInterrupted(failure)) return;
    const error = squashAtomCommandFailure(failure);
    input.onError(error instanceof Error ? error.message : fallback);
  };
  const start = async (threadRef: ScopedThreadRef, prompt: string | undefined) => {
    const targetThreadId = newThreadId();
    const fork = await forkSideChat({
      environmentId: threadRef.environmentId,
      input: { sourceThreadId: threadRef.threadId, targetThreadId, title: "Side chat" },
    });
    if (fork._tag === "Failure") {
      reportFailure(fork, "Could not start a side chat.");
      return false;
    }
    // Drops the empty side chat a failed start leaves behind; one that got its message stays.
    const discard = () =>
      void deleteThread({
        environmentId: threadRef.environmentId,
        input: { threadId: targetThreadId, onlyIfUnused: true },
      });
    if (!(await waitForThreadShell(scopeThreadRef(threadRef.environmentId, targetThreadId)))) {
      input.onError("The side chat was created, but it did not reach this client.");
      discard();
      return false;
    }
    const text = prompt?.trim();
    // Send before showing the tab: closing a tab whose side chat has no run deletes it.
    if (text) {
      // The server asks before edits on a side chat's first turn whatever mode is sent.
      const turn = await startThreadTurn({
        environmentId: threadRef.environmentId,
        input: {
          threadId: targetThreadId,
          message: { messageId: newMessageId(), role: "user", text, attachments: [] },
          titleSeed: deriveThreadTitleSeed({ text, attachments: [] }),
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        },
      });
      if (turn._tag === "Failure") {
        reportFailure(turn, "Could not send the side chat message.");
        discard();
        return false;
      }
    }
    useRightPanelStore.getState().openSideChat(threadRef, targetThreadId);
    return true;
  };
  const open = async (prompt?: string) => {
    const { threadRef } = input;
    if (!threadRef || pendingRef.current) return false;
    pendingRef.current = true;
    return start(threadRef, prompt).finally(() => {
      pendingRef.current = false;
    });
  };
  return { available: input.threadRef !== null, open: useStableCallback(open) };
}

/**
 * Opens an empty side chat on `threadRef` from a menu, outside the thread's view; the tab shows
 * when the thread does. Resolves with why it did not start, or null.
 */
export async function openSideChatOn(threadRef: ScopedThreadRef): Promise<string | null> {
  const targetThreadId = newThreadId();
  const fork = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.forkSideChat,
    {
      environmentId: threadRef.environmentId,
      input: { sourceThreadId: threadRef.threadId, targetThreadId, title: "Side chat" },
    },
    { label: "Side chat", reportFailure: false },
  );
  if (fork._tag === "Failure") {
    if (isAtomCommandInterrupted(fork)) return null;
    const error = squashAtomCommandFailure(fork);
    return error instanceof Error ? error.message : "Could not start a side chat.";
  }
  if (!(await waitForThreadShell(scopeThreadRef(threadRef.environmentId, targetThreadId)))) {
    return "The side chat was created, but it did not reach this client.";
  }
  useRightPanelStore.getState().openSideChat(threadRef, targetThreadId);
  return null;
}
