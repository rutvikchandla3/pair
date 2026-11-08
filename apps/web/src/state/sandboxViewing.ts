import { INITIAL_VIEWER_LEASE, stepViewerLease } from "@t3tools/client-runtime/sandbox-viewing";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { getDocumentActivity, subscribeDocumentActivity } from "../lib/documentActivity";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { sandboxEnvironment } from "./sandbox";

const LEASE_TICK_MS = 60_000;

let lease = INITIAL_VIEWER_LEASE;

function renewViewerLease(threadRef: ScopedThreadRef, cloud: boolean) {
  const { visible, focused } = getDocumentActivity();
  const step = stepViewerLease(lease, {
    threadId: threadRef.threadId,
    cloud,
    visible,
    focused,
    nowMs: Date.now(),
  });
  lease = step.state;
  if (step.send === null) return;
  void sandboxEnvironment.viewing.run(appAtomRegistry, {
    environmentId: threadRef.environmentId,
    input: { threadId: step.send },
  });
}

/** Keeps the routed cloud thread's machine awake while this window shows it (`sandbox.viewing`). */
export function mountViewerLease(threadRef: ScopedThreadRef, cloud: boolean): () => void {
  const renew = () => renewViewerLease(threadRef, cloud);
  renew();
  const timer = window.setInterval(renew, LEASE_TICK_MS);
  const unsubscribe = subscribeDocumentActivity(renew);
  return () => {
    window.clearInterval(timer);
    unsubscribe();
  };
}
