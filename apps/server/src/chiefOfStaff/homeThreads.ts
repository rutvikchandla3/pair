import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";

const CACHE_TTL_MS = 5_000;
const HOME_PREFIX = "home:";

export type HomeThreads = ReadonlyMap<string, string>;

export const EMPTY_HOME_THREADS: HomeThreads = new Map();

/** `home:<memberId>` keys map the member's home thread id to the member; other keys are not home threads. */
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
    if (typeof value !== "string" || !key.startsWith(HOME_PREFIX)) continue;
    home.set(value, key.slice(HOME_PREFIX.length));
  }
  return home;
};

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
  const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig.ServerConfig));
  const path = Option.getOrUndefined(yield* Effect.serviceOption(Path.Path));
  const fileSystem = Option.getOrUndefined(yield* Effect.serviceOption(FileSystem.FileSystem));
  if (config === undefined || path === undefined || fileSystem === undefined) {
    return EMPTY_HOME_THREADS;
  }
  const file = path.join(config.stateDir, "chief-of-staff", "threads.json");
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
