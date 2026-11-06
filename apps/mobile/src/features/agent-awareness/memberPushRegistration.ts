import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { createMemberPushCommands } from "@t3tools/client-runtime/state/memberPush";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";
import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";

export type MemberPushStatus = "server-unsupported" | "registered" | "no-token";

/** What the Settings row shows for a team environment's own push. */
export function memberPushStatus(
  config: Pick<ServerConfig, "memberPush"> | undefined,
  pushToken: string | null,
): MemberPushStatus {
  if (config?.memberPush !== true) return "server-unsupported";
  return pushToken === null ? "no-token" : "registered";
}

const memberPush = createMemberPushCommands(connectionAtomRuntime);
const UNREGISTER_WAIT_MS = 3_000;

let pushToken: string | null = null;
const pushTokenListeners = new Set<() => void>();

export function getMemberPushToken(): string | null {
  return pushToken;
}

export function subscribeMemberPushToken(listener: () => void): () => void {
  pushTokenListeners.add(listener);
  return () => {
    pushTokenListeners.delete(listener);
  };
}

function setPushToken(next: string | null): void {
  if (pushToken === next) return;
  pushToken = next;
  for (const listener of pushTokenListeners) listener();
}

function expoProjectId(): string | null {
  const projectId: unknown = Constants.expoConfig?.extra?.eas?.projectId;
  return typeof projectId === "string" && projectId.length > 0 ? projectId : null;
}

async function readPushToken(): Promise<string | null> {
  const platformCanPush =
    Platform.OS === "android" ||
    (Platform.OS === "ios" && Constants.expoConfig?.extra?.iosPersonalTeamBuild !== true);
  const projectId = expoProjectId();
  if (!platformCanPush || projectId === null) return null;
  if (!(await Notifications.getPermissionsAsync()).granted) return null;
  if (pushToken !== null) return pushToken;
  try {
    return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch (error) {
    console.warn("[member push] could not read the Expo push token", error);
    return null;
  }
}

async function registerEnvironments(environmentIds: ReadonlyArray<EnvironmentId>): Promise<void> {
  const token = await readPushToken();
  setPushToken(token);
  if (token === null || environmentIds.length === 0) return;
  const deviceId = await loadOrCreateAgentAwarenessDeviceId();
  const platform = Platform.OS === "android" ? "android" : "ios";
  await Promise.all(
    environmentIds.map((environmentId) =>
      runAtomCommand(
        appAtomRegistry,
        memberPush.register,
        { environmentId, input: { deviceId, token, platform } },
        { reportFailure: false },
      ),
    ),
  );
}

function memberPushEnvironments(): ReadonlyArray<EnvironmentId> {
  return [...appAtomRegistry.get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.memberPush === true)
    .map(([environmentId]) => environmentId);
}

/**
 * Registers this device with every team server that sends its own push, again whenever a
 * config arrives (a reconnect can carry a new auth session) and when the app returns.
 */
export function installMemberPushRegistration(): () => void {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return () => {};
  const seen = new Map<EnvironmentId, ServerConfig>();
  const run = (environmentIds: ReadonlyArray<EnvironmentId>) => {
    void registerQuietly(environmentIds);
  };
  const unsubscribe = appAtomRegistry.subscribe(
    environmentServerConfigsAtom,
    (configs) => {
      const changed: Array<EnvironmentId> = [];
      for (const [environmentId, config] of configs) {
        if (seen.get(environmentId) === config) continue;
        seen.set(environmentId, config);
        if (config.memberPush === true) changed.push(environmentId);
      }
      for (const environmentId of seen.keys()) {
        if (!configs.has(environmentId)) seen.delete(environmentId);
      }
      if (changed.length > 0) run(changed);
    },
    { immediate: true },
  );
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") run(memberPushEnvironments());
  });
  return () => {
    unsubscribe();
    appState.remove();
  };
}

function registerQuietly(environmentIds: ReadonlyArray<EnvironmentId>): Promise<void> {
  return registerEnvironments(environmentIds).catch((error: unknown) => {
    console.warn("[member push] registration failed", error);
  });
}

export function refreshMemberPushRegistration(): Promise<void> {
  return registerQuietly(memberPushEnvironments());
}

/**
 * Asks each team server to stop pushing to this device. Waits briefly, so leaving an
 * unreachable server is never blocked on it.
 */
export async function unregisterMemberPush(environmentIds: Iterable<EnvironmentId>): Promise<void> {
  const configs = appAtomRegistry.get(environmentServerConfigsAtom);
  const targets = [...environmentIds].filter((id) => configs.get(id)?.memberPush === true);
  if (targets.length === 0) return;
  const unregister = loadOrCreateAgentAwarenessDeviceId().then((deviceId) =>
    Promise.all(
      targets.map((environmentId) =>
        runAtomCommand(
          appAtomRegistry,
          memberPush.unregister,
          { environmentId, input: { deviceId } },
          { reportFailure: false },
        ),
      ),
    ),
  );
  await Promise.race([
    unregister.catch((error: unknown) => {
      console.warn("[member push] unregister failed", error);
    }),
    new Promise<void>((resolve) => setTimeout(resolve, UNREGISTER_WAIT_MS)),
  ]);
}
