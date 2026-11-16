import { MemberId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";

/** `threads.json` keys for a member's persistent home thread. */
const HOME_KEY_PREFIX = "home:";

/**
 * Which thread is which member's home thread, read from `threads.json`. Pure: an
 * unreadable or malformed file yields no entries rather than an error.
 */
export interface HomeThreadIndex {
  readonly memberIdForThread: (threadId: string) => MemberId | undefined;
  readonly threadIdForMember: (memberId: MemberId) => string | undefined;
  readonly hasHomeThread: (memberId: MemberId) => boolean;
}

const EMPTY: HomeThreadIndex = {
  memberIdForThread: () => undefined,
  threadIdForMember: () => undefined,
  hasHomeThread: () => false,
};

export const parseHomeThreads = (contents: string): HomeThreadIndex => {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    return EMPTY;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return EMPTY;
  const memberIdByThread = new Map<string, MemberId>();
  const threadIdByMember = new Map<string, string>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.startsWith(HOME_KEY_PREFIX) || typeof value !== "string" || value.length === 0) {
      continue;
    }
    const member = key.slice(HOME_KEY_PREFIX.length);
    if (member.length === 0) continue;
    memberIdByThread.set(value, MemberId.make(member));
    threadIdByMember.set(member, value);
  }
  if (memberIdByThread.size === 0) return EMPTY;
  return {
    memberIdForThread: (threadId) => memberIdByThread.get(threadId),
    threadIdForMember: (memberId) => threadIdByMember.get(String(memberId)),
    hasHomeThread: (memberId) => threadIdByMember.has(String(memberId)),
  };
};

export const homeThreadsFile = (stateDir: string, path: Path.Path): string =>
  path.join(stateDir, "chief-of-staff", "threads.json");

/** Reads `threads.json` per call; callers write it, so a cached copy would go stale. */
export const loadHomeThreads = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* fileSystem
    .readFileString(homeThreadsFile(config.stateDir, path))
    .pipe(Effect.orElseSucceed(() => ""));
  return parseHomeThreads(contents);
});
