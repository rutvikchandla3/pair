import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
