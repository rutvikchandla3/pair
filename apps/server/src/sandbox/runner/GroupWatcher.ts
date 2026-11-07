import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { RunnerProcessExit } from "@t3tools/contracts/runner";

/**
 * Reads a group id, then kills that group (TERM, KILL after a grace) on EOF from the runner. It
 * runs outside the group: one inside, like `CLAUDE_GROUP_WATCH_SCRIPT`, outlives the command it
 * exec'd and dies an orphan zombie, which Effect's release waits on until init reaps it.
 */
const WATCHER_SCRIPT = [
  "read -r group || exit 0",
  "echo armed",
  "read -r _",
  'kill -TERM -"$group" 2>/dev/null',
  "sleep 10",
  'kill -KILL -"$group" 2>/dev/null',
].join("\n");

const encoder = new TextEncoder();

/**
 * Starts a watcher in the current scope, before the process it guards, so closing the scope
 * stops the guarded group first. `arm` hands it the group id and waits until it has it.
 */
export const watchGroup = Effect.fnUntraced(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const watcher = yield* spawner.spawn(
    ChildProcess.make("/bin/sh", ["-c", WATCHER_SCRIPT, "t3-group-watch"], {
      env: { PATH: "/usr/bin:/bin" },
      detached: true,
      stdin: Stream.fromQueue(input),
      stdout: "pipe",
      stderr: "ignore",
    }),
  );
  return (group: number) =>
    Queue.offer(input, encoder.encode(`${group}\n`)).pipe(
      Effect.andThen(Stream.runDrain(Stream.take(watcher.stdout, 1))),
    );
});

export interface WrappedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly uid?: number | undefined;
  readonly gid?: number | undefined;
}

/** argv that runs the command as `uid` when one is given (the runner is root, agents are not). */
export const commandLine = (input: WrappedCommand): readonly [string, Array<string>] =>
  input.uid === undefined
    ? [input.command, [...input.args]]
    : [
        "/usr/bin/setpriv",
        [
          `--reuid=${input.uid}`,
          `--regid=${input.gid ?? input.uid}`,
          "--init-groups",
          "--",
          input.command,
          ...input.args,
        ],
      ];

/**
 * A detached spawn in its own group, behind a watcher. Effect's spawner signals the whole group
 * on scope close, escalating to SIGKILL after `forceKillAfterMs`; the watcher covers the runner
 * itself dying.
 */
export const spawnWatched = Effect.fnUntraced(function* (
  input: WrappedCommand & {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly stdin: ChildProcess.CommandInput;
    readonly stdout: ChildProcess.CommandOutput;
    readonly stderr: ChildProcess.CommandOutput;
    readonly additionalFds?: Record<`fd${number}`, ChildProcess.AdditionalFdConfig> | undefined;
    readonly killSignal?: ChildProcess.Signal | undefined;
    readonly forceKillAfterMs?: number | undefined;
  },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const arm = yield* watchGroup();
  const [command, args] = commandLine(input);
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, {
      cwd: input.cwd,
      env: input.env,
      extendEnv: false,
      detached: true,
      stdin: input.stdin,
      stdout: input.stdout,
      stderr: input.stderr,
      additionalFds: input.additionalFds,
      killSignal: input.killSignal ?? "SIGTERM",
      forceKillAfter: Duration.millis(input.forceKillAfterMs ?? 2_000),
    }),
  );
  yield* arm(child.pid);
  return child;
});

// Effect's spawner reports a signal exit only as the text of a failed `exitCode`.
const SIGNAL_EXIT = /receipt of signal: '(\w+)'/;

export const exitOf = (child: ChildProcessSpawner.ChildProcessHandle) =>
  child.exitCode.pipe(
    Effect.map((exitCode): RunnerProcessExit => ({ exitCode, signal: null })),
    Effect.catchTags({
      PlatformError: (error) =>
        Effect.succeed<RunnerProcessExit>({
          exitCode: null,
          signal: SIGNAL_EXIT.exec(error.reason.description ?? "")?.[1] ?? null,
        }),
    }),
  );
