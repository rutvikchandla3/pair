import { RUNNER_PROTOCOL_VERSION } from "@t3tools/contracts/runner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { RunnerHub } from "./RunnerHub.ts";

/**
 * The runner's only door (03 §3.1). It shares nothing with `/ws` but the HTTP server: no
 * `SessionStore`, no `RpcAuthorization`, and the server is the RPC client here.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const hub = yield* RunnerHub;
    return HttpRouter.add(
      "GET",
      "/runner/v1/connect",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // Checked before the credential: a plain GET must not spend an enrollment secret.
        if (request.headers.upgrade?.toLowerCase() !== "websocket") {
          return HttpServerResponse.empty({ status: 400 });
        }
        const runner = yield* hub.authenticate(request.headers);
        const socket = yield* Effect.orDie(request.upgrade);
        yield* hub.serve(runner, socket);
        return HttpServerResponse.empty();
      }).pipe(
        Effect.catchTags({
          RunnerAuthError: (error) =>
            Effect.logInfo("runner connect refused", { reason: error.reason }).pipe(
              Effect.as(HttpServerResponse.empty({ status: 401 })),
            ),
          RunnerProtocolMismatchError: (error) =>
            Effect.logInfo("runner connect with another protocol", {
              received: error.received.slice(0, 32),
            }).pipe(
              Effect.as(
                HttpServerResponse.jsonUnsafe(
                  { protocolVersion: RUNNER_PROTOCOL_VERSION },
                  { status: 426 },
                ),
              ),
            ),
          PersistenceSqlError: (error) =>
            Effect.logError("runner connect failed", { cause: error }).pipe(
              Effect.as(HttpServerResponse.empty({ status: 500 })),
            ),
          PersistenceDecodeError: (error) =>
            Effect.logError("runner connect failed", { cause: error }).pipe(
              Effect.as(HttpServerResponse.empty({ status: 500 })),
            ),
        }),
      ),
    );
  }),
);
