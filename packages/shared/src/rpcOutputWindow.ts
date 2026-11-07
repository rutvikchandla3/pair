import * as Effect from "effect/Effect";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import type * as RpcServer from "effect/rpc/RpcServer";

export interface OutputWindowOptions {
  readonly isWindowed: (tag: string) => boolean;
  readonly maxChunks: number;
  readonly maxBytes: number;
  readonly sizeOf: (chunk: RpcMessage.ResponseChunkEncoded) => number;
}

/** Charged per chunk, so tiny chunks cannot bypass the byte budget. */
const ENVELOPE_BYTES = 64;
const utf8 = new TextEncoder();

/**
 * With SchemaBinary, `RpcServer` has already encoded a chunk's values to one `Uint8Array`
 * before the protocol sees it, so this is the frame's payload length.
 */
export const encodedChunkBytes = (chunk: RpcMessage.ResponseChunkEncoded): number => {
  const values: unknown = chunk.values;
  return values instanceof Uint8Array
    ? values.byteLength + ENVELOPE_BYTES
    : utf8.encode(JSON.stringify(chunk)).byteLength;
};

/**
 * Lets a windowed stream run ahead of the client's acks by up to `maxChunks` chunks or
 * `maxBytes` bytes: inside the window the protocol acks a chunk itself as soon as it is sent,
 * and a full window waits for the client's ack before `RpcServer` pulls the next chunk.
 */
export function withOutputWindow(
  protocol: RpcServer.Protocol["Service"],
  options: OutputWindowOptions,
): RpcServer.Protocol["Service"] {
  const windows = new Map<string, number[]>();
  const isFull = (sizes: number[]) =>
    sizes.length >= options.maxChunks ||
    sizes.reduce((total, size) => total + size, 0) >= options.maxBytes;
  let receive: Parameters<RpcServer.Protocol["Service"]["run"]>[0];
  return {
    ...protocol,
    run: (write) => {
      receive = write;
      return protocol.run((clientId, message) =>
        Effect.suspend(() => {
          if (message._tag === "Request" && options.isWindowed(message.tag)) {
            const key = `${clientId}:${message.id}`;
            if (!windows.has(key)) windows.set(key, []);
          } else if (message._tag === "Ack") {
            const window = windows.get(`${clientId}:${message.requestId}`);
            if (window) {
              const wasFull = isFull(window);
              window.shift();
              if (!wasFull || isFull(window)) return Effect.void;
            }
          }
          return write(clientId, message);
        }),
      );
    },
    send: (clientId, response, transferables) =>
      Effect.suspend(() => {
        const send = protocol.send(clientId, response, transferables);
        if (response._tag === "Exit") {
          windows.delete(`${clientId}:${response.requestId}`);
        } else if (response._tag === "Chunk") {
          const window = windows.get(`${clientId}:${response.requestId}`);
          if (window) {
            window.push(options.sizeOf(response));
            if (!isFull(window)) {
              return send.pipe(
                Effect.andThen(() =>
                  receive(clientId, { _tag: "Ack", requestId: response.requestId }),
                ),
              );
            }
          }
        }
        return send;
      }),
  };
}
