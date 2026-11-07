import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { assert, it } from "@effect/vitest";
import { SandboxId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as RunnerGrants from "./RunnerGrants.ts";
import * as RunnerHub from "./RunnerHub.ts";
import * as RunnerRoute from "./RunnerRoute.ts";

const layerHub = RunnerHub.layer.pipe(
  Layer.provideMerge(RunnerGrants.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(NodeCrypto.layer),
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
    assert(address._tag !== "UnixPathAddress");
    const url = `ws://127.0.0.1:${address.port}/runner/v1/connect`;

    const secret = yield* hub.mintEnrollment(SandboxId.make("sbx_0000000000000000000a"), 1);
    const enroll = `Enroll ${Redacted.value(secret)}`;

    const plain = yield* client.execute(
      HttpClientRequest.get("/runner/v1/connect").pipe(
        HttpClientRequest.setHeaders({ authorization: enroll, "x-pair-runner-protocol": "1" }),
      ),
    );
    assert.equal(plain.status, 400);
    assert.deepStrictEqual(
      yield* upgrade(url, { authorization: enroll, "x-pair-runner-protocol": "2" }),
      { status: 426, body: JSON.stringify({ protocolVersion: 1 }) },
    );
    assert.deepStrictEqual(
      yield* upgrade(url, { authorization: "Bearer unknown", "x-pair-runner-protocol": "1" }),
      { status: 401, body: "" },
    );

    // The secret survived both refusals: the upgrade succeeds and the hub sends runner.hello.
    const upgraded = yield* upgrade(url, { authorization: enroll, "x-pair-runner-protocol": "1" });
    assert.equal(upgraded.status, 101);
    assert("firstFrame" in upgraded && upgraded.firstFrame.byteLength > 0);
    assert.deepStrictEqual(
      yield* upgrade(url, { authorization: enroll, "x-pair-runner-protocol": "1" }),
      { status: 401, body: "" },
    );
  }).pipe(Effect.scoped),
);
