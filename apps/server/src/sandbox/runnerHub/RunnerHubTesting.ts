import {
  type RUNNER_METHODS,
  RUNNER_PROTOCOL_VERSION,
  RunnerRpcGroup,
} from "@t3tools/contracts/runner";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
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

import * as HandleTable from "../runner/HandleTable.ts";
import * as RunnerMain from "../runner/main.ts";
import { RunnerConfig } from "../runner/RunnerConfig.ts";
import { RunnerCredential } from "../runner/RunnerSocketServer.ts";
import * as RunnerTesting from "../runner/runnerTesting.ts";
import { RunnerHub } from "./RunnerHub.ts";

type RunnerMethod = (typeof RUNNER_METHODS)[keyof typeof RUNNER_METHODS];

const closed = new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1006 }) });

/** Faults armed before the pair carries its first frame. */
export interface PairFaults {
  /** Once this many bytes have gone runner to hub, the next frame vanishes and the pair closes. */
  readonly dropAfterBytes?: number;
}

/**
 * Two in-memory sockets joined back to back. Either side ending its reader, writing a close
 * event, or `drop` closes both, and every pending `pull` fails as a WebSocket's would.
 */
const socketPair = Effect.fnUntraced(function* (faults: PairFaults) {
  const toHub = yield* Queue.unbounded<Uint8Array | string>();
  const toRunner = yield* Queue.unbounded<Uint8Array | string>();
  const done = yield* Deferred.make<void>();
  const close = Deferred.succeed(done, undefined);
  const hubReading = Latch.makeUnsafe(true);
  let halfOpen = false;
  let bytesToHub = 0;
  const end = (
    inbox: Queue.Queue<Uint8Array | string>,
    outbox: Queue.Queue<Uint8Array | string>,
    reading: Latch.Latch | undefined,
  ): Socket.Socket => {
    const write = Effect.fnUntraced(function* (chunk: Uint8Array | string | Socket.CloseEvent) {
      if (Socket.isCloseEvent(chunk)) return yield* close;
      if (yield* Deferred.isDone(done)) return yield* closed;
      if (halfOpen) return;
      if (outbox === toHub && faults.dropAfterBytes !== undefined) {
        if (bytesToHub >= faults.dropAfterBytes) return yield* close;
        bytesToHub += chunk.length;
      }
      yield* Queue.offer(outbox, chunk);
    });
    const take = Queue.takeAll(inbox);
    return Socket.make({
      reader: Effect.acquireRelease(
        Effect.succeed({
          pull: Effect.raceFirst(
            reading === undefined ? take : take.pipe(Effect.tap(() => reading.await)),
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
    hub: end(toHub, toRunner, hubReading),
    runner: end(toRunner, toHub, undefined),
    drop: close.pipe(Effect.asVoid),
    closed: Deferred.await(done),
    stallReader: Effect.sync(() => hubReading.closeUnsafe()),
    resumeReader: Effect.sync(() => hubReading.openUnsafe()),
    halfOpen: Effect.sync(() => {
      halfOpen = true;
    }),
  };
});

export interface TestRunnerConnection {
  /** Closes the pair, as a network drop would. */
  readonly drop: Effect.Effect<void>;
  /** Waits until either side has closed the pair. */
  readonly closed: Effect.Effect<void>;
  /** Waits until the runner has finished with its end of the pair (its lease is running). */
  readonly runnerEnded: Effect.Effect<void>;
  /** The hub stops reading: frames to it queue up, as behind a stalled TCP window. */
  readonly stallReader: Effect.Effect<void>;
  readonly resumeReader: Effect.Effect<void>;
  /** Frames either way vanish and nothing closes, as after a silent network change. */
  readonly halfOpen: Effect.Effect<void>;
  readonly served: Fiber.Fiber<void>;
}

export interface TestRunner {
  /** What the runner would dial with now: its enrollment, then the token `runner.hello` gave it. */
  readonly authorization: Effect.Effect<Redacted.Redacted<string>>;
  /** Authenticates with the hub, as the route does, and serves the pair until it ends. */
  /** The runner's own table, for what the socket cannot show (pressure, live handles). */
  readonly table: HandleTable.HandleTable["Service"];
  /** Where this runner's Unix forwards listen, as `/run/pair-runner` in a sandbox. */
  readonly stateDir: string;
  readonly connect: (
    authorization?: Redacted.Redacted<string>,
    faults?: PairFaults,
  ) => Effect.Effect<
    TestRunnerConnection,
    Effect.Error<ReturnType<RunnerHub["Service"]["authenticate"]>>,
    RunnerHub | Scope.Scope
  >;
}

/**
 * One in-process runner: the real handlers behind a real `RpcServer` with the runner's own
 * windowed, leased protocol, joined to the hub by `socketPair`. Each call is a new runner boot
 * (its own `runnerBootId` and handle table).
 */
export const makeRunner = Effect.fn("RunnerHubTesting.makeRunner")(function* (
  enrollment: Redacted.Redacted<string>,
  options: RunnerTesting.RunnerTestingOptions & {
    /** Methods this runner does not serve, as a build from before they existed. */
    readonly without?: ReadonlyArray<RunnerMethod>;
  } = {},
) {
  const sockets = yield* Queue.unbounded<readonly [Socket.Socket, Deferred.Deferred<void>]>();
  const socketServer = SocketServer.SocketServer.of({
    address: NetAddress.unixPathAddress("in-process-runner"),
    run: Effect.fn("RunnerHubTesting.acceptSockets")(function* <R, E, _>(
      handler: (socket: Socket.Socket) => Effect.Effect<_, E, R>,
    ) {
      while (true) {
        const [socket, ended] = yield* Queue.take(sockets);
        yield* Effect.forkChild(
          handler(socket).pipe(Effect.ensuring(Deferred.succeed(ended, undefined))),
        );
      }
    }),
  });
  const context = yield* Layer.build(
    RpcServer.layer(RunnerRpcGroup.omit(...(options.without ?? []))).pipe(
      Layer.provide(RunnerMain.layerProtocol),
      Layer.provide(Layer.succeed(SocketServer.SocketServer, socketServer)),
      Layer.provide(RpcSerialization.layerSchemaBinary({ maxFrameSize: 256 * 1024 + 1024 })),
      Layer.provideMerge(Layer.fresh(RunnerTesting.layerWith(options))),
    ),
  );
  const credential = Context.get(context, RunnerCredential);
  const table = Context.get(context, HandleTable.HandleTable);
  const { stateDir } = Context.get(context, RunnerConfig);
  let enrolled = false;
  const authorization = credential.authorization.pipe(
    Effect.map((current) =>
      enrolled ? current : Redacted.make(`Enroll ${Redacted.value(enrollment)}`),
    ),
  );

  const connect: TestRunner["connect"] = Effect.fn("RunnerHubTesting.connect")(function* (
    explicit,
    faults = {},
  ) {
    const hub = yield* RunnerHub;
    const runner = yield* hub.authenticate(
      Headers.fromInput({
        authorization: Redacted.value(explicit ?? (yield* authorization)),
        "x-pair-runner-protocol": String(RUNNER_PROTOCOL_VERSION),
      }),
    );
    enrolled = true;
    const pair = yield* socketPair(faults);
    const ended = yield* Deferred.make<void>();
    yield* Queue.offer(sockets, [pair.runner, ended]);
    const served = yield* hub.serve(runner, pair.hub).pipe(Effect.forkScoped);
    return {
      drop: pair.drop,
      closed: pair.closed,
      runnerEnded: Deferred.await(ended),
      stallReader: pair.stallReader,
      resumeReader: pair.resumeReader,
      halfOpen: pair.halfOpen,
      served,
    };
  });

  return { authorization, table, stateDir, connect } satisfies TestRunner;
});
