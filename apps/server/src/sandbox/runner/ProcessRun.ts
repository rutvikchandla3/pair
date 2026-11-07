import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type {
  RunnerProcessRunInput,
  RunnerProcessRunResult,
  RunnerProcessRunStreamEvent,
} from "@t3tools/contracts/runner";

import * as GroupWatcher from "./GroupWatcher.ts";
import { toSystemError } from "./HandleTable.ts";

// ProcessRunner's defaults, so a call behaves the same in a sandbox as on the server.
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const FORCE_KILL_AFTER_MS = 1_000;

class OutputLimit extends Schema.TaggedError<OutputLimit>()("OutputLimit", {
  fd: Schema.Literals([1, 2]),
}) {}

const spawnRun = (input: RunnerProcessRunInput) =>
  GroupWatcher.spawnWatched({
    command: input.command,
    args: input.args,
    uid: input.uid,
    gid: input.gid,
    cwd: input.cwd,
    env: input.env,
    stdin: input.stdin === undefined ? "ignore" : Stream.make(input.stdin),
    stdout: "pipe",
    stderr: "pipe",
    forceKillAfterMs: FORCE_KILL_AFTER_MS,
  });

const collect = Effect.fn("ProcessRun.collect")(function* (
  source: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  fd: 1 | 2,
  maxBytes: number,
  stopOnLimit: boolean,
) {
  const chunks: Array<Uint8Array> = [];
  let kept = 0;
  let truncated = false;
  yield* Stream.runForEach(source, (chunk) => {
    const room = maxBytes - kept;
    if (chunk.byteLength > room) {
      if (stopOnLimit) return Effect.fail(new OutputLimit({ fd }));
      truncated = true;
    }
    const taken = chunk.byteLength > room ? chunk.subarray(0, Math.max(room, 0)) : chunk;
    if (taken.byteLength > 0) chunks.push(taken);
    kept += taken.byteLength;
    return Effect.void;
  });
  return { bytes: Buffer.concat(chunks, kept), truncated };
});

/**
 * `process.run`: ProcessRunner's caps and timeout over raw bytes, behind the group watcher. A
 * cap hit in `error` mode kills the group and reports the stream as truncated; the server turns
 * that into its own limit error.
 */
export const run = Effect.fn("ProcessRun.run")(function* (input: RunnerProcessRunInput) {
  const maxBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stopOnLimit = (input.outputMode ?? "error") === "error";
  const empty = new Uint8Array();
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnRun(input);
      const [stdout, stderr] = yield* Effect.all(
        [
          collect(child.stdout, 1, maxBytes, stopOnLimit),
          collect(child.stderr, 2, maxBytes, stopOnLimit),
        ],
        { concurrency: 2 },
      );
      const exit = yield* GroupWatcher.exitOf(child);
      return {
        stdout: stdout.bytes,
        stderr: stderr.bytes,
        ...exit,
        timedOut: false,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      } satisfies RunnerProcessRunResult;
    }),
  ).pipe(
    Effect.catchTags({
      OutputLimit: (limit) =>
        Effect.succeed<RunnerProcessRunResult>({
          stdout: empty,
          stderr: empty,
          exitCode: null,
          signal: null,
          timedOut: false,
          stdoutTruncated: limit.fd === 1,
          stderrTruncated: limit.fd === 2,
        }),
    }),
    Effect.mapError(toSystemError),
    Effect.timeoutOption(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );
  return Option.getOrElse(result, (): RunnerProcessRunResult => ({
    stdout: empty,
    stderr: empty,
    exitCode: null,
    signal: null,
    timedOut: true,
    stdoutTruncated: false,
    stderrTruncated: false,
  }));
});

/** `process.runStream`: output as it arrives, then one `exit`. */
export const runStream = (input: RunnerProcessRunInput) =>
  Stream.callback<
    RunnerProcessRunStreamEvent,
    PlatformError.PlatformError,
    ChildProcessSpawner.ChildProcessSpawner
  >((queue) =>
    Effect.gen(function* () {
      const child = yield* spawnRun(input);
      const forward = (source: Stream.Stream<Uint8Array, PlatformError.PlatformError>, fd: 1 | 2) =>
        Stream.runForEach(source, (data) => Queue.offer(queue, { _tag: "output", fd, data }));
      const exit = yield* Effect.all([forward(child.stdout, 1), forward(child.stderr, 2)], {
        concurrency: 2,
      }).pipe(
        Effect.andThen(GroupWatcher.exitOf(child)),
        Effect.map((exit) => ({ ...exit, timedOut: false })),
        Effect.timeoutOption(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        Effect.map(Option.getOrElse(() => ({ exitCode: null, signal: null, timedOut: true }))),
      );
      yield* Queue.offer(queue, { _tag: "exit", ...exit });
      yield* Queue.end(queue);
    }),
  ).pipe(Stream.mapError(toSystemError));
