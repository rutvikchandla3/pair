import { EnvironmentHttpApi, PairBuilderHostSessionError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentNotFound,
} from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import * as PairBuilderHost from "./PairBuilderHost.ts";

/** The Builder's readiness probe, unauthenticated; the router answers HEAD with it too. */
export const layerHealthRoute = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return config.pairBuilder === undefined
      ? Layer.empty
      : HttpRouter.add(
          "GET",
          "/health",
          HttpServerResponse.text("ok", { headers: { "cache-control": "no-store" } }),
        );
  }),
);

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "pairBuilder",
  Effect.fnUntraced(function* (handlers) {
    const config = yield* ServerConfig.ServerConfig;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const host = yield* PairBuilderHost.PairBuilderHost;

    return handlers.handle(
      "createSession",
      Effect.fn("environment.pairBuilder.createSession")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        if (config.pairBuilder === undefined) {
          return yield* failEnvironmentNotFound("pair_builder_host_disabled");
        }
        const request = yield* HttpServerRequest.HttpServerRequest;
        // The Builder calls without X-Pair-User; a proxied browser's person wins over `user`.
        const person = yield* serverAuth
          .authenticatePairBuilderIngress(request)
          .pipe(
            Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
              failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
            ),
          );
        const started = yield* host
          .startSession({
            prompt: args.payload.prompt,
            title: args.payload.title,
            mode: args.payload.mode,
            person: Option.getOrElse(person, () => args.payload.user),
          })
          .pipe(
            Effect.catchTags({
              PairBuilderSessionNotStartedError: (error) =>
                Effect.fail(new PairBuilderHostSessionError({ error: error.message })),
            }),
          );
        return started.promptAccepted
          ? { session_id: started.threadId, prompt_accepted: true }
          : { session_id: started.threadId, prompt_accepted: false, error: started.error };
      }),
    );
  }),
);
