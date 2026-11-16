import { MemberId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";

const CACHE_TTL_MS = 5_000;
const HOME_KEY_PREFIX = "home:";

/** Every `home:<memberId>` key in `threads.json`, mapped from thread id to member id. */
export type HomeThreads = ReadonlyMap<string, string>;
export const EMPTY_HOME_THREADS: HomeThreads = new Map();

/** The index API over the same map: id lookups for both callers and tools. */
export interface HomeThreadIndex {
  readonly memberIdForThread: (threadId: string) => MemberId | undefined;
  readonly threadIdForMember: (memberId: MemberId) => string | undefined;
  readonly hasHomeThread: (memberId: MemberId) => boolean;
}

const emptyIndex: HomeThreadIndex = {
  memberIdForThread: () => undefined,
  threadIdForMember: () => undefined,
  hasHomeThread: () => false,
};

/** Up to two maps, so lookups are constant time on either side. */
export const indexHomeThreads = (threads: HomeThreads): HomeThreadIndex => {
  if (threads.size === 0) return emptyIndex;
  const memberIdByThread = new Map<string, MemberId>();
  const threadIdByMember = new Map<string, string>();
  for (const [threadId, memberId] of threads) {
    memberIdByThread.set(threadId, MemberId.make(memberId));
    threadIdByMember.set(memberId, threadId);
  }
  return {
    memberIdForThread: (threadId) => memberIdByThread.get(threadId),
    threadIdForMember: (memberId) => threadIdByMember.get(String(memberId)),
    hasHomeThread: (memberId) => threadIdByMember.has(String(memberId)),
  };
};

/** The one parser: a malformed or non-object file yields no home threads. */
export const parseHomeThreads = (json: string): HomeThreads => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return EMPTY_HOME_THREADS;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return EMPTY_HOME_THREADS;
  }
  const home = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string" || value.length === 0 || !key.startsWith(HOME_KEY_PREFIX)) {
      continue;
    }
    const member = key.slice(HOME_KEY_PREFIX.length);
    if (member.length === 0) continue;
    home.set(value, member);
  }
  return home;
};

export const homeThreadsFile = (stateDir: string, path: Path.Path): string =>
  path.join(stateDir, "chief-of-staff", "threads.json");

/** Reads `threads.json` per call; callers write it, so this uncached read is always current. */
export const loadHomeThreads = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* fileSystem
    .readFileString(homeThreadsFile(config.stateDir, path))
    .pipe(Effect.orElseSucceed(() => ""));
  return indexHomeThreads(parseHomeThreads(contents));
});

interface CachedHomeThreads {
  readonly path: string;
  readonly at: number;
  readonly value: HomeThreads;
}
let cached: CachedHomeThreads | undefined;

/**
 * Reads this server's home-thread map, at most every five seconds. Best-effort
 * and requirement-free: recording a tool call must not gate on state files or
 * add a service to every tool registration, so a missing service or file is
 * simply "no home threads".
 */
export const readHomeThreads: Effect.Effect<HomeThreads> = Effect.gen(function* () {
  const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));
  const path = Option.getOrUndefined(yield* Effect.serviceOption(Path.Path));
  const fileSystem = Option.getOrUndefined(yield* Effect.serviceOption(FileSystem.FileSystem));
  if (config === undefined || path === undefined || fileSystem === undefined) {
    return EMPTY_HOME_THREADS;
  }
  const file = homeThreadsFile(config.stateDir, path);
  const now = yield* Clock.currentTimeMillis;
  if (cached !== undefined && cached.path === file && now - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  const value = yield* fileSystem.readFileString(file).pipe(
    Effect.map(parseHomeThreads),
    Effect.orElseSucceed(() => EMPTY_HOME_THREADS),
  );
  cached = { path: file, at: now, value };
  return value;
}).pipe(Effect.catchCause(() => Effect.succeed(EMPTY_HOME_THREADS)));

/**
 * Drops the cached map, so a just-created home thread is visible at once. `ensureHome`
 * writes `home:<memberId>` and calls this; the five-second TTL would otherwise hide it.
 */
export const invalidateHomeThreads = (): void => {
  cached = undefined;
};
