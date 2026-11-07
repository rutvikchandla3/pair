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

const layerFor = (limits: RunnerLimits) =>
  RunnerHub.layerWith({ limits }).pipe(
    Layer.provideMerge(RunnerGrants.layer),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
  );

type Services = Layer.Success<ReturnType<typeof layerFor>> | Scope.Scope;

const run =
  (limits: RunnerLimits = limitsWith()) =>
  <A, E>(effect: Effect.Effect<A, E, Services>) =>
    effect.pipe(Effect.scoped, Effect.provide(layerFor(limits)));

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

it.effect("a stalled reader pauses the source at its buffer limit and resumes it", () =>
  run(limitsWith({ handleBufferBytes: 64 * KiB }))(
    Effect.gen(function* () {
      const { runner, first, connection } = yield* boot();
      const { handle } = yield* spawn(connection, shell("exec yes", { stdin: "ignore" }));
      yield* first.stallReader;
      yield* connection.output(handle, "fd:1").pipe(Stream.runDrain, Effect.forkChild);

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
