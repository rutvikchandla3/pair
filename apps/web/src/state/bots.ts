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
