// @effect-diagnostics nodeBuiltinImport:off -- the test plays the agent dialing a forward with node:net.
import * as NodeNet from "node:net";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";
import { RunnerRpcGroup, type RunnerEvent } from "@t3tools/contracts/runner";

import * as RunnerTesting from "./runnerTesting.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const makeClient = RpcTest.makeClient(RunnerRpcGroup);
type Client = Effect.Success<typeof makeClient>;

const withRunner = <A, E>(body: (client: Client) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.gen(function* () {
    return yield* body(yield* makeClient);
  }).pipe(Effect.scoped, Effect.provide(RunnerTesting.layer));

/** The agent's side: dials a forward's `127.0.0.1:<port>` or socket path. */
const dial = (address: string) =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Socket, string>((resume) => {
      const port = /^127\.0\.0\.1:(\d+)$/.exec(address)?.[1];
      const socket =
        port === undefined
          ? NodeNet.createConnection(address)
          : NodeNet.createConnection({ host: "127.0.0.1", port: Number(port) });
      socket.once("connect", () => resume(Effect.succeed(socket)));
      socket.once("error", (error: NodeJS.ErrnoException) =>
        resume(Effect.fail(error.code ?? "error")),
      );
    }),
    (socket) => Effect.sync(() => socket.destroy()),
  );

/** Everything the agent's socket receives until the other side ends it. */
const readToEnd = (socket: NodeNet.Socket) =>
  Effect.callback<string>((resume) => {
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    socket.once("end", () => resume(Effect.succeed(text)));
  });

const accepts = (client: Client) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<RunnerEvent>();
    yield* client["runner.events"]({}).pipe(
      Stream.runForEach((event) =>
        event._tag === "forward.accepted" ? Queue.offer(queue, event) : Effect.void,
      ),
      Effect.forkScoped,
    );
    return queue;
  });

describe("runner forwards", () => {
  it.live("splices an accepted connection to tcp.read and tcp.write, applying each seq once", () =>
    withRunner((client) =>
      Effect.gen(function* () {
        const accepted = yield* accepts(client);
        const forward = yield* client["forward.open"]({ name: "mcp", ownerKey: "session-1" });
        expect(forward.address).toMatch(/^127\.0\.0\.1:\d+$/);
        const agent = yield* dial(forward.address);
        const event = yield* Queue.take(accepted);
        expect(event).toMatchObject({ _tag: "forward.accepted", forwardId: forward.forwardId });
        if (event._tag !== "forward.accepted") return;
        const { connectionId } = event;

        agent.end("request");
        const fromAgent = yield* client["tcp.read"]({ connectionId, fromSeq: 0 }).pipe(
          Stream.runCollect,
        );
        expect(decoder.decode(Buffer.concat(fromAgent.map((chunk) => chunk.data)))).toBe("request");

        const received = yield* readToEnd(agent).pipe(Effect.forkScoped);
        const write = (seq: number, text: string) =>
          client["tcp.write"]({ connectionId, seq, data: encoder.encode(text) });
        expect(yield* write(1, "re")).toEqual({ appliedThrough: 1 });
        // A resend after a dropped socket repeats the seq; the agent sees it once.
        expect(yield* write(1, "re")).toEqual({ appliedThrough: 1 });
        expect(yield* write(2, "ply")).toEqual({ appliedThrough: 2 });
        yield* client["tcp.close"]({ connectionId });
        expect(yield* Fiber.join(received)).toBe("reply");
      }),
    ),
  );

  it.live("repeats an unclaimed accept to a new subscriber", () =>
    withRunner((client) =>
      Effect.gen(function* () {
        const forward = yield* client["forward.open"]({ name: "codex-token", ownerKey: "codex" });
        const first = yield* accepts(client);
        yield* dial(forward.address);
        const announced = yield* Queue.take(first);
        // The server's socket dropped before it touched the connection.
        const second = yield* accepts(client);
        expect(yield* Queue.take(second)).toEqual(announced);
      }),
    ),
  );

  it.live("stops listening when the forward closes", () =>
    withRunner((client) =>
      Effect.gen(function* () {
        const mcp = yield* client["forward.open"]({ name: "mcp", ownerKey: "session-1" });
        const codex = yield* client["forward.open"]({ name: "codex-token", ownerKey: "codex" });
        expect(codex.address).toMatch(/\/codex-token-[0-9a-f-]+\.sock$/);
        yield* client["forward.close"]({ forwardId: mcp.forwardId });
        yield* client["forward.close"]({ forwardId: codex.forwardId });
        expect(yield* Effect.flip(dial(mcp.address))).toBe("ECONNREFUSED");
        expect(yield* Effect.flip(dial(codex.address))).toBe("ENOENT");
      }),
    ),
  );

  it.live("keeps one git-credential listener at its fixed path", () =>
    withRunner((client) =>
      Effect.gen(function* () {
        const first = yield* client["forward.open"]({ name: "git-credential", ownerKey: "sbx" });
        const second = yield* client["forward.open"]({ name: "git-credential", ownerKey: "sbx" });
        expect(second.address).toBe(first.address);
        expect(first.address).toMatch(/\/git-credential\.sock$/);
        const accepted = yield* accepts(client);
        yield* dial(second.address);
        expect(yield* Queue.take(accepted)).toMatchObject({ forwardId: second.forwardId });
      }),
    ),
  );
});
