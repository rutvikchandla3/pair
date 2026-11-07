import { RunnerRpcGroup } from "@t3tools/contracts/runner";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Stream from "effect/Stream";
import * as RpcSchema from "effect/rpc/RpcSchema";

import * as Metrics from "../../observability/Metrics.ts";
import type { RunnerClient } from "./RunnerConnection.ts";

type Channel = "process" | "pty" | "fs" | "forward" | "ops";
type Direction = "in" | "out";

const STREAM_METHODS: ReadonlySet<string> = new Set(
  Array.from(RunnerRpcGroup.requests.values())
    .filter((rpc) => RpcSchema.isStreamSchema(rpc.successSchema))
    .map((rpc) => rpc._tag),
);

type Call = (payload: unknown, options: unknown) => Effect.Effect<unknown> | Stream.Stream<unknown>;

const channelOf = (method: string): Channel => {
  const family = method.slice(0, method.indexOf("."));
  switch (family) {
    case "process":
    case "pty":
    case "fs":
      return family;
    case "forward":
    case "tcp":
      return "forward";
    default:
      return "ops";
  }
};

// One counter per series, so a chunk costs one update and no attribute allocation.
const byteCounters = new Map<string, Metric.Metric<number, unknown>>();
const byteCounter = (channel: Channel, direction: Direction) => {
  const key = `${channel}:${direction}`;
  let counter = byteCounters.get(key);
  if (counter === undefined) {
    counter = Metric.withAttributes(Metrics.runnerBytesTotal, [
      ["channel", channel],
      ["direction", direction],
    ]);
    byteCounters.set(key, counter);
  }
  return counter;
};

/** Bytes and strings in a payload, nested ones included; a string counts its UTF-16 units. */
const payloadBytes = (value: unknown): number => {
  if (value instanceof Uint8Array) return value.byteLength;
  if (typeof value === "string") return value.length;
  if (typeof value !== "object" || value === null) return 0;
  let total = 0;
  for (const field of Object.values(value)) total += payloadBytes(field);
  return total;
};

const count = (channel: Channel, direction: Direction, value: unknown) => {
  const bytes = payloadBytes(value);
  return bytes === 0 ? Effect.void : Metric.update(byteCounter(channel, direction), bytes);
};

/**
 * The socket's client with every call measured: payload bytes by channel and direction, and the
 * round trip of each one-shot call by method. Streams count per chunk and are not timed, since
 * their request ends with the stream.
 */
export const instrumentClient = (client: RunnerClient): RunnerClient =>
  Object.fromEntries(
    Object.entries(client).map(([method, call]) => {
      const channel = channelOf(method);
      const timed = !STREAM_METHODS.has(method);
      const wrapped = (payload: unknown, options: unknown) => {
        const result = (call as Call)(payload, options);
        if (Stream.isStream(result)) {
          return Stream.unwrap(
            count(channel, "out", payload).pipe(
              Effect.as(Stream.tap(result, (chunk) => count(channel, "in", chunk))),
            ),
          );
        }
        const call$ = result.pipe(Effect.tap((value) => count(channel, "in", value)));
        return count(channel, "out", payload).pipe(
          Effect.andThen(
            timed
              ? Metrics.withMetrics(call$, {
                  timer: Metrics.runnerCallDuration,
                  attributes: { method },
                })
              : call$,
          ),
        );
      };
      return [method, wrapped];
    }),
  ) as unknown as RunnerClient;
