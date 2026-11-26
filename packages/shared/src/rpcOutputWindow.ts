import * as Effect from "effect/Effect";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import type * as RpcServer from "effect/rpc/RpcServer";

export interface OutputWindowOptions {
  readonly isWindowed: (tag: string) => boolean;
  /** Windowed by `maxChunks` only; sizing a multi-MB chunk would serialize it twice. */
  readonly isCountOnly?: (tag: string) => boolean;
  readonly maxChunks: number;
  readonly maxBytes: number;
  readonly sizeOf: (chunk: RpcMessage.ResponseChunkEncoded) => number;
}

interface Window {
  readonly bytes: boolean;
  readonly sizes: number[];
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
  // RpcServer drops a disconnected client before its streams exit, so their Exit never
  // reaches send; departed clients are pruned when a window opens instead.
  const clients = new Map<number, Map<string, Window>>();
  const isFull = (sizes: number[]) =>
    sizes.length >= options.maxChunks ||
    sizes.reduce((total, size) => total + size, 0) >= options.maxBytes;
  let receive: Parameters<RpcServer.Protocol["Service"]["run"]>[0];
  const windowFor = (clientId: number, requestId: string) => clients.get(clientId)?.get(requestId);
  const openWindow = Effect.fnUntraced(function* (
    clientId: number,
    requestId: string,
    bytes: boolean,
  ) {
    const connected = yield* protocol.clientIds;
    for (const id of clients.keys()) if (!connected.has(id)) clients.delete(id);
    let windows = clients.get(clientId);
    if (!windows) clients.set(clientId, (windows = new Map()));
    if (!windows.has(requestId)) windows.set(requestId, { bytes, sizes: [] });
  });
  return {
    ...protocol,
    run: (write) => {
      receive = write;
      return protocol.run((clientId, message) =>
        Effect.suspend(() => {
          if (message._tag === "Request" && options.isWindowed(message.tag)) {
            const bytes = options.isCountOnly?.(message.tag) !== true;
            return openWindow(clientId, String(message.id), bytes).pipe(
              Effect.andThen(write(clientId, message)),
            );
          } else if (message._tag === "Ack") {
            const window = windowFor(clientId, String(message.requestId));
            if (window) {
              const wasFull = isFull(window.sizes);
              window.sizes.shift();
              if (!wasFull || isFull(window.sizes)) return Effect.void;
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
          clients.get(clientId)?.delete(String(response.requestId));
        } else if (response._tag === "Chunk") {
          const window = windowFor(clientId, String(response.requestId));
          if (window) {
            window.sizes.push(window.bytes ? options.sizeOf(response) : 0);
            if (!isFull(window.sizes)) {
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
