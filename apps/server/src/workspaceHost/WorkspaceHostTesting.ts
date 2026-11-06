import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as WorkspaceHosts from "./WorkspaceHosts.ts";

const missing = (service: string) => new Error(`no ${service} in this test`);
const dieOnUse = (service: string) => () => Effect.die(missing(service));

const missingSpawner = ChildProcessSpawner.make(dieOnUse("ChildProcessSpawner"));

const missingPty = PtyAdapter.PtyAdapter.of({ spawn: dieOnUse("PtyAdapter") });

// Dies rather than failing with NotFound, so a test cannot mistake it for an empty disk.
const missingFileSystem = new Proxy(FileSystem.makeNoop({}), {
  get: (target, key, receiver) => {
    const value: unknown = Reflect.get(target, key, receiver);
    if (typeof value !== "function") return value;
    return () => {
      throw missing("FileSystem");
    };
  },
});

/**
 * A WorkspaceHosts whose local host is built from the test's own services. A spawner, file system
 * or PTY adapter the test does not provide dies on use.
 */
export const layerFromContext: Layer.Layer<WorkspaceHosts.WorkspaceHosts> = Layer.effect(
  WorkspaceHosts.WorkspaceHosts,
  Effect.gen(function* () {
    const spawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
    const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
    const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
    return yield* WorkspaceHosts.make.pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        Option.getOrElse(spawner, () => missingSpawner),
      ),
      Effect.provideService(
        FileSystem.FileSystem,
        Option.getOrElse(fileSystem, () => missingFileSystem),
      ),
      Effect.provideService(
        PtyAdapter.PtyAdapter,
        Option.getOrElse(pty, () => missingPty),
      ),
    );
  }),
);

/** Operations the recording host saw, in call order. */
export interface RecordedOps {
  /** `"git rev-parse"`: the executable's name and its first argument that is not an option. */
  readonly spawns: Array<string>;
  /** FileSystem method names: `"exists"`, `"stat"`, `"copyFile"`, ... */
  readonly files: Array<string>;
}

const optionsWithValue = new Set(["-C", "-c", "--git-dir", "--work-tree"]);

// Skips git's global options so `git -C <cwd> -c k=v status` records as `git status`.
const commandSummary = (command: ChildProcess.Command): string => {
  if (command._tag === "PipedCommand") return commandSummary(command.left);
  const args = command.args.map(String);
  let index = 0;
  while (index < args.length && args[index]!.startsWith("-")) {
    index += optionsWithValue.has(args[index]!) ? 2 : 1;
  }
  const name = command.command
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.(?:exe|cmd)$/i, "");
  return args[index] === undefined ? name : `${name} ${args[index]}`;
};

/**
 * Wraps the context's spawner and FileSystem and builds WorkspaceHosts from the wrapped pair.
 * It also provides the wrapped pair itself, so code that reads them directly records the same ops.
 */
export const makeRecording = () => {
  const ops: RecordedOps = { spawns: [], files: [] };
  const layerRecorded = Layer.effectContext(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const recordingSpawner = ChildProcessSpawner.make((command) => {
        ops.spawns.push(commandSummary(command));
        return spawner.spawn(command);
      });
      const recordingFileSystem = new Proxy(fileSystem, {
        get: (target, key, receiver) => {
          const value: unknown = Reflect.get(target, key, receiver);
          if (typeof value !== "function") return value;
          return (...args: ReadonlyArray<unknown>) => {
            ops.files.push(String(key));
            return Reflect.apply(value, target, args);
          };
        },
      });
      return Context.make(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner).pipe(
        Context.add(FileSystem.FileSystem, recordingFileSystem),
      );
    }),
  );
  return { ops, layer: layerFromContext.pipe(Layer.provideMerge(layerRecorded)) };
};
