import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Stream from "effect/Stream";

import * as Metrics from "../../observability/Metrics.ts";
import type { RunnerClient } from "./RunnerConnection.ts";
import { instrumentClient } from "./RunnerWireMetrics.ts";

const bytes = (channel: string, direction: string) =>
  Metric.value(
    Metric.withAttributes(Metrics.runnerBytesTotal, [
      ["channel", channel],
      ["direction", direction],
    ]),
  ).pipe(Effect.map((state) => state.count));

const calls = (method: string) =>
  Metric.value(Metric.withAttributes(Metrics.runnerCallDuration, [["method", method]])).pipe(
    Effect.map((state) => state.count),
  );

it.effect("counts payload bytes by channel and direction, and times one-shot calls only", () =>
  Effect.gen(function* () {
    // Only the shape the wrapper reads: methods returning an Effect or a Stream.
    const client = instrumentClient({
      "process.write": () => Effect.succeed({ appliedThrough: 1 }),
      "process.output": () =>
        Stream.make({ seq: 0, data: new Uint8Array(100) }, { seq: 100, data: new Uint8Array(28) }),
      "fs.readFile": () => Effect.succeed({ data: new Uint8Array(1000), eof: true }),
      "tcp.read": () => Stream.make({ data: new Uint8Array(7) }),
      "ops.search.entries": () =>
        Stream.make({ entries: [{ path: "a/b" }, { path: "c" }], truncated: false }),
    } as unknown as RunnerClient);
    const before = {
      processIn: yield* bytes("process", "in"),
      processOut: yield* bytes("process", "out"),
      fsIn: yield* bytes("fs", "in"),
      forwardIn: yield* bytes("forward", "in"),
      opsIn: yield* bytes("ops", "in"),
      writes: yield* calls("process.write"),
      reads: yield* calls("process.output"),
    };

    yield* client["process.write"]({
      handle: "h",
      fd: 0,
      seq: 1,
      data: new Uint8Array(64),
    } as never);
    yield* Stream.runDrain(client["process.output"]({ handle: "h", fd: 1, fromSeq: 0 } as never));
    yield* client["fs.readFile"]({ path: "/x", offset: 0, maxBytes: 5000 } as never);
    yield* Stream.runDrain(client["tcp.read"]({} as never));
    yield* Stream.runDrain(client["ops.search.entries"]({} as never));

    // Strings count too: the write's 64 bytes, and the one-character handle of both requests.
    assert.equal((yield* bytes("process", "out")) - before.processOut, 66);
    assert.equal((yield* bytes("process", "in")) - before.processIn, 128);
    assert.equal((yield* bytes("fs", "in")) - before.fsIn, 1000);
    assert.equal((yield* bytes("forward", "in")) - before.forwardIn, 7);
    assert.equal((yield* bytes("ops", "in")) - before.opsIn, 4);
    assert.equal((yield* calls("process.write")) - before.writes, 1);
    assert.equal((yield* calls("process.output")) - before.reads, 0);
  }),
);
