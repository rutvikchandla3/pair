import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { assert, it } from "@effect/vitest";
import { SandboxId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import { Headers, HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as RunnerBundle from "./RunnerBundle.ts";
import * as RunnerGrants from "./RunnerGrants.ts";
import * as RunnerHub from "./RunnerHub.ts";
import * as RunnerRoute from "./RunnerRoute.ts";
import * as WorkspaceHostTesting from "../../workspaceHost/WorkspaceHostTesting.ts";

const layerHub = Layer.mergeAll(
  RunnerHub.layer.pipe(
    Layer.provide(WorkspaceHostTesting.layerFromContext),
    Layer.provideMerge(RunnerGrants.layer),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(NodeCrypto.layer),
  ),
  RunnerBundle.layerTest([{ path: "runner.mjs", content: "runner" }]).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-runner-route-test-" })),
    Layer.provide(NodeServices.layer),
  ),
);

type Upgrade =
  | { readonly status: number; readonly body: string }
  | { readonly status: 101; readonly firstFrame: Uint8Array };

/** One WebSocket upgrade: the refusal, or the first frame the server sends once upgraded. */
const upgrade = (url: string, headers: Record<string, string>) =>
  Effect.callback<Upgrade>((resume) => {
    const ws = new NodeWS.WebSocket(url, { headers });
    ws.on("error", () => undefined);
    ws.on("unexpected-response", (_request, response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resume(Effect.succeed({ status: response.statusCode ?? 0, body })));
    });
    ws.on("message", (data: Buffer) => {
      resume(Effect.succeed({ status: 101, firstFrame: new Uint8Array(data) }));
      ws.close();
    });
    return Effect.sync(() => ws.terminate());
  });

// Live: a real HTTP server and real WebSocket upgrades, so the status codes are the wire's.
it.live("answers 400, 426 and 401 without spending a secret, then upgrades and says hello", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      HttpRouter.serve(RunnerRoute.layer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provideMerge(layerHub),
      ),
    );
    const hub = Context.get(services, RunnerHub.RunnerHub);
    const client = Context.get(services, HttpClient.HttpClient);
    const address = Context.get(services, HttpServer.HttpServer).address;
    const { runnerBuildId } = yield* Context.get(services, RunnerBundle.RunnerBundle).current;
    assert(address._tag !== "UnixPathAddress");
    const url = `ws://127.0.0.1:${address.port}/runner/v1/connect`;

    const secret = yield* hub.mintEnrollment(SandboxId.make("sbx_0000000000000000000a"), 1);
    const enroll = `Enroll ${Redacted.value(secret)}`;
    const current = { "x-pair-runner-protocol": "1", "x-pair-runner-build": runnerBuildId };
    const otherBuild = { status: 426, body: JSON.stringify({ protocolVersion: 1, runnerBuildId }) };

    const plain = yield* client.execute(
      HttpClientRequest.get("/runner/v1/connect").pipe(
        HttpClientRequest.setHeaders({ authorization: enroll, ...current }),
      ),
    );
    assert.equal(plain.status, 400);
    assert.deepStrictEqual(
      yield* upgrade(url, { authorization: enroll, ...current, "x-pair-runner-protocol": "2" }),
      otherBuild,
    );
    assert.deepStrictEqual(
      yield* upgrade(url, { authorization: enroll, "x-pair-runner-protocol": "1" }),
      otherBuild,
    );
    assert.deepStrictEqual(yield* upgrade(url, { authorization: "Bearer unknown", ...current }), {
      status: 401,
      body: "",
    });

    // The secret survived every refusal: the upgrade succeeds and the hub sends runner.hello.
    const upgraded = yield* upgrade(url, { authorization: enroll, ...current });
    assert.equal(upgraded.status, 101);
    assert("firstFrame" in upgraded && upgraded.firstFrame.byteLength > 0);
    assert.deepStrictEqual(yield* upgrade(url, { authorization: enroll, ...current }), {
      status: 401,
      body: "",
    });
  }).pipe(Effect.scoped),
);

it.live("answers 404 on the member listener until a driver dials over TCP", () =>
  Effect.gen(function* () {
    const dialsOverTcp = yield* Ref.make(false);
    const services = yield* Layer.build(
      HttpRouter.serve(RunnerRoute.layerWhen(Ref.get(dialsOverTcp)), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(layerHub)),
    );
    const hub = Context.get(services, RunnerHub.RunnerHub);
    const client = Context.get(services, HttpClient.HttpClient);
    const address = Context.get(services, HttpServer.HttpServer).address;
    const { runnerBuildId } = yield* Context.get(services, RunnerBundle.RunnerBundle).current;
    assert(address._tag !== "UnixPathAddress");
    const url = `ws://127.0.0.1:${address.port}/runner/v1/connect`;
    const secret = yield* hub.mintEnrollment(SandboxId.make("sbx_0000000000000000000a"), 1);
    const enroll = `Enroll ${Redacted.value(secret)}`;
    const current = { "x-pair-runner-protocol": "1", "x-pair-runner-build": runnerBuildId };
    const statuses = Effect.all([
      client.execute(HttpClientRequest.get("/runner/v1/connect")).pipe(Effect.map((r) => r.status)),
      upgrade(url, { authorization: "Bearer unknown", ...current }).pipe(
        Effect.map((r) => r.status),
      ),
      upgrade(url, { authorization: enroll }).pipe(Effect.map((r) => r.status)),
      client
        .execute(HttpClientRequest.get(`/runner/v1/bundle/${runnerBuildId}.tar.gz`))
        .pipe(Effect.map((r) => r.status)),
    ]);

    assert.deepStrictEqual(yield* statuses, [404, 404, 404, 404]);
    yield* Ref.set(dialsOverTcp, true);
    assert.deepStrictEqual(yield* statuses, [400, 401, 426, 401]);
    // The refusals while unmounted spent nothing.
    const upgraded = yield* upgrade(url, { authorization: enroll, ...current });
    assert.equal(upgraded.status, 101);
  }).pipe(Effect.scoped),
);

it.live("serves the current bundle and its digest to a runner credential only", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      HttpRouter.serve(RunnerRoute.layer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provideMerge(layerHub),
      ),
    );
    const hub = Context.get(services, RunnerHub.RunnerHub);
    const client = Context.get(services, HttpClient.HttpClient);
    const info = yield* Context.get(services, RunnerBundle.RunnerBundle).current;
    const fs = yield* FileSystem.FileSystem;
    const secret = yield* hub.mintEnrollment(SandboxId.make("sbx_0000000000000000000a"), 1);
    // pair-bootstrap.sh sends the enrollment secret as a bearer credential.
    const get = (file: string, authorization?: string) =>
      client.execute(
        HttpClientRequest.get(`/runner/v1/bundle/${file}`).pipe(
          HttpClientRequest.setHeaders(authorization === undefined ? {} : { authorization }),
        ),
      );
    const bearer = `Bearer ${Redacted.value(secret)}`;

    assert.equal((yield* get(`${info.runnerBuildId}.tar.gz`)).status, 401);
    assert.equal((yield* get(`${info.runnerBuildId}.tar.gz`, "Bearer unknown")).status, 401);
    const foreign = yield* get(`${"0".repeat(64)}.tar.gz`, bearer);
    assert.equal(foreign.status, 404);
    assert.equal(foreign.headers["x-pair-runner-build"], info.runnerBuildId);

    const digest = yield* get(`${info.runnerBuildId}.sha256`, bearer);
    assert.equal(yield* digest.text, `${info.tarballSha256}  ${info.runnerBuildId}.tar.gz\n`);
    const tarball = yield* get(`${info.runnerBuildId}.tar.gz`, `Enroll ${Redacted.value(secret)}`);
    assert.equal(tarball.status, 200);
    assert.deepStrictEqual(
      new Uint8Array(yield* tarball.arrayBuffer),
      yield* fs.readFile(info.tarballPath),
    );
    // Downloads never spend the secret.
    assert.deepStrictEqual(
      yield* hub.authorizeDownload(Headers.fromInput({ authorization: bearer })),
      {
        sandboxId: SandboxId.make("sbx_0000000000000000000a"),
        generation: 1,
      },
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
