import { RUNNER_PROTOCOL_VERSION, RunnerRpcGroup } from "@t3tools/contracts/runner";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as Headers from "effect/http/Headers";
import * as NetAddress from "effect/net/NetAddress";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Socket from "effect/socket/Socket";
import * as SocketServer from "effect/socket/SocketServer";

import { RunnerCredential } from "../runner/RunnerSocketServer.ts";
import * as RunnerTesting from "../runner/runnerTesting.ts";
import { RunnerHub } from "./RunnerHub.ts";

const closed = new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1006 }) });

/**
 * Two in-memory sockets joined back to back. Either side ending its reader, writing a close
 * event, or `drop` closes both, and every pending `pull` fails as a WebSocket's would.
 */
const socketPair = Effect.gen(function* () {
  const toHub = yield* Queue.unbounded<Uint8Array | string>();
  const toRunner = yield* Queue.unbounded<Uint8Array | string>();
  const done = yield* Deferred.make<void>();
  const close = Deferred.succeed(done, undefined);
  const end = (
    inbox: Queue.Queue<Uint8Array | string>,
    outbox: Queue.Queue<Uint8Array | string>,
  ): Socket.Socket => {
    const write = (chunk: Uint8Array | string | Socket.CloseEvent) =>
      Socket.isCloseEvent(chunk)
        ? close.pipe(Effect.asVoid)
        : Deferred.isDone(done).pipe(
            Effect.flatMap((isDone) =>
              isDone ? Effect.fail(closed) : Queue.offer(outbox, chunk).pipe(Effect.asVoid),
            ),
          );
    return Socket.make({
      reader: Effect.acquireRelease(
        Effect.succeed({
          pull: Effect.raceFirst(
            Queue.takeAll(inbox),
            Deferred.await(done).pipe(Effect.andThen(Effect.fail(closed))),
          ),
          upgrade: () => Effect.void,
        }),
        () => close,
      ),
      writer: Effect.succeed({
        write,
        writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }),
      }),
    });
  };
  return {
    hub: end(toHub, toRunner),
    runner: end(toRunner, toHub),
    drop: close.pipe(Effect.asVoid),
    closed: Deferred.await(done),
  };
});

export interface TestRunnerConnection {
  /** Closes the pair, as a network drop would. */
  readonly drop: Effect.Effect<void>;
  /** Waits until either side has closed the pair. */
  readonly closed: Effect.Effect<void>;
  readonly served: Fiber.Fiber<void>;
}

export interface TestRunner {
  /** What the runner would dial with now: its enrollment, then the token `runner.hello` gave it. */
  readonly authorization: Effect.Effect<Redacted.Redacted<string>>;
  /** Authenticates with the hub, as the route does, and serves the pair until it ends. */
  readonly connect: (
    authorization?: Redacted.Redacted<string>,
  ) => Effect.Effect<
    TestRunnerConnection,
    Effect.Error<ReturnType<RunnerHub["Service"]["authenticate"]>>,
    RunnerHub | Scope.Scope
  >;
}

/**
 * One in-process runner: 1.6's real handlers behind a real `RpcServer`, joined to the hub by
 * `socketPair`. Each call is a new runner boot (its own `runnerBootId` and handle table).
 */
export const makeRunner = Effect.fn("RunnerHubTesting.makeRunner")(function* (
  enrollment: Redacted.Redacted<string>,
) {
  const sockets = yield* Queue.unbounded<Socket.Socket>();
  const socketServer = SocketServer.SocketServer.of({
    address: NetAddress.unixPathAddress("in-process-runner"),
    run: Effect.fn("RunnerHubTesting.acceptSockets")(function* <R, E, _>(
      handler: (socket: Socket.Socket) => Effect.Effect<_, E, R>,
    ) {
      while (true) yield* Effect.forkChild(handler(yield* Queue.take(sockets)));
    }),
  });
  const context = yield* Layer.build(
    RpcServer.layer(RunnerRpcGroup).pipe(
      Layer.provide(RpcServer.layerProtocolSocketServer),
      Layer.provide(Layer.succeed(SocketServer.SocketServer, socketServer)),
      Layer.provide(RpcSerialization.layerSchemaBinary({ maxFrameSize: 256 * 1024 + 1024 })),
      Layer.provideMerge(Layer.fresh(RunnerTesting.layer)),
    ),
  );
  const credential = Context.get(context, RunnerCredential);
  let enrolled = false;
  const authorization = credential.authorization.pipe(
    Effect.map((current) =>
      enrolled ? current : Redacted.make(`Enroll ${Redacted.value(enrollment)}`),
    ),
  );

  const connect: TestRunner["connect"] = Effect.fn("RunnerHubTesting.connect")(
    function* (explicit) {
      const hub = yield* RunnerHub;
      const runner = yield* hub.authenticate(
        Headers.fromInput({
          authorization: Redacted.value(explicit ?? (yield* authorization)),
          "x-pair-runner-protocol": String(RUNNER_PROTOCOL_VERSION),
        }),
      );
      enrolled = true;
      const pair = yield* socketPair;
      yield* Queue.offer(sockets, pair.runner);
      const served = yield* hub.serve(runner, pair.hub).pipe(Effect.forkScoped);
      return { drop: pair.drop, closed: pair.closed, served };
    },
  );

  return { authorization, connect } satisfies TestRunner;
});
