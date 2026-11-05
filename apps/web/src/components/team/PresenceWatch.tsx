import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { useThreadRouteTarget } from "~/hooks/useThreadRouteTarget";
import { getDocumentActivity, subscribeDocumentActivity } from "~/lib/documentActivity";
import { useConnectedEnvironmentIds } from "~/state/environments";
import {
  dispatchPresence,
  mountPresenceReporter,
  presenceEnvironment,
  usePresence,
} from "~/state/presence";

const isDocumentVisible = () => getDocumentActivity().visible;

function ActivePresence({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const others = usePresence(environmentId).members.size > 0;
  const routeTarget = useThreadRouteTarget();
  const visible = useSyncExternalStore(subscribeDocumentActivity, isDocumentVisible);
  // Settings and other pages have no thread params, so they view nothing.
  const viewingThreadId =
    visible &&
    routeTarget?.kind === "server" &&
    routeTarget.threadRef.environmentId === environmentId
      ? routeTarget.threadRef.threadId
      : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns this environment's reporter and its window input listeners
  useEffect(() => mountPresenceReporter(environmentId), [environmentId]);
  // Viewing goes first so a mount with others present sends one full report, not two.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports the viewed thread to the server
  useEffect(() => {
    dispatchPresence(environmentId, { type: "viewing", threadId: viewingThreadId });
  }, [environmentId, viewingThreadId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports start and stop with whether another member is connected
  useEffect(() => {
    dispatchPresence(environmentId, { type: "others", others });
  }, [environmentId, others]);
  return null;
}

function EnvironmentPresence({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const enabled = useAtomValue(presenceEnvironment.presenceEnabledAtom(environmentId));
  return enabled ? <ActivePresence environmentId={environmentId} /> : null;
}

/** Subscribes and reports presence for each connected team environment whose server has it. */
export function PresenceWatch() {
  return useConnectedEnvironmentIds().map((environmentId) => (
    <EnvironmentPresence key={environmentId} environmentId={environmentId} />
  ));
}
