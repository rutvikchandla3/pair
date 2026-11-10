// @effect-diagnostics nodeBuiltinImport:off -- node:http servers and node:net sockets read a Node duplex.
import * as NodeStream from "node:stream";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as Stream from "effect/Stream";

import type { WorkspaceHostTcpConnection } from "../../workspaceHost/WorkspaceHost.ts";

/**
 * A Node duplex over a connection the runner carries, with backpressure both ways. `pump` feeds
 * what the machine sends into it; `closed` completes when the duplex is destroyed.
 */
export const toDuplex = (
  connection: WorkspaceHostTcpConnection,
  runFork: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => {
    readonly addObserver: (observer: (exit: Exit.Exit<A, E>) => void) => unknown;
  },
  closed: Deferred.Deferred<void>,
) => {
  const wanted = Latch.makeUnsafe(true);
  const settle =
    (callback: (error?: Error | null) => void) => (exit: Exit.Exit<unknown, unknown>) =>
      callback(Exit.isSuccess(exit) ? null : new Error("the forwarded connection failed"));
  const duplex = new NodeStream.Duplex({
    read: () => wanted.openUnsafe(),
    write: (chunk: Buffer, _encoding, callback) => {
      runFork(connection.write(chunk)).addObserver(settle(callback));
    },
    final: (callback) => {
      runFork(connection.close).addObserver(settle(callback));
    },
    destroy: (error, callback) => {
      Deferred.doneUnsafe(closed, Exit.void);
      callback(error);
    },
  });
  // node:http sets socket timeouts and options; the runner's socket owns them.
  Object.assign(duplex, {
    setTimeout: () => duplex,
    setNoDelay: () => duplex,
    setKeepAlive: () => duplex,
  });
  const pump = connection.read.pipe(
    Stream.runForEach((chunk) =>
      Effect.suspend(() => {
        if (duplex.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
          return Effect.void;
        }
        wanted.closeUnsafe();
        return wanted.await;
      }),
    ),
    Effect.andThen(Effect.sync(() => duplex.push(null))),
    Effect.catchCause(() => Effect.sync(() => duplex.destroy())),
  );
  return { duplex, pump };
};
