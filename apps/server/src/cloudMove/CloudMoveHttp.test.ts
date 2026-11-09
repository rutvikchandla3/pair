// @effect-diagnostics nodeBuiltinImport:off - raw requests, so a test can send any content-length.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  type AuthMcpClientAccess,
  CloudMoveFailure,
  MemberId,
  ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as CloudMoveHttp from "./CloudMoveHttp.ts";
import * as StagedCloudImports from "./StagedCloudImports.ts";

const KEY = `mv_${"a".repeat(32)}`;
const SEED_PATH = `/api/cloud-moves/staged/${KEY}/seed?projectId=project-1`;
const EXPORT_PATH = `/api/cloud-moves/staged/${KEY}/context-export?projectId=project-1`;
const linkMember = MemberId.make("member:approver");

/** Bearer tokens the mocked auth knows, by what kind of session they are. */
const sessions: Record<
  string,
  { readonly peerLink: boolean; readonly access: AuthMcpClientAccess }
> = {
  "api-token": { peerLink: false, access: "full-access" },
  "read-only-link": { peerLink: true, access: "read-only" },
  link: { peerLink: true, access: "approval-required" },
};

const layerAuth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
  authenticateMcpClient: (request) => {
    const header = request.headers.authorization;
    if (header === undefined)
      return Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError());
    const session = sessions[header.slice("Bearer ".length)];
    // A browser cookie or any other session type reads as an invalid credential here.
    if (session === undefined)
      return Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({}));
    return Effect.succeed({
      sessionId: AuthSessionId.make("session-1"),
      memberId: linkMember,
      label: "Laptop",
      ...session,
    });
  },
});

const layerConfig = (cloudOnly: boolean) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      return { ...(yield* ServerConfig.ServerConfig), cloudOnly };
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "cloud-move-http-test-" })),
    Layer.provide(NodeServices.layer),
  );

type Stage = StagedCloudImports.StagedCloudImports["Service"]["stage"];
type StageInput = Parameters<Stage>[0];

const serve = (options: { readonly cloudOnly: boolean; readonly stage: Stage }) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      HttpRouter.serve(CloudMoveHttp.layer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(layerAuth),
        Layer.provide(Layer.mock(StagedCloudImports.StagedCloudImports)({ stage: options.stage })),
        Layer.provide(layerConfig(options.cloudOnly)),
      ),
    );
    const address = Context.get(services, HttpServer.HttpServer).address;
    assert(address._tag !== "UnixPathAddress");
    return address.port;
  });

/** One PUT; a body is optional, so a test can declare a length it never sends. */
const put = (port: number, path: string, headers: Record<string, string>, body?: Uint8Array) =>
  Effect.callback<{ readonly status: number; readonly body: string }, Error>((resume) => {
    const request = NodeHttp.request(
      { host: "127.0.0.1", port, path, method: "PUT", headers },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () =>
          resume(Effect.succeed({ status: response.statusCode ?? 0, body: text })),
        );
      },
    );
    request.on("error", (error) => resume(Effect.fail(error)));
    request.end(body);
    return Effect.sync(() => request.destroy());
  });

const decodeFailure = Schema.decodeUnknownSync(Schema.fromJsonString(CloudMoveFailure));
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const routeCases = (route: "seed" | "context-export", maxBytes: number) => {
  const path = `/api/cloud-moves/staged/${KEY}/${route}?projectId=project-1`;
  return [
    { name: "401 with no bearer", path, headers: {}, status: 401 },
    { name: "401 to a browser credential", path, headers: bearer("cookie"), status: 401 },
    { name: "403 to an API token", path, headers: bearer("api-token"), status: 403 },
    { name: "403 to a read-only link", path, headers: bearer("read-only-link"), status: 403 },
    {
      name: "400 to a bad key",
      path: `/api/cloud-moves/staged/mv_../${route}?projectId=project-1`,
      headers: bearer("link"),
      status: 400,
    },
    {
      name: "400 without a project",
      path: `/api/cloud-moves/staged/${KEY}/${route}`,
      headers: bearer("link"),
      status: 400,
    },
    {
      name: "413 to a content-length over the cap",
      path,
      headers: { ...bearer("link"), "content-length": String(maxBytes + 1) },
      status: 413,
    },
    {
      name: "404 with an empty body off a cloud-only server",
      path,
      headers: bearer("link"),
      status: 404,
      cloudOnly: false,
    },
  ].map((testCase) => ({ ...testCase, name: `${route}: ${testCase.name}` }));
};

it.live.each([
  ...routeCases("seed", 512 * 1024 * 1024),
  ...routeCases("context-export", 2 * 1024 * 1024),
])("answers $name", ({ path, headers, status, cloudOnly = true }) =>
  Effect.gen(function* () {
    let staged = 0;
    const port = yield* serve({
      cloudOnly,
      stage: () => Effect.sync(() => void staged++),
    });

    const response = yield* put(port, path, headers);

    assert.equal(response.status, status);
    if (status === 404) assert.equal(response.body, "");
    else assert.equal(decodeFailure(response.body).reason !== null, true);
    assert.equal(staged, 0);
  }).pipe(Effect.scoped),
);

it.live("stages a linked member's upload and maps the staging refusals", () =>
  Effect.gen(function* () {
    const calls: Array<Omit<StageInput, "body"> & { readonly bytes: Array<number> }> = [];
    let refusal: StagedCloudImports.StagedCloudImportError["reason"] | null = null;
    const port = yield* serve({
      cloudOnly: true,
      stage: ({ body, ...input }) =>
        Stream.runCollect(Stream.orDie(body)).pipe(
          Effect.flatMap((chunks) => {
            calls.push({ ...input, bytes: chunks.flatMap((chunk) => [...chunk]) });
            return refusal === null
              ? Effect.void
              : Effect.fail(
                  new StagedCloudImports.StagedCloudImportError({
                    key: input.key,
                    reason: refusal,
                  }),
                );
          }),
        ),
    });
    const bytes = new Uint8Array([1, 2, 3, 250]);

    for (const path of [SEED_PATH, EXPORT_PATH]) {
      const accepted = yield* put(port, path, bearer("link"), bytes);
      assert.equal(accepted.status, 204);
    }
    assert.deepEqual(
      calls,
      (["seed", "context-export"] as const).map((kind) => ({
        key: KEY,
        kind,
        projectId: ProjectId.make("project-1"),
        memberId: linkMember,
        bytes: [...bytes],
      })) as never,
    );

    const answers = [];
    for (const [path, reason] of [
      [SEED_PATH, "missing-prerequisite"],
      [SEED_PATH, "invalid-seed"],
      [SEED_PATH, "claimed"],
      [EXPORT_PATH, "invalid-export"],
    ] as const) {
      refusal = reason;
      const response = yield* put(port, path, bearer("link"), bytes);
      answers.push({ status: response.status, reason: decodeFailure(response.body).reason });
    }
    assert.deepEqual(answers, [
      { status: 409, reason: "missing-prerequisite" },
      { status: 422, reason: "invalid-seed" },
      { status: 409, reason: "claimed" },
      { status: 422, reason: "invalid-export" },
    ]);
  }).pipe(Effect.scoped),
);
