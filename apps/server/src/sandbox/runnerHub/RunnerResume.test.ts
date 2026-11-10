// @effect-diagnostics nodeBuiltinImport:off -- the test plays a server on the machine's loopback.
import * as NodeNet from "node:net";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { SandboxId } from "@t3tools/contracts";
import type {
  RunnerHandleId,
  RunnerLimits,
  RunnerProcessSpawnInput,
} from "@t3tools/contracts/runner";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import type * as HandleTable from "../runner/HandleTable.ts";
import type { RunnerPressure } from "../runner/HandleTable.ts";
import type { RunnerConnection } from "./RunnerConnection.ts";
import * as RunnerGrants from "./RunnerGrants.ts";
import * as RunnerHub from "./RunnerHub.ts";
import * as RunnerHubTesting from "./RunnerHubTesting.ts";
import * as WorkspaceHostTesting from "../../workspaceHost/WorkspaceHostTesting.ts";

const KiB = 1024;
const MiB = 1024 * KiB;
const sandbox = SandboxId.make("sbx_000000000000000000e8");
const env = { PATH: "/usr/local/bin:/usr/bin:/bin" };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const limitsWith = (overrides: Partial<RunnerLimits> = {}): RunnerLimits => ({
  windowBytes: 16 * KiB,
  windowChunks: 16,
  handleBufferBytes: 4 * MiB,
  ptyBufferBytes: MiB,
  sandboxBufferBytes: 64 * MiB,
  ...overrides,
});

const layerFor = (
  limits: RunnerLimits,
  ingressBytesPerSecond = RunnerHub.DEFAULT_INGRESS_BYTES_PER_SECOND,
) =>
  RunnerHub.layerWith({ limits, ingressBytesPerSecond }).pipe(
    Layer.provideMerge(WorkspaceHostTesting.layerFromContext),
    Layer.provideMerge(RunnerGrants.layer),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
  );

type Services = Layer.Success<ReturnType<typeof layerFor>> | Scope.Scope;

const run =
  (limits: RunnerLimits = limitsWith(), ingressBytesPerSecond?: number) =>
  <A, E>(effect: Effect.Effect<A, E, Services>) =>
    effect.pipe(Effect.scoped, Effect.provide(layerFor(limits, ingressBytesPerSecond)));

const shell = (script: string, extra: Partial<RunnerProcessSpawnInput> = {}) =>
  ({
    command: "/bin/sh",
    args: ["-c", script],
    cwd: "/",
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    extraFds: [],
    ...extra,
  }) satisfies RunnerProcessSpawnInput;

/** A runner of a new boot, connected and attached, with the facts the hub reports from here on. */
const boot = Effect.fnUntraced(function* (faults?: RunnerHubTesting.PairFaults) {
  const hub = yield* RunnerHub.RunnerHub;
  const facts = yield* Queue.unbounded<RunnerHub.RunnerHubFact>();
  yield* Stream.runForEach(hub.facts, (fact) => Queue.offer(facts, fact)).pipe(Effect.forkScoped);
  const runner = yield* RunnerHubTesting.makeRunner(yield* hub.mintEnrollment(sandbox, 1));
  const first = yield* runner.connect(undefined, faults);
  const connection = yield* hub.connection(sandbox);
  assert.deepInclude(yield* Queue.take(facts), { _tag: "attached" });
  return { hub, facts, runner, first, connection, bearer: yield* runner.authorization };
});

const awaitStatus = (tag: RunnerHub.RunnerConnectionStatus["_tag"]) =>
  RunnerHub.RunnerHub.use((hub) =>
    hub.status(sandbox).pipe(
      Stream.filter((status) => status._tag === tag),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    ),
  );

const awaitPressure = (
  table: HandleTable.HandleTable["Service"],
  predicate: (pressure: RunnerPressure) => boolean,
) => table.pressure.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));

const spawn = (connection: RunnerConnection, input: RunnerProcessSpawnInput) =>
  connection.client.pipe(Effect.flatMap((client) => client["process.spawn"](input)));

const readText = (connection: RunnerConnection, handle: RunnerHandleId) =>
  connection.output(handle, "fd:1").pipe(
    Stream.runCollect,
    Effect.map((chunks) => {
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return decoder.decode(bytes);
    }),
  );

/** Text from a queue of decoded chunks, until `length` characters have arrived. */
const takeText = Effect.fnUntraced(function* (queue: Queue.Queue<string>, length: number) {
  let text = "";
  while (text.length < length) text += yield* Queue.take(queue);
  return text;
});

const exitedEvent = (table: HandleTable.HandleTable["Service"], handle: RunnerHandleId) =>
  table.events.pipe(
    Stream.filter((event) => event._tag === "handle.exited" && event.handle === handle),
    Stream.runHead,
    Effect.forkChild({ startImmediately: true }),
  );

/** A server on the runner's loopback, as Chrome's CDP port or a dev server would be. */
const listen = (onConnection: (socket: NodeNet.Socket) => void) =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
        socket.on("error", () => undefined);
        onConnection(socket);
      });
      server.listen({ host: "127.0.0.1", port: 0 }, () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.sync(() => server.close()),
  ).pipe(Effect.map((server) => (server.address() as NodeNet.AddressInfo).port));

/** Writes as fast as the connection drains, like `yes` on a pipe. */
const flood = (socket: NodeNet.Socket) => {
  const chunk = new Uint8Array(64 * KiB).fill(0x79);
  const fill = () => {
    while (!socket.destroyed && socket.write(chunk));
  };
  socket.on("drain", fill);
  fill();
};

const NUMBERED_LINES = 16 * KiB;
const numbered = Array.from(
  { length: NUMBERED_LINES },
  (_, index) => `${String(index).padStart(63, "0")}\n`,
).join("");

it.effect(
  "resumes output across a drop mid-stream with every byte once, and refuses a resume behind the tail",
  () =>
    run()(
      Effect.gen(function* () {
        const { runner, first, connection, bearer } = yield* boot({ dropAfterBytes: 256 * KiB });
        // 1 MiB of numbered 64-byte lines, so a lost or repeated byte shows.
        const { handle } = yield* spawn(
          connection,
          shell(
            `i=0; while [ $i -lt ${NUMBERED_LINES} ]; do printf '%063d\\n' $i; i=$((i+1)); done`,
            { stdin: "ignore" },
          ),
        );
        const reading = yield* readText(connection, handle).pipe(Effect.forkChild);
        yield* first.closed;
        yield* runner.connect(bearer);
        const text = yield* Fiber.join(reading);
        assert.equal(text.length, numbered.length);
        assert.isTrue(text === numbered, "output differs from what the child wrote");

        const client = yield* connection.client;
        assert.deepEqual(yield* client["process.wait"]({ handle }), { exitCode: 0, signal: null });
        // Everything was taken, so the start is far behind the retained tail.
        const behind = yield* client["process.output"]({ handle, fd: 1, fromSeq: 0 }).pipe(
          Stream.runDrain,
          Effect.flip,
        );
        assert.deepInclude(behind, { _tag: "RunnerLostError", reason: "resume-behind-buffer" });
      }),
    ),
);

it.effect("resends a write whose reply a drop lost, and the runner applies it once", () =>
  run()(
    Effect.gen(function* () {
      const { runner, first, connection, bearer } = yield* boot();
      const { handle } = yield* spawn(connection, shell("exec cat"));
      // The runner's own view of the output, which a stalled socket cannot carry.
      const local = yield* Queue.unbounded<string>();
      yield* runner.table.output(handle, "fd:1", 0).pipe(
        Stream.runForEach((chunk) => Queue.offer(local, decoder.decode(chunk.data))),
        Effect.forkChild,
      );
      const writer = yield* connection.pipeWriter(handle, 0);
      yield* writer.write(encoder.encode("ab"));
      assert.equal(yield* takeText(local, 2), "ab");

      yield* first.stallReader;
      yield* writer.write(encoder.encode("cd"));
      // Applied: cat echoed it. The reply waits behind the stall and dies with the socket.
      assert.equal(yield* takeText(local, 2), "cd");
      yield* runner.connect(bearer);
      yield* writer.write(encoder.encode("ef"));
      yield* writer.close;
      assert.equal(yield* readText(connection, handle), "abcdef");
    }),
  ),
);

it.effect("a drop during hello neither attaches nor loses the boot", () =>
  run()(
    Effect.gen(function* () {
      const hub = yield* RunnerHub.RunnerHub;
      const facts = yield* Queue.unbounded<RunnerHub.RunnerHubFact>();
      yield* Stream.runForEach(hub.facts, (fact) => Queue.offer(facts, fact)).pipe(
        Effect.forkScoped,
      );
      const runner = yield* RunnerHubTesting.makeRunner(yield* hub.mintEnrollment(sandbox, 1));
      const lostHello = yield* runner.connect(undefined, { dropAfterBytes: 0 });
      yield* Fiber.join(lostHello.served);
      assert.equal((yield* awaitStatus("absent"))._tag, "absent");

      // The hello reached the runner, so it dials again with the token it carried.
      const first = yield* runner.connect();
      const attached = yield* Queue.take(facts);
      assert.deepInclude(attached, { _tag: "attached", generation: 1 });

      const second = yield* runner.connect(undefined, { dropAfterBytes: 0 });
      yield* first.closed;
      yield* Fiber.join(second.served);
      yield* awaitStatus("reconnecting");
      const third = yield* runner.connect();
      const connected = yield* awaitStatus("connected");
      assert.deepInclude(connected, { runnerBootId: attached.runnerBootId });

      // Nothing was reported in between: the next fact is this boot's lease expiring.
      yield* third.drop;
      yield* awaitStatus("reconnecting");
      yield* TestClock.adjust("120 seconds");
      assert.deepInclude(yield* Queue.take(facts), {
        _tag: "lost",
        runnerBootId: attached.runnerBootId,
        reason: "lease-expired",
      });
    }),
  ),
);

it.effect.each([
  {
    source: "a process",
    open: (connection: RunnerConnection) =>
      spawn(connection, shell("exec yes", { stdin: "ignore" })).pipe(
        Effect.map(({ handle }) => connection.output(handle, "fd:1")),
      ),
  },
  {
    source: "a dialed connection",
    open: (connection: RunnerConnection) =>
      listen(flood).pipe(
        Effect.flatMap((port) => connection.connectTcp(port)),
        Effect.map((tcp) => tcp.read),
      ),
  },
])("a stalled reader pauses $source at its buffer limit and resumes it", ({ open }) =>
  // Both outrun any ingress budget on a clock that never moves.
  run(
    limitsWith({ handleBufferBytes: 64 * KiB }),
    Number.POSITIVE_INFINITY,
  )(
    Effect.gen(function* () {
      const { runner, first, connection } = yield* boot();
      const output = yield* open(connection);
      yield* first.stallReader;
      yield* output.pipe(Stream.runDrain, Effect.forkChild);

      yield* awaitPressure(runner.table, (pressure) => pressure.pausedHandles === 1);
      const stats = yield* runner.table.stats;
      assert.equal(stats.pausedHandles, 1);
      assert.isAtLeast(stats.bufferedBytes, 64 * KiB);
      assert.isAtLeast(stats.highWaterBytes, stats.bufferedBytes);

      yield* TestClock.adjust("3 seconds");
      yield* first.resumeReader;
      const resumed = yield* awaitPressure(
        runner.table,
        (pressure) => pressure.pausedHandles === 0,
      );
      assert.isAtLeast(resumed.pausedMsTotal, 3000);
      assert.isAtLeast(resumed.highWaterBytes, 64 * KiB);
    }),
  ),
);

it.effect("the sandbox cap pauses every source at once", () =>
  run(limitsWith({ handleBufferBytes: 4 * MiB, sandboxBufferBytes: 64 * KiB }))(
    Effect.gen(function* () {
      const { runner, connection } = yield* boot();
      // Nobody reads either: both fill until the sandbox-wide cap stops them together.
      yield* spawn(connection, shell("exec yes", { stdin: "ignore" }));
      yield* spawn(connection, shell("exec yes", { stdin: "ignore" }));
      yield* awaitPressure(runner.table, (pressure) => pressure.pausedHandles === 2);
      assert.isAtLeast((yield* runner.table.stats).bufferedBytes, 64 * KiB);
    }),
  ),
);

it.effect("a sandbox past its ingress budget waits, and another sandbox's output still flows", () =>
  // 64 KiB/s holds a 4 KiB burst.
  run(
    limitsWith({ handleBufferBytes: 64 * KiB }),
    64 * KiB,
  )(
    Effect.gen(function* () {
      const hub = yield* RunnerHub.RunnerHub;
      const attach = Effect.fnUntraced(function* (sandboxId: SandboxId) {
        const runner = yield* RunnerHubTesting.makeRunner(yield* hub.mintEnrollment(sandboxId, 1));
        yield* runner.connect();
        return { runner, connection: yield* hub.connection(sandboxId) };
      });
      const a = yield* attach(sandbox);
      const b = yield* attach(SandboxId.make("sbx_000000000000000000e9"));

      // Endless, so A's source fills past the chunks the hub's client queues before it acks.
      const { handle: hog } = yield* spawn(a.connection, shell("exec yes", { stdin: "ignore" }));
      const arrived = yield* Queue.unbounded<number>();
      let delivered = 0;
      yield* a.connection.output(hog, "fd:1").pipe(
        Stream.runForEach((chunk) => {
          delivered += chunk.length;
          return Queue.offer(arrived, chunk.length);
        }),
        Effect.forkChild,
      );
      const { handle: quiet } = yield* spawn(
        b.connection,
        shell(`head -c ${KiB} /dev/zero`, { stdin: "ignore" }),
      );
      assert.equal((yield* readText(b.connection, quiet)).length, KiB);
      assert.isAtMost(delivered, 4 * KiB);

      // The hub stopped pulling, so the runner pauses A's source at its own buffer limit.
      yield* awaitPressure(a.runner.table, (pressure) => pressure.pausedHandles === 1);
      assert.isTrue(Option.isNone(yield* Queue.poll(arrived)));
      yield* TestClock.adjust("1 second");
      assert.isAbove(yield* Queue.take(arrived), 0);
      // What `t3_runner_source_paused_ms_total` counts from the runner's pressure reports.
      assert.isAtLeast((yield* a.runner.table.stats).pausedMsTotal, 1000);
    }),
  ),
);

it.effect("a half-open socket replaced by a new connect resumes output and writes", () =>
  run()(
    Effect.gen(function* () {
      const { runner, first, connection, bearer } = yield* boot();
      const { handle } = yield* spawn(connection, shell("exec cat"));
      const received = yield* Queue.unbounded<string>();
      const reading = yield* connection.output(handle, "fd:1").pipe(
        Stream.map((data) => decoder.decode(data)),
        Stream.tap((text) => Queue.offer(received, text)),
        Stream.mkString,
        Effect.forkChild,
      );
      const writer = yield* connection.pipeWriter(handle, 0);
      yield* writer.write(encoder.encode("one\n"));
      assert.equal(yield* takeText(received, 4), "one\n");

      yield* first.halfOpen;
      yield* writer.write(encoder.encode("two\n"));
      yield* runner.connect(bearer);
      assert.equal(yield* takeText(received, 4), "two\n");
      yield* writer.close;
      assert.equal(yield* Fiber.join(reading), "one\ntwo\n");
    }),
  ),
);

it.effect(
  "lease expiry fails the boot's handles, kills its groups, and its return attaches a new boot",
  () =>
    run()(
      Effect.gen(function* () {
        const { runner, first, facts, connection, bearer } = yield* boot();
        const { handle } = yield* spawn(connection, shell("exec cat"));
        const exited = yield* exitedEvent(runner.table, handle);
        const output = yield* connection
          .output(handle, "fd:1")
          .pipe(Stream.runDrain, Effect.flip, Effect.forkChild);

        yield* first.drop;
        yield* first.runnerEnded;
        yield* awaitStatus("reconnecting");
        yield* TestClock.adjust("120 seconds");
        assert.deepInclude(yield* Fiber.join(output), {
          _tag: "RunnerLostError",
          reason: "lease-expired",
        });
        assert.deepInclude(yield* awaitStatus("lost"), {
          runnerBootId: connection.info.runnerBootId,
        });
        assert.deepInclude(yield* Queue.take(facts), { _tag: "lost", reason: "lease-expired" });
        assert.isTrue(Option.isSome(yield* Fiber.join(exited)));
        assert.deepEqual(yield* runner.table.live, []);

        // The runner minted a new boot when it killed its groups, so the receipt cannot drop it.
        yield* runner.connect(bearer);
        const attached = yield* Queue.take(facts);
        assert.equal(attached._tag, "attached");
        assert.notEqual(attached.runnerBootId, connection.info.runnerBootId);
      }),
    ),
);

it.effect("a new serverBootId kills the old boot's handles before hello answers", () =>
  run()(
    Effect.gen(function* () {
      const { runner, first, connection, bearer } = yield* boot();
      const { handle } = yield* spawn(connection, shell("exec cat"));
      const exited = yield* exitedEvent(runner.table, handle);

      // A restarted server: a new hub over the same grants.
      const restarted = yield* Layer.build(
        Layer.fresh(RunnerHub.layerWith({ limits: limitsWith() })),
      );
      const hub = Context.get(restarted, RunnerHub.RunnerHub);
      yield* first.drop;
      yield* runner.connect(bearer).pipe(Effect.provideService(RunnerHub.RunnerHub, hub));
      const after = yield* hub.connection(sandbox);
      assert.deepEqual(after.info.handles, []);
      assert.notEqual(after.info.runnerBootId, connection.info.runnerBootId);
      assert.isTrue(Option.isSome(yield* Fiber.join(exited)));
      const client = yield* after.client;
      assert.deepInclude(yield* client["process.wait"]({ handle }).pipe(Effect.flip), {
        _tag: "RunnerLostError",
      });
    }),
  ),
);

it.effect(
  "a dialed connection resumes on a new socket and fails, never hangs, once its boot ends",
  () =>
    run()(
      Effect.gen(function* () {
        const { runner, first, connection, bearer } = yield* boot();
        const port = yield* listen((socket) => socket.pipe(socket));
        const tcp = yield* connection.connectTcp(port);
        const received = yield* Queue.unbounded<string>();
        const reading = yield* tcp.read.pipe(
          Stream.runForEach((data) => Queue.offer(received, decoder.decode(data))),
          Effect.flip,
          Effect.forkChild,
        );
        yield* tcp.write(encoder.encode("one\n"));
        assert.equal(yield* takeText(received, 4), "one\n");

        yield* first.halfOpen;
        yield* tcp.write(encoder.encode("two\n"));
        const second = yield* runner.connect(bearer);
        assert.equal(yield* takeText(received, 4), "two\n");

        // The machine's runner goes for good: the connection ends with its boot (6.13).
        yield* second.drop;
        yield* second.runnerEnded;
        yield* awaitStatus("reconnecting");
        yield* TestClock.adjust("120 seconds");
        assert.deepInclude(yield* Fiber.join(reading), {
          _tag: "RunnerLostError",
          reason: "lease-expired",
        });
        assert.deepInclude(yield* tcp.close.pipe(Effect.flip), { _tag: "RunnerLostError" });
        assert.deepInclude(yield* connection.connectTcp(port).pipe(Effect.flip), {
          _tag: "RunnerLostError",
        });
      }),
    ),
);

it.effect("a runner from before tcp.connect refuses it with a typed error and stays usable", () =>
  run()(
    Effect.gen(function* () {
      const hub = yield* RunnerHub.RunnerHub;
      const runner = yield* RunnerHubTesting.makeRunner(yield* hub.mintEnrollment(sandbox, 1), {
        without: ["tcp.connect"],
      });
      yield* runner.connect();
      const connection = yield* hub.connection(sandbox);
      assert.deepInclude(yield* connection.connectTcp(9).pipe(Effect.flip), {
        _tag: "RunnerUnsupportedError",
        method: "tcp.connect",
      });
      const { handle } = yield* spawn(connection, shell("echo ok", { stdin: "ignore" }));
      assert.equal(yield* readText(connection, handle), "ok\n");
    }),
  ),
);
