import { useAtomValue } from "@effect/atom-react";
import { createBotsEnvironmentAtoms } from "@t3tools/client-runtime/state/bots";
import type { BotsSnapshot, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useNowMinute } from "../hooks/useNowMinute";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentQuery } from "./query";

export const botsEnvironment = createBotsEnvironmentAtoms(connectionAtomRuntime);

function snapshotAtom(environmentId: EnvironmentId) {
  return botsEnvironment.snapshot({ environmentId, input: undefined });
}

/** The whole bots snapshot for one environment, null until it first loads. */
export function useBotsSnapshot(environmentId: EnvironmentId | null): BotsSnapshot | null {
  const query = useEnvironmentQuery(environmentId === null ? null : snapshotAtom(environmentId));
  return query.data;
}

const EMPTY_IDS: ReadonlySet<string> = Object.freeze(new Set<string>());

function idSetFamily(label: string, select: (snapshot: BotsSnapshot) => ReadonlyArray<string>) {
  return Atom.family((environmentId: EnvironmentId) => {
    let previousKey = "";
    let previous: ReadonlySet<string> = EMPTY_IDS;
    return Atom.make((get) => {
      const snapshot = AsyncResult.getOrElse(get(snapshotAtom(environmentId)), () => null);
      const ids = snapshot === null ? [] : [...new Set(select(snapshot))];
      const key = ids.slice().sort().join("\n");
      if (key === previousKey) return previous;
      previousKey = key;
      previous = new Set(ids);
      return previous;
    }).pipe(Atom.withLabel(`${label}:${environmentId}`));
  });
}

const botThreadIdsFamily = idSetFamily("web-bot-thread-ids", (snapshot) => [
  ...snapshot.bots.flatMap((bot) => (bot.homeThreadId === null ? [] : [bot.homeThreadId])),
  ...snapshot.sessions.map((session) => session.threadId),
]);

const botHomeProjectIdsFamily = idSetFamily("web-bot-home-project-ids", (snapshot) =>
  snapshot.bots.flatMap((bot) => (bot.homeProjectId === null ? [] : [bot.homeProjectId])),
);

const EMPTY_SET_ATOM = Atom.make(EMPTY_IDS).pipe(Atom.withLabel("web-bot-ids:none"));

/** Every bot's hidden home thread and every session thread: keep them out of Threads. */
export function useBotThreadIds(environmentId: EnvironmentId | null): ReadonlySet<string> {
  return useAtomValue(environmentId === null ? EMPTY_SET_ATOM : botThreadIdsFamily(environmentId));
}

/** Bots' hidden home projects: keep them out of the sidebar's project groups. */
export function useBotHomeProjectIds(environmentId: EnvironmentId | null): ReadonlySet<string> {
  return useAtomValue(
    environmentId === null ? EMPTY_SET_ATOM : botHomeProjectIdsFamily(environmentId),
  );
}

const sessionBotNamesFamily = Atom.family((environmentId: EnvironmentId) => {
  let previousKey = "";
  let previous: ReadonlyMap<string, string> = new Map();
  return Atom.make((get) => {
    const snapshot = AsyncResult.getOrElse(get(snapshotAtom(environmentId)), () => null);
    const botNames = new Map(snapshot?.bots.map((bot) => [bot.id, bot.name]) ?? []);
    const names = new Map<string, string>();
    for (const session of snapshot?.sessions ?? []) {
      const name = botNames.get(session.botId);
      if (name !== undefined) names.set(session.threadId, name);
    }
    const key = [...names].map((pair) => pair.join("\t")).join("\n");
    if (key === previousKey) return previous;
    previousKey = key;
    previous = names;
    return previous;
  }).pipe(Atom.withLabel(`web-bot-session-names:${environmentId}`));
});

const NO_SESSION_NAMES_ATOM = Atom.make<ReadonlyMap<string, string>>(new Map()).pipe(
  Atom.withLabel("web-bot-session-names:none"),
);

/** The name of the bot running this thread as one of its sessions, else null. */
export function useSessionBotName(
  environmentId: EnvironmentId | null,
  threadId: string | null,
): string | null {
  const names = useAtomValue(
    environmentId === null ? NO_SESSION_NAMES_ATOM : sessionBotNamesFamily(environmentId),
  );
  return threadId === null ? null : (names.get(threadId) ?? null);
}

/** The app registry's current bot thread ids for one environment, for imperative watchers. */
export function readBotThreadIds(environmentId: EnvironmentId | null): ReadonlySet<string> {
  return environmentId === null
    ? EMPTY_IDS
    : appAtomRegistry.get(botThreadIdsFamily(environmentId));
}

/** Minute-quantized now, safe to read during render. */
export function useBotsNow(): number {
  return Date.parse(`${useNowMinute()}:00.000Z`);
}

const cloudSessionPlacesFamily = Atom.family((environmentId: EnvironmentId) => {
  let previousKey = "";
  let previous: ReadonlyMap<string, string> = new Map();
  return Atom.make((get) => {
    const snapshot = AsyncResult.getOrElse(get(snapshotAtom(environmentId)), () => null);
    const places = new Map<string, string>();
    for (const session of snapshot?.sessions ?? []) {
      const cloud = session.cloud;
      if (cloud === undefined) continue;
      places.set(
        session.threadId,
        cloud.state === "unreachable" ? `Can't reach ${cloud.label}` : `Runs on ${cloud.label}`,
      );
    }
    const key = [...places].map((pair) => pair.join("\t")).join("\n");
    if (key === previousKey) return previous;
    previousKey = key;
    previous = places;
    return previous;
  }).pipe(Atom.withLabel(`web-bot-cloud-session-places:${environmentId}`));
});

/**
 * Where a bot's cloud session runs ("Runs on Pair Cloud", "Can't reach Pair Cloud"), for a link
 * to it that this client can't open; null for anything else.
 */
export function useCloudSessionPlace(
  environmentId: EnvironmentId | null,
  threadId: string,
): string | null {
  const places = useAtomValue(
    environmentId === null ? NO_SESSION_NAMES_ATOM : cloudSessionPlacesFamily(environmentId),
  );
  return places.get(threadId) ?? null;
}
