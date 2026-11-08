import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { INITIAL_VIEWER_LEASE, stepViewerLease } from "@t3tools/client-runtime/sandbox-viewing";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { isAppActive, subscribeAppState } from "../../lib/appState";
import { appAtomRegistry } from "../../state/atom-registry";
import { viewedThreadAtom } from "../../state/presence";
import { sandboxEnvironment, useSandboxThreadMachine } from "../../state/sandbox";

const LEASE_TICK_MS = 60_000;

let lease = INITIAL_VIEWER_LEASE;

function renewViewerLease(threadRef: ScopedThreadRef, cloud: boolean) {
  const active = isAppActive();
  const step = stepViewerLease(lease, {
    threadId: threadRef.threadId,
    cloud,
    visible: active,
    focused: active,
    nowMs: Date.now(),
  });
  lease = step.state;
  if (step.send === null) return;
  void sandboxEnvironment.viewing.run(appAtomRegistry, {
    environmentId: threadRef.environmentId,
    input: { threadId: step.send },
  });
}

function mountViewerLease(threadRef: ScopedThreadRef, cloud: boolean): () => void {
  const renew = () => renewViewerLease(threadRef, cloud);
  renew();
  const timer = setInterval(renew, LEASE_TICK_MS);
  const unsubscribe = subscribeAppState(renew);
  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}

/** Keeps the shown cloud thread's machine awake while the app is in the foreground. */
export function ViewerLeaseWatch() {
  const viewed = useAtomValue(viewedThreadAtom);
  const environmentId = viewed?.environmentId ?? null;
  const threadId = viewed?.threadId ?? null;
  const cloud =
    useSandboxThreadMachine(
      environmentId === null || threadId === null ? null : scopeThreadRef(environmentId, threadId),
    ) !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the lease timer and the AppState listener for the shown thread
  useEffect(
    () =>
      environmentId === null || threadId === null
        ? undefined
        : mountViewerLease(scopeThreadRef(environmentId, threadId), cloud),
    [environmentId, threadId, cloud],
  );
  return null;
}
