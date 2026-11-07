// @effect-diagnostics nodeBuiltinImport:off -- the Claude Agent SDK's spawn hook takes Node streams and events.
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";

import type { SpawnOptions as ClaudeSpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { ProcessGroupProcess, WorkspaceHost } from "../../workspaceHost/WorkspaceHost.ts";

/** The SDK runs a script entry with Node: `[script, ...cli args]`. The sandbox has its own `claude`. */
const SCRIPT_EXTENSIONS = [".js", ".mjs", ".tsx", ".ts", ".jsx"];
const SIGNALLED = /signal: '(SIG[A-Z0-9]+)'/;
const STDIN_FRAMES = 16;

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

/**
 * The SDK's `SpawnedProcess` over a sandbox host's process handle (02 §7). Stdout is pulled only as
 * the SDK reads, so a slow reader pauses the runner's pipe; `"exit"` follows stderr's end.
 */
export const makeSandboxClaudeProcess = Effect.fnUntraced(function* (input: {
  readonly host: Pick<WorkspaceHost, "spawner">;
  readonly onStderr: (text: string) => void;
}) {
  // The SDK's spawn hook is synchronous; the process's fibers run on the caller's context.
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  return (options: ClaudeSpawnOptions) => spawn({ ...input, runFork }, options);
});

const spawn = (
  input: {
    readonly host: Pick<WorkspaceHost, "spawner">;
    readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
    readonly onStderr: (text: string) => void;
  },
  options: ClaudeSpawnOptions,
): ProcessGroupProcess => {
  const [first, ...rest] = options.args;
  const args =
    first !== undefined && SCRIPT_EXTENSIONS.some((extension) => first.endsWith(extension))
      ? rest
      : options.args;
  const events = new NodeEvents.EventEmitter();
  const state = {
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  };
  const ready = Deferred.makeUnsafe<
    ChildProcessSpawner.ChildProcessHandle,
    PlatformError.PlatformError
  >();
  const stdinFrames = Effect.runSync(Queue.bounded<Uint8Array, Cause.Done>(STDIN_FRAMES));
  const scope = Scope.makeUnsafe();
  // Releasing the handle drops the runner's unsent output: wait until the SDK has read it all,
  // let go of stdout, or killed the CLI.
  const stdoutSettled = Deferred.makeUnsafe<void>();

  const settle = (
    exit: Exit.Exit<
      Exit.Exit<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>,
      PlatformError.PlatformError
    >,
  ) =>
    Effect.sync(() => {
      if (Exit.isFailure(exit)) {
        Deferred.doneUnsafe(stdoutSettled, Exit.void);
        events.emit("error", new Error(Cause.pretty(exit.cause)));
        return;
      }
      const status = exit.value;
      if (Exit.isSuccess(status)) {
        state.exitCode = status.value;
      } else {
        const signal = SIGNALLED.exec(Cause.pretty(status.cause))?.[1] as
          | NodeJS.Signals
          | undefined;
        state.signalCode = signal ?? "SIGKILL";
      }
      events.emit("exit", state.exitCode, state.signalCode);
    }).pipe(
      Effect.andThen(Queue.shutdown(stdinFrames)),
      Effect.andThen(Deferred.await(stdoutSettled)),
      Effect.andThen(Scope.close(scope, Exit.void)),
    );

  input.runFork(
    Effect.gen(function* () {
      const handle = yield* input.host.spawner.spawn(
        ChildProcess.make("claude", args, {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          env: options.env,
          extendEnv: false,
          stdin: Stream.fromQueue(stdinFrames),
        }),
      );
      yield* Deferred.succeed(ready, handle);
      yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((text) => Effect.sync(() => input.onStderr(text))),
        Effect.ignore,
      );
      return yield* Effect.exit(handle.exitCode);
    }).pipe(
      Effect.tapError((error) => Deferred.fail(ready, error)),
      Scope.provide(scope),
      Effect.exit,
      Effect.flatMap(settle),
    ),
  );

  const kill = (signal: NodeJS.Signals) => {
    state.killed = true;
    Deferred.doneUnsafe(stdoutSettled, Exit.void);
    input.runFork(
      Deferred.await(ready).pipe(
        Effect.flatMap((handle) => handle.kill({ killSignal: signal })),
        Effect.ignore,
      ),
    );
    return true;
  };
  options.signal?.addEventListener("abort", () => kill("SIGTERM"), { once: true });

  const stdout = NodeStream.Readable.from(
    Stream.unwrap(Effect.map(Deferred.await(ready), (handle) => handle.stdout)).pipe(
      Stream.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
      // A failed spawn reports through "error"; stdout just ends.
      Stream.catchCause(() => Stream.empty),
      Stream.ensuring(Deferred.done(stdoutSettled, Exit.void)),
      Stream.toAsyncIterable,
    ),
    { objectMode: false },
  );
  const stdin = new NodeStream.Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      input.runFork(Queue.offer(stdinFrames, new Uint8Array(chunk))).addObserver(() => callback());
    },
    final: (callback) => {
      input.runFork(Queue.end(stdinFrames)).addObserver(() => callback());
    },
  });

  const on = (event: "exit" | "error", listener: ExitListener | ErrorListener) => {
    events.on(event, listener);
  };
  return {
    stdin,
    stdout,
    stderr: null,
    get killed() {
      return state.killed;
    },
    get exitCode() {
      return state.exitCode;
    },
    get signalCode() {
      return state.signalCode;
    },
    kill,
    on,
    once: (event: "exit" | "error", listener: ExitListener | ErrorListener) => {
      events.once(event, listener);
    },
    off: (event: "exit" | "error", listener: ExitListener | ErrorListener) => {
      events.off(event, listener);
    },
  };
};
