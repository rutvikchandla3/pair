import { RUNNER_PROTOCOL_VERSION } from "@t3tools/contracts/runner";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { makeByteBudget } from "./ByteBudget.ts";
import { RunnerBundle } from "./RunnerBundle.ts";
import { RunnerHub } from "./RunnerHub.ts";

const BUILD_HEADER = "x-pair-runner-build";
const BUNDLE_FILE = /^([0-9a-f]{64})\.(tar\.gz|sha256)$/;
/** Every download through one layer shares this rate (03 §9). */
const DOWNLOAD_BYTES_PER_SECOND = 32 * 1024 * 1024;
/** Holds a whole release bundle (about 9 MB), so a lone fetch never waits. */
const DOWNLOAD_BURST_BYTES = 16 * 1024 * 1024;

/**
 * The runner's only door (03 §3.1). It shares nothing with `/ws` but the HTTP server: no
 * `SessionStore`, no `RpcAuthorization`, and the server is the RPC client here.
 * While `mounted` is false every route answers 404 before reading the request.
 * `downloadBytesPerSecond: Infinity` turns the download budget off.
 */
export const layerWhen = (
  mounted: Effect.Effect<boolean>,
  options: {
    readonly downloadBytesPerSecond?: number;
    readonly downloadBurstBytes?: number;
  } = {},
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const hub = yield* RunnerHub;
      const bundle = yield* RunnerBundle;
      const fs = yield* FileSystem.FileSystem;
      const downloads = makeByteBudget(
        options.downloadBytesPerSecond ?? DOWNLOAD_BYTES_PER_SECOND,
        options.downloadBurstBytes ?? DOWNLOAD_BURST_BYTES,
      );
      // Without a runner tree (not a Pair Cloud release) there is no build to compare or serve.
      const currentBuild = bundle.current.pipe(
        Effect.map((info) => info.runnerBuildId),
        Effect.tapError((error) =>
          Effect.logWarning("runner bundle unavailable", { cause: error }),
        ),
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
          if (!(yield* mounted)) return HttpServerResponse.empty({ status: 404 });
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
          if (!(yield* mounted)) return HttpServerResponse.empty({ status: 404 });
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
          const { size } = yield* fs.stat(tarballPath).pipe(Effect.orDie);
          return HttpServerResponse.stream(
            fs
              .stream(tarballPath, { bytesToRead: size })
              .pipe(Stream.tap((chunk) => downloads.take(chunk.length))),
            { contentType: "application/gzip", contentLength: Number(size) },
          );
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

/** The runner-only socket: always mounted. */
export const layer = layerWhen(Effect.succeed(true));
