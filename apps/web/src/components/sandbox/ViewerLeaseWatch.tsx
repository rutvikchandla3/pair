import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useEffect } from "react";

import { useThreadRouteRef } from "~/hooks/useThreadRouteTarget";
import { mountViewerLease } from "~/state/sandboxViewing";

import { useSandboxThreadMachine } from "./useSandboxThreadStatus";

/** Renews the viewer lease of the thread the route shows, while its window is focused. */
export function ViewerLeaseWatch() {
  const threadRef = useThreadRouteRef();
  const cloud = useSandboxThreadMachine(threadRef) !== null;
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the lease timer and the window focus listener for the routed thread
  useEffect(
    () =>
      environmentId === null || threadId === null
        ? undefined
        : mountViewerLease(scopeThreadRef(environmentId, threadId), cloud),
    [environmentId, threadId, cloud],
  );
  return null;
}
