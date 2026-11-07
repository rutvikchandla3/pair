import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Rpc, RpcGroup, RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";

import { encodedChunkBytes, withOutputWindow } from "./rpcOutputWindow.ts";

const jsonBytes = (chunk: RpcMessage.ResponseChunkEncoded) =>
  new TextEncoder().encode(JSON.stringify(chunk)).byteLength;

const textWindow = {
  isWindowed: (tag: string) => tag === "windowed",
  maxChunks: 8,
  maxBytes: 64 * 1024,
  sizeOf: jsonBytes,
};
const binaryWindow = {
  isWindowed: (tag: string) => tag === "windowed",
  maxChunks: 16,
  maxBytes: 64 * 1024,
  sizeOf: encodedChunkBytes,
};

interface Row<A> {
  readonly name: string;
  readonly tag: string;
  readonly success: Schema.Codec<A, unknown>;
  readonly serialization: Layer.Layer<RpcSerialization.RpcSerialization>;
  readonly window: typeof textWindow;
  readonly value: (index: number) => A;
  readonly limit: number;
}

const text = (tag: string, size: number, limit: number): Row<string> => ({
  name: `${tag} with ${size}-byte strings holds ${limit} unacked chunks`,
  tag,
  success: Schema.String,
  serialization: RpcSerialization.layerJson,
  window: textWindow,
  value: (index) => String(index % 10).repeat(size),
  limit,
});

// Base64 JSON of 48 KiB is 64 KiB, so a JSON count would stop after one chunk.
const binary = (size: number, limit: number): Row<Uint8Array> => ({
  name: `SchemaBinary ${size}-byte chunks count their encoded length: ${limit} unacked`,
  tag: "windowed",
  success: Schema.Uint8Array,
  serialization: RpcSerialization.layerSchemaBinary(),
  window: binaryWindow,
  value: (index) => new Uint8Array(size).fill(index),
  limit,
});

const rows: ReadonlyArray<Row<string> | Row<Uint8Array>> = [
  text("windowed", 1, 8),
  text("windowed", 64 * 1024, 1),
  text("other", 1, 1),
  binary(64 * 1024, 1),
  binary(48 * 1024, 2),
  binary(1, 16),
];

describe("output window", () => {
  it.effect.each(rows)("$name", (row: Row<unknown>) =>
    Effect.gen(function* () {
      const group = RpcGroup.make(Rpc.make(row.tag, { success: row.success, stream: true }));
      const output = yield* Queue.unbounded<unknown>();
      const responses = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
      const receive = yield* Deferred.make<Parameters<RpcServer.Protocol["Service"]["run"]>[0]>();
      const protocol = yield* RpcServer.Protocol.make((write) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(receive, write);
          const serialization = yield* RpcSerialization.RpcSerialization;
          return {
            disconnects: yield* Queue.unbounded<number>(),
            send: (_clientId, response) => Queue.offer(responses, response),
            end: () => Effect.void,
            clientIds: Effect.succeed(new Set([0])),
            initialMessage: Effect.succeedNone,
            supportsAck: true,
            supportsTransferables: false,
            supportsSpanPropagation: false,
            supportsNotifications: true,
            codecFor: serialization.codecFor,
          };
        }),
      );
      yield* RpcServer.make(group).pipe(
        Effect.provide(group.toLayerHandler(row.tag, () => Stream.fromQueue(output))),
        Effect.provideService(RpcServer.Protocol, withOutputWindow(protocol, row.window)),
        Effect.forkScoped,
      );
      const write = yield* Deferred.await(receive);
      const { codecFor } = yield* RpcSerialization.RpcSerialization;
      const payload = yield* Schema.encodeUnknownEffect(codecFor(Schema.Void))(undefined);
      yield* write(0, { _tag: "Request", id: "1", tag: row.tag, payload, headers: [] });

      const expectChunk = (response: RpcMessage.FromServerEncoded) => {
        assert.equal(response._tag, "Chunk");
        // Pins Effect's SchemaBinary path: an upgrade that stops pre-encoding fails here.
        if (response._tag === "Chunk" && row.window === binaryWindow) {
          assert.instanceOf(response.values as unknown, Uint8Array);
        }
      };
      for (let index = 0; index < row.limit; index++) {
        yield* Queue.offer(output, row.value(index));
        yield* TestClock.adjust(0);
        assert.equal(yield* Queue.size(responses), 1);
        expectChunk(yield* Queue.take(responses));
      }
      yield* Queue.offer(output, row.value(row.limit));
      yield* TestClock.adjust(0);
      assert.equal(yield* Queue.size(responses), 0);
      yield* write(0, { _tag: "Ack", requestId: "1" });
      expectChunk(yield* Queue.take(responses));

      yield* Queue.offer(output, row.value(0));
      yield* TestClock.adjust(0);
      assert.equal(yield* Queue.size(responses), 0);
      yield* write(0, { _tag: "Interrupt", requestId: "1" });
      assert.equal((yield* Queue.take(responses))._tag, "Exit");
    }).pipe(Effect.provide(row.serialization), Effect.scoped),
  );
});
