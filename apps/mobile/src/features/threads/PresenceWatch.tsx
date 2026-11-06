import { useAtomValue } from "@effect/atom-react";
import type { AppPresenceState } from "@t3tools/client-runtime/presence-reporting";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { subscribeAppState } from "../../lib/appState";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import {
  mountPresenceReporter,
  presenceEnvironment,
  reportAppPresence,
  reportOthersPresent,
  usePresence,
  viewedThreadAtom,
} from "../../state/presence";

const currentAppState = (): AppPresenceState =>
  AppState.currentState === "background" ? "background" : "active";

function ActivePresence({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const others = usePresence(environmentId).members.size > 0;
  const viewed = useAtomValue(viewedThreadAtom);
  const appState = useSyncExternalStore(subscribeAppState, currentAppState);
  const threadId = viewed?.environmentId === environmentId ? viewed.threadId : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns this environment's reporter
  useEffect(() => mountPresenceReporter(environmentId), [environmentId]);
  // Viewing goes first so a mount with others present sends one full report, not two.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports the routed thread and foreground state to the server
  useEffect(() => {
    reportAppPresence(environmentId, { appState, threadId });
  }, [environmentId, appState, threadId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports start and stop with whether another member is connected
  useEffect(() => {
    reportOthersPresent(environmentId, others);
  }, [environmentId, others]);
  return null;
}

function EnvironmentPresence({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const enabled = useAtomValue(presenceEnvironment.presenceEnabledAtom(environmentId));
  return enabled ? <ActivePresence environmentId={environmentId} /> : null;
}

/** Subscribes and reports presence for each connected team environment whose server has it. */
export function PresenceWatch() {
  return useAtomValue(connectedEnvironmentIdsAtom).map((environmentId) => (
    <EnvironmentPresence key={environmentId} environmentId={environmentId} />
  ));
}
