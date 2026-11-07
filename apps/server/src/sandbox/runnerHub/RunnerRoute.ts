import { RUNNER_PROTOCOL_VERSION } from "@t3tools/contracts/runner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { RunnerBundle } from "./RunnerBundle.ts";
import { RunnerHub } from "./RunnerHub.ts";

const BUILD_HEADER = "x-pair-runner-build";
const BUNDLE_FILE = /^([0-9a-f]{64})\.(tar\.gz|sha256)$/;

/**
 * The runner's only door (03 §3.1). It shares nothing with `/ws` but the HTTP server: no
 * `SessionStore`, no `RpcAuthorization`, and the server is the RPC client here.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const hub = yield* RunnerHub;
    const bundle = yield* RunnerBundle;
    // Without a bundle (a single executable) the server has no build to compare or serve.
    const currentBuild = bundle.current.pipe(
      Effect.map((info) => info.runnerBuildId),
      Effect.tapError((error) => Effect.logWarning("runner bundle unavailable", { cause: error })),
      Effect.option,
    );
    const otherBuild = (runnerBuildId: Option.Option<string>) =>
      HttpServerResponse.jsonUnsafe(
        {
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          runnerBuildId: Option.getOrUndefined(runnerBuildId),
        },
        {
          status: 426,
          headers: Option.match(runnerBuildId, {
            onNone: () => ({}),
            onSome: (id) => ({ [BUILD_HEADER]: id }),
          }),
        },
      );
    const persistenceFailure = (error: unknown) =>
      Effect.logError("runner route failed", { cause: error }).pipe(
        Effect.as(HttpServerResponse.empty({ status: 500 })),
      );

    const connect = HttpRouter.add(
      "GET",
      "/runner/v1/connect",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // Checked before the credential: a plain GET must not spend an enrollment secret.
        if (request.headers.upgrade?.toLowerCase() !== "websocket") {
          return HttpServerResponse.empty({ status: 400 });
        }
        // Also before the credential: the bootstrap fetches the named build and enrolls with it.
        const build = yield* currentBuild;
        if (Option.isSome(build) && request.headers[BUILD_HEADER] !== build.value) {
          return otherBuild(build);
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
            }).pipe(Effect.andThen(currentBuild), Effect.map(otherBuild)),
          PersistenceSqlError: persistenceFailure,
          PersistenceDecodeError: persistenceFailure,
        }),
      ),
    );

    // The bootstrap's download: this server's own build only, behind a runner credential.
    const download = HttpRouter.add(
      "GET",
      "/runner/v1/bundle/:file",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* hub.authorizeDownload(request.headers);
        const { file } = yield* HttpRouter.params;
        const info = yield* bundle.current.pipe(Effect.option);
        if (Option.isNone(info)) return HttpServerResponse.empty({ status: 503 });
        const { runnerBuildId, tarballPath, tarballSha256 } = info.value;
        const match = BUNDLE_FILE.exec(file ?? "");
        if (match === null || match[1] !== runnerBuildId) {
          return HttpServerResponse.empty({
            status: 404,
            headers: { [BUILD_HEADER]: runnerBuildId },
          });
        }
        if (match[2] === "sha256") {
          return HttpServerResponse.text(`${tarballSha256}  ${runnerBuildId}.tar.gz\n`);
        }
        return yield* HttpServerResponse.file(tarballPath, {
          contentType: "application/gzip",
        }).pipe(Effect.orDie);
      }).pipe(
        Effect.catchTags({
          RunnerAuthError: (error) =>
            Effect.logInfo("runner bundle download refused", { reason: error.reason }).pipe(
              Effect.as(HttpServerResponse.empty({ status: 401 })),
            ),
          PersistenceSqlError: persistenceFailure,
          PersistenceDecodeError: persistenceFailure,
        }),
      ),
    );

    return Layer.mergeAll(connect, download);
  }),
);
