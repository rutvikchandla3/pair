import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { SandboxId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Headers from "effect/http/Headers";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as RunnerGrants from "./RunnerGrants.ts";
import * as RunnerHub from "./RunnerHub.ts";
import * as RunnerHubTesting from "./RunnerHubTesting.ts";

const layer = RunnerHub.layer.pipe(
  Layer.provideMerge(RunnerGrants.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(NodeCrypto.layer),
);

const sandboxA = SandboxId.make("sbx_0000000000000000000a");
const sandboxB = SandboxId.make("sbx_0000000000000000000b");

const setup = Effect.gen(function* () {
  const hub = yield* RunnerHub.RunnerHub;
  const facts = yield* Queue.unbounded<RunnerHub.RunnerHubFact>();
  yield* Stream.runForEach(hub.facts, (fact) => Queue.offer(facts, fact)).pipe(Effect.forkScoped);
  const nextFact = Queue.take(facts).pipe(
    Effect.map((fact) => ({
      _tag: fact._tag,
      sandboxId: fact.sandboxId,
      generation: fact.generation,
      runnerBootId: fact.runnerBootId,
      ...(fact._tag === "lost" ? { reason: fact.reason } : {}),
    })),
  );
  const awaitStatus = (sandboxId: SandboxId, tag: RunnerHub.RunnerConnectionStatus["_tag"]) =>
    hub.status(sandboxId).pipe(
      Stream.filter((status) => status._tag === tag),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  /** A runner of the sandbox's new boot generation, connected and attached. */
  const boot = Effect.fnUntraced(function* (sandboxId: SandboxId, generation: number) {
    const runner = yield* RunnerHubTesting.makeRunner(
      yield* hub.mintEnrollment(sandboxId, generation),
    );
    const connection = yield* runner.connect();
    const connected = yield* awaitStatus(sandboxId, "connected");
    assert(connected._tag === "connected");
    return { runner, connection, runnerBootId: connected.runnerBootId };
  });
  return { hub, nextFact, awaitStatus, boot };
});

const headers = (authorization: string | undefined, protocol = "1") =>
  Headers.fromInput({
    ...(authorization === undefined ? {} : { authorization }),
    "x-pair-runner-protocol": protocol,
  });

const isAuthError = Schema.is(RunnerGrants.RunnerAuthError);

const authRefusal = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (isAuthError(error) ? error.reason : "not an auth error")),
  );

const run = <A, E>(
  effect: Effect.Effect<A, E, RunnerHub.RunnerHub | RunnerGrants.RunnerGrants | Scope.Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(layer));

it.effect(
  "enrolls, hands the runner its token in hello, keeps a reconnect inside the lease silent, and loses it at expiry",
  () =>
    run(
      Effect.gen(function* () {
        const { hub, nextFact, awaitStatus } = yield* setup;
        const secret = yield* hub.mintEnrollment(sandboxA, 1);
        const waiting = yield* hub.connection(sandboxA).pipe(Effect.forkScoped);
        const runner = yield* RunnerHubTesting.makeRunner(secret);
        const first = yield* runner.connect();

        const attached = yield* nextFact;
        assert.deepInclude(attached, { _tag: "attached", sandboxId: sandboxA, generation: 1 });
        const connection = yield* Fiber.join(waiting);
        assert.equal(connection.info.runnerBootId, attached.runnerBootId);
        const client = yield* connection.client;
        assert.isTrue((yield* client["fs.stat"]({ path: "/" })).type === "Directory");
        // Coarse operations ride the same socket; a second read is the subscription's latest table.
        const table = yield* connection.ops.processTable;
        assert.isTrue(table.some((entry) => entry.pid === process.pid));
        assert.strictEqual(yield* connection.ops.processTable, table);

        // The token came in `runner.hello`; the reconnect uses it and attaches nothing new.
        const bearer = yield* runner.authorization;
        assert.match(Redacted.value(bearer), /^Bearer /);
        yield* first.drop;
        yield* awaitStatus(sandboxA, "reconnecting");
        yield* TestClock.adjust("119 seconds");
        const second = yield* runner.connect(bearer);
        yield* awaitStatus(sandboxA, "connected");
        yield* TestClock.adjust("119 seconds");

        yield* second.drop;
        yield* awaitStatus(sandboxA, "reconnecting");
        yield* TestClock.adjust("120 seconds");
        assert.deepStrictEqual(yield* nextFact, {
          _tag: "lost",
          sandboxId: sandboxA,
          generation: 1,
          runnerBootId: attached.runnerBootId,
          reason: "lease-expired",
        });
        assert.deepInclude(yield* awaitStatus(sandboxA, "lost"), {
          runnerBootId: attached.runnerBootId,
        });
        const lost = yield* Effect.flip(hub.connection(sandboxA));
        assert.deepInclude(lost, { _tag: "RunnerLostError", reason: "lease-expired" });
      }),
    ),
);

it.effect(
  "replaces a sandbox's live socket, and reports a new runner boot as lost then attached",
  () =>
    run(
      Effect.gen(function* () {
        const { nextFact, awaitStatus, boot } = yield* setup;
        const { runner, connection: first, runnerBootId } = yield* boot(sandboxA, 1);
        yield* nextFact;
        const bearer = yield* runner.authorization;

        // Half-open after a network change: the newer connect closes the older socket.
        const second = yield* runner.connect(bearer);
        yield* first.closed;
        yield* awaitStatus(sandboxA, "connected");

        // A restarted runner redials with the token from its state directory.
        const restarted = yield* RunnerHubTesting.makeRunner(Redacted.make("unused"));
        yield* restarted.connect(bearer);
        yield* second.closed;
        const lost = yield* nextFact;
        const attached = yield* nextFact;
        assert.deepStrictEqual(lost, {
          _tag: "lost",
          sandboxId: sandboxA,
          generation: 1,
          runnerBootId,
          reason: "runner-restarted",
        });
        assert.deepInclude(attached, { _tag: "attached", sandboxId: sandboxA, generation: 1 });
        assert.notEqual(attached.runnerBootId, runnerBootId);
      }),
    ),
);

it.effect("revoke closes the socket and refuses the token's next connect", () =>
  run(
    Effect.gen(function* () {
      const { hub, awaitStatus, boot } = yield* setup;
      const { runner, connection, runnerBootId } = yield* boot(sandboxA, 1);
      const bearer = yield* runner.authorization;
      yield* hub.revoke(sandboxA);
      yield* connection.closed;
      assert.deepInclude(yield* awaitStatus(sandboxA, "lost"), { runnerBootId });
      assert.equal(
        yield* authRefusal(hub.authenticate(headers(Redacted.value(bearer)))),
        "revoked",
      );
      assert.deepInclude(yield* Effect.flip(hub.connection(sandboxA)), {
        _tag: "RunnerLostError",
        reason: "drained",
      });
    }),
  ),
);

it.effect("a new boot generation closes the old boot's socket and refuses its credentials", () =>
  run(
    Effect.gen(function* () {
      const { hub, nextFact, awaitStatus, boot } = yield* setup;
      const secret = yield* hub.mintEnrollment(sandboxA, 1);
      const runner = yield* RunnerHubTesting.makeRunner(secret);
      const connection = yield* runner.connect();
      assert.deepInclude(yield* nextFact, { _tag: "attached", generation: 1 });
      const bearer = yield* runner.authorization;
      const enroll = `Enroll ${Redacted.value(secret)}`;
      assert.equal(yield* authRefusal(hub.authenticate(headers(enroll))), "consumed");

      const waiting = yield* hub.connection(sandboxA).pipe(Effect.forkScoped);
      const next = yield* boot(sandboxA, 2);
      yield* connection.closed;
      assert.equal(
        yield* authRefusal(hub.authenticate(headers(Redacted.value(bearer)))),
        "revoked",
      );
      // The old boot was superseded, not lost: only the new one attaches.
      assert.deepInclude(yield* nextFact, {
        _tag: "attached",
        generation: 2,
        runnerBootId: next.runnerBootId,
      });
      assert.equal((yield* Fiber.join(waiting)).info.runnerBootId, next.runnerBootId);
      yield* awaitStatus(sandboxA, "connected");
    }),
  ),
);

it.effect("a token reaches only its own sandbox's channel", () =>
  run(
    Effect.gen(function* () {
      const { hub, nextFact, awaitStatus, boot } = yield* setup;
      const a = yield* boot(sandboxA, 1);
      assert.deepInclude(yield* nextFact, { _tag: "attached", sandboxId: sandboxA });
      assert.equal((yield* awaitStatus(sandboxB, "absent"))._tag, "absent");
      const b = yield* boot(sandboxB, 1);
      assert.deepInclude(yield* nextFact, { _tag: "attached", sandboxId: sandboxB });

      const bearerA = Redacted.value(yield* a.runner.authorization);
      assert.deepInclude(yield* hub.authenticate(headers(bearerA)), {
        sandboxId: sandboxA,
        generation: 1,
      });
      yield* a.connection.drop;
      yield* awaitStatus(sandboxA, "reconnecting");
      yield* TestClock.adjust("120 seconds");
      assert.deepInclude(yield* nextFact, { _tag: "lost", sandboxId: sandboxA });
      assert.equal((yield* awaitStatus(sandboxB, "connected"))._tag, "connected");
      assert.equal((yield* hub.connection(sandboxB)).info.runnerBootId, b.runnerBootId);
    }),
  ),
);

it.effect(
  "refuses bad credentials, and answers a protocol mismatch without spending the secret",
  () =>
    run(
      Effect.gen(function* () {
        const { hub } = yield* setup;
        const secret = yield* hub.mintEnrollment(sandboxA, 1);
        const enroll = `Enroll ${Redacted.value(secret)}`;
        assert.deepInclude(yield* Effect.flip(hub.authenticate(headers(enroll, "2"))), {
          _tag: "RunnerProtocolMismatchError",
          expected: 1,
          received: "2",
        });
        assert.equal(yield* authRefusal(hub.authenticate(headers(undefined))), "missing");
        assert.equal(yield* authRefusal(hub.authenticate(headers("Basic abc"))), "malformed");
        assert.equal(yield* authRefusal(hub.authenticate(headers("Bearer abc def"))), "malformed");
        assert.equal(yield* authRefusal(hub.authenticate(headers("Bearer unknown"))), "unknown");
        const runner = yield* hub.authenticate(headers(enroll));
        assert.deepInclude(runner, { sandboxId: sandboxA, generation: 1 });
        assert.isTrue(Option.isSome(runner.sandboxToken));
      }),
    ),
);

it.effect("fails a wait for a runner that never says hello after the lease", () =>
  run(
    Effect.gen(function* () {
      const { hub } = yield* setup;
      const waiting = yield* hub.connection(sandboxA).pipe(Effect.flip, Effect.forkScoped);
      yield* TestClock.adjust("120 seconds");
      assert.deepInclude(yield* Fiber.join(waiting), {
        _tag: "RunnerUnavailableError",
        sandboxId: sandboxA,
      });
    }),
  ),
);
