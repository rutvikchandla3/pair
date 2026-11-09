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
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as CloudMoveHttp from "./CloudMoveHttp.ts";
import * as CloudMoveLaunch from "./CloudMoveLaunch.ts";
import * as CloudMoveSource from "./CloudMoveSource.ts";
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
type Source = CloudMoveSource.CloudMoveSource["Service"];

const serve = (options: {
  readonly cloudOnly: boolean;
  readonly stage?: Stage;
  readonly source?: Partial<Source>;
  readonly launch?: Partial<CloudMoveLaunch.CloudMoveLaunch["Service"]>;
}) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      HttpRouter.serve(CloudMoveHttp.layer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(layerAuth),
        Layer.provide(
          Layer.mock(StagedCloudImports.StagedCloudImports)(
            options.stage === undefined ? {} : { stage: options.stage },
          ),
        ),
        Layer.provide(Layer.mock(CloudMoveSource.CloudMoveSource)(options.source ?? {})),
        Layer.provide(Layer.mock(CloudMoveLaunch.CloudMoveLaunch)(options.launch ?? {})),
        Layer.provide(NodeServices.layer),
        Layer.provide(layerConfig(options.cloudOnly)),
      ),
    );
    const address = Context.get(services, HttpServer.HttpServer).address;
    assert(address._tag !== "UnixPathAddress");
    return address.port;
  });

/** One request; a body is optional, so a test can declare a length it never sends. */
const send = (
  method: "PUT" | "POST",
  port: number,
  path: string,
  headers: Record<string, string>,
  body?: Uint8Array | string,
) =>
  Effect.callback<{ readonly status: number; readonly body: string }, Error>((resume) => {
    const request = NodeHttp.request(
      { host: "127.0.0.1", port, path, method, headers },
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

const put = (port: number, path: string, headers: Record<string, string>, body?: Uint8Array) =>
  send("PUT", port, path, headers, body);

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

/** Any request, keeping the response's headers and raw bytes. */
const call = (
  port: number,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
  body?: string,
) =>
  Effect.callback<
    {
      readonly status: number;
      readonly headers: NodeHttp.IncomingHttpHeaders;
      readonly body: Buffer;
    },
    Error
  >((resume) => {
    const request = NodeHttp.request(
      { host: "127.0.0.1", port, path, method, headers },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resume(
            Effect.succeed({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          ),
        );
      },
    );
    request.on("error", (error) => resume(Effect.fail(error)));
    request.end(body);
    return Effect.sync(() => request.destroy());
  });

const THREAD = "thread-1";
const threadRoutes = [
  { method: "GET", route: "context-export" },
  { method: "GET", route: "seed" },
  { method: "POST", route: "continued" },
] as const;

it.live.each(
  threadRoutes.flatMap(({ method, route }) =>
    [
      { name: "401 with no bearer", headers: {}, status: 401 },
      { name: "401 to a browser credential", headers: bearer("cookie"), status: 401 },
      { name: "403 to an API token", headers: bearer("api-token"), status: 403 },
      { name: "403 to a read-only link", headers: bearer("read-only-link"), status: 403 },
      {
        name: "404 with an empty body off a cloud-only server",
        headers: bearer("link"),
        status: 404,
        cloudOnly: false,
      },
    ].map((testCase) => ({ ...testCase, method, route, name: `${route}: ${testCase.name}` })),
  ),
)("answers $name", ({ method, route, headers, status, cloudOnly = true }) =>
  Effect.gen(function* () {
    let reached = 0;
    const reach = () => Effect.sync(() => void reached++).pipe(Effect.andThen(Effect.never));
    const port = yield* serve({
      cloudOnly,
      source: { contextExport: reach, seed: reach, continued: reach },
    });

    const response = yield* call(
      port,
      method,
      `/api/cloud-moves/threads/${THREAD}/${route}`,
      headers,
    );

    assert.equal(response.status, status);
    if (status === 404) assert.equal(response.body.length, 0);
    else assert.equal(decodeFailure(response.body.toString()).reason !== null, true);
    assert.equal(reached, 0);
  }).pipe(Effect.scoped),
);

it.live("streams a seed's bundle with its facts and removes the file once sent", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cloud-move-http-seed-" });
    const bytes = new Uint8Array(70_000).map((_, index) => index % 251);
    const closed = yield* Deferred.make<void>();
    let file: string | null = null;
    const asked: Array<ReadonlyArray<string>> = [];
    const port = yield* serve({
      cloudOnly: true,
      source: {
        seed: ({ haves, memberId }) =>
          Effect.gen(function* () {
            assert.equal(memberId, linkMember);
            asked.push(haves);
            const written = asked.length === 1;
            if (written) {
              file = `${dir}/seed.bundle`;
              yield* fs.writeFile(file, bytes).pipe(Effect.orDie);
            }
            yield* Effect.addFinalizer(() =>
              (file === null
                ? Effect.void
                : fs.remove(file, { force: true }).pipe(Effect.ignore)
              ).pipe(Effect.andThen(Deferred.succeed(closed, undefined))),
            );
            return {
              file: written ? file : null,
              head: "a".repeat(40),
              snapshot: {
                oid: "b".repeat(40),
                takenAt: DateTime.makeUnsafe("2026-11-09T14:02:00Z"),
              },
              mode: "copy" as const,
              branch: "feature/ünïcode",
              baseRef: "main",
              origin: "github.com/acme/app",
            };
          }),
      },
    });
    const have = `${"c".repeat(40)}`;

    const streamed = yield* call(
      port,
      "GET",
      `/api/cloud-moves/threads/${THREAD}/seed?have=${have}&have=${"d".repeat(40)}`,
      bearer("link"),
    );
    yield* Deferred.await(closed);

    assert.equal(streamed.status, 200);
    assert.deepEqual([...streamed.body], [...bytes]);
    assert.deepEqual(asked, [[have, "d".repeat(40)]]);
    assert.deepEqual(
      {
        type: streamed.headers["content-type"],
        length: streamed.headers["content-length"],
        mode: streamed.headers["t3-move-mode"],
        branch: decodeURIComponent(String(streamed.headers["t3-move-branch"])),
        base: streamed.headers["t3-move-base"],
        head: streamed.headers["t3-move-head"],
        snapshot: streamed.headers["t3-move-snapshot"],
        snapshotAt: streamed.headers["t3-move-snapshot-at"],
      },
      {
        type: "application/x-git-bundle",
        length: String(bytes.length),
        mode: "copy",
        branch: "feature/ünïcode",
        base: "main",
        head: "a".repeat(40),
        snapshot: "b".repeat(40),
        snapshotAt: "2026-11-09T14:02:00.000Z",
      },
    );
    assert.isFalse(yield* fs.exists(file!));

    const empty = yield* call(
      port,
      "GET",
      `/api/cloud-moves/threads/${THREAD}/seed`,
      bearer("link"),
    );
    assert.equal(empty.status, 204);
    assert.equal(empty.headers["t3-move-head"], "a".repeat(40));
    assert.equal(empty.body.length, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("refuses bad input and maps a move's refusals", () =>
  Effect.gen(function* () {
    let refusal: CloudMoveSource.CloudMoveSourceError["reason"] = "run-active";
    const refuse = () =>
      Effect.fail(
        new CloudMoveSource.CloudMoveSourceError({
          threadId: ThreadId.make(THREAD),
          reason: refusal,
          message: `Refused: ${refusal}.`,
        }),
      );
    const port = yield* serve({
      cloudOnly: true,
      source: { contextExport: refuse, seed: refuse, continued: refuse },
    });
    const seedPath = `/api/cloud-moves/threads/${THREAD}/seed`;
    const tooManyHaves = Array.from(
      { length: 33 },
      (_, index) => `have=${index.toString(16).padStart(40, "0")}`,
    ).join("&");

    const answers = [];
    for (const [method, path, body] of [
      ["GET", `${seedPath}?${tooManyHaves}`, undefined],
      ["GET", `${seedPath}?have=abc123`, undefined],
      [
        "POST",
        `/api/cloud-moves/threads/${THREAD}/continued`,
        JSON.stringify({
          moveId: "move-1",
          thread: { environmentId: "env-laptop", threadId: "local-1" },
          environmentLabel: "Laptop",
          copy: false,
        }),
      ],
    ] as const) {
      const response = yield* call(port, method, path, bearer("link"), body);
      answers.push({
        status: response.status,
        reason: decodeFailure(response.body.toString()).reason,
      });
    }
    for (const reason of ["run-active", "too-large", "snapshot-failed", "not-found"] as const) {
      refusal = reason;
      const response = yield* call(port, "GET", seedPath, bearer("link"));
      answers.push({ status: response.status, ...decodeFailure(response.body.toString()) });
    }

    assert.deepEqual(answers, [
      { status: 400, reason: "bad-request" },
      { status: 400, reason: "bad-request" },
      { status: 400, reason: "bad-request" },
      { status: 409, reason: "run-active", message: "Refused: run-active." },
      { status: 413, reason: "too-large", message: "Refused: too-large." },
      { status: 503, reason: "snapshot-failed", message: "Refused: snapshot-failed." },
      { status: 404, reason: "not-found", message: "Refused: not-found." },
    ]);
  }).pipe(Effect.scoped),
);

const CHECK_PATH = "/api/cloud-moves/check";
const LAUNCH_PATH = `/api/cloud-moves/staged/${KEY}/launch`;
const checkBody = JSON.stringify({
  originKey: "github.com/acme/app",
  model: { driver: "codex", model: "gpt-5" },
});
const launchBody = JSON.stringify({
  projectId: "project-1",
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  title: "Fix the login form",
  baseRef: "main",
  branch: "feature",
  seeded: true,
  runtimeMode: "full-access",
  interactionMode: "default",
  message: "Continue from where the conversation left off.",
  createdBy: "user",
  creationSource: "web",
});

const launchRouteCases = (path: string, body: string, ok: string) =>
  [
    { name: "404 off a cloud-only server", headers: bearer("link"), status: 404, cloudOnly: false },
    { name: "401 with no bearer", headers: {}, status: 401 },
    { name: "403 to an API token", headers: bearer("api-token"), status: 403 },
    { name: "400 to a bad body", headers: bearer("link"), status: 400, body: "{}" },
    { name: "409 to a refusal", headers: bearer("link"), status: 409, refuse: true },
    { name: "200 with the result", headers: bearer("link"), status: 200, expected: ok },
  ].map((testCase) => ({ path, body, ...testCase, name: `${path}: ${testCase.name}` }));

it.live.each([
  ...launchRouteCases(
    CHECK_PATH,
    checkBody,
    JSON.stringify({
      projectId: "project-1",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
    }),
  ),
  ...launchRouteCases(LAUNCH_PATH, launchBody, JSON.stringify({ threadId: "thread-cloud" })),
])("answers $name", ({ path, body, headers, status, cloudOnly = true, refuse, expected }) =>
  Effect.gen(function* () {
    const sessions: Array<CloudMoveLaunch.CloudMoveSession | MemberId> = [];
    const refusal = new CloudMoveLaunch.CloudMoveLaunchError({
      reason: "refused",
      message: "Add an account on Pair Cloud, on your row in Settings → Team.",
    });
    const port = yield* serve({
      cloudOnly,
      launch: {
        check: ({ memberId, input }) =>
          Effect.suspend(() => {
            sessions.push(memberId);
            return refuse === true
              ? Effect.fail(refusal)
              : Effect.succeed({
                  projectId: input.projectId ?? ProjectId.make("project-1"),
                  modelSelection: { instanceId: "codex", model: "gpt-5" } as never,
                });
          }),
        launch: ({ session }) =>
          Effect.suspend(() => {
            sessions.push(session);
            return refuse === true
              ? Effect.fail(refusal)
              : Effect.succeed({ threadId: ThreadId.make("thread-cloud") });
          }),
      },
    });

    const response = yield* send("POST", port, path, headers, body);

    assert.equal(response.status, status);
    if (status === 404) assert.equal(response.body, "");
    else if (status === 200) assert.deepEqual(JSON.parse(response.body), JSON.parse(expected!));
    else assert.notEqual(decodeFailure(response.body).reason, null);
    if (refuse === true) {
      assert.deepEqual(decodeFailure(response.body), {
        reason: "refused",
        message: "Add an account on Pair Cloud, on your row in Settings → Team.",
      });
    }
    // The launch runs as the link's session: its member, label and access.
    if (status === 200 && path === LAUNCH_PATH) {
      assert.deepEqual(sessions, [
        {
          memberId: linkMember,
          sessionId: AuthSessionId.make("session-1"),
          label: "Laptop",
          access: "approval-required",
        },
      ]);
    }
    if (status !== 200 && refuse !== true) assert.deepEqual(sessions, []);
  }).pipe(Effect.scoped),
);
