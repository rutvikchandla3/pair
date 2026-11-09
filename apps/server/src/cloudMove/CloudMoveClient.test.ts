import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, PeerLinkError, ThreadId, ThreadMoveError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as CloudMoveClient from "./CloudMoveClient.ts";

const CLOUD = EnvironmentId.make("env-cloud");
const THREAD = ThreadId.make("thread-1");
const LABEL = "Acme Pair Cloud";
const SEED_HEADERS = {
  "t3-move-mode": "move",
  "t3-move-branch": encodeURIComponent("feature/ünïcode"),
  "t3-move-origin": "github.com/acme/app",
  "t3-move-head": "a".repeat(40),
};

interface Answer {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array;
}

const layerFor = (options: {
  readonly answer?: Answer;
  readonly resolve?: PeerLinkError;
  readonly cloudImport?: boolean;
  readonly transportFails?: boolean;
  readonly requests: Array<{ readonly url: string; readonly authorization: string | undefined }>;
  readonly outcomes: Array<string | null>;
}) =>
  CloudMoveClient.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(PeerLinks.PeerLinks)({
          resolve: () =>
            options.resolve === undefined
              ? Effect.succeed({
                  link: { label: LABEL },
                  url: "http://cloud.test",
                  token: "link-token",
                  capabilities: { cloudImport: options.cloudImport ?? true },
                } as never)
              : Effect.fail(options.resolve),
          get: () => Effect.succeedSome({ label: LABEL } as never),
          recordOutcome: (_environmentId, { error }) =>
            Effect.sync(() => void options.outcomes.push(error)),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            options.requests.push({
              url: `${request.url}?${UrlParams.toString(request.urlParams)}`,
              authorization: request.headers["authorization"],
            });
            if (options.transportFails === true) {
              return Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({ request }),
                }),
              );
            }
            const answer = options.answer ?? { status: 204 };
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(answer.body ?? null, {
                  status: answer.status,
                  ...(answer.headers === undefined ? {} : { headers: answer.headers }),
                }),
              ),
            );
          }),
        ),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const failureBody = (message: string) => JSON.stringify({ reason: "run-active", message });

it.effect.each<{
  readonly name: string;
  readonly answer?: Answer;
  readonly resolve?: PeerLinkError;
  readonly cloudImport?: boolean;
  readonly transportFails?: boolean;
  readonly check?: "refuse";
  readonly expected: Pick<ThreadMoveError, "reason" | "message">;
  readonly outcome: string | null | "none";
}>([
  {
    name: "a 401",
    answer: { status: 401 },
    expected: {
      reason: "not-linked",
      message: `${LABEL} no longer accepts this computer's link. Link it again in Settings → Environments.`,
    },
    outcome: `${LABEL} no longer accepts this computer's link. Link it again in Settings → Environments.`,
  },
  {
    name: "a 409 with a CloudMoveFailure",
    answer: { status: 409, body: failureBody("A turn is running.") },
    expected: { reason: "refused", message: "A turn is running." },
    outcome: null,
  },
  {
    name: "a peer without cloudImport",
    cloudImport: false,
    expected: {
      reason: "unsupported",
      message: `${LABEL} needs an update to move threads. Ask an admin.`,
    },
    outcome: "none",
  },
  {
    name: "an expired link",
    resolve: new PeerLinkError({ reason: "expired", message: "The link expired." }),
    expected: {
      reason: "not-linked",
      message: `Link this computer to ${LABEL} in Settings → Environments.`,
    },
    outcome: "none",
  },
  {
    name: "an unreachable peer",
    resolve: new PeerLinkError({ reason: "unreachable", message: "No address answered." }),
    expected: { reason: "failed", message: "No address answered." },
    outcome: "none",
  },
  {
    name: "a transport failure",
    transportFails: true,
    expected: { reason: "failed", message: `${LABEL} stopped answering. Try again.` },
    outcome: "Transport error (GET http://cloud.test/api/cloud-moves/threads/thread-1/seed)",
  },
  {
    name: "a body over the cap",
    answer: {
      status: 200,
      headers: { ...SEED_HEADERS, "content-length": String(512 * 1024 * 1024 + 1) },
      body: new Uint8Array(4),
    },
    expected: {
      reason: "refused",
      message: "The download would be over 512 MB. Fetch origin on this computer, then try again.",
    },
    outcome: null,
  },
  {
    name: "headers whose check fails",
    answer: { status: 200, headers: SEED_HEADERS, body: new Uint8Array([1, 2, 3]) },
    check: "refuse",
    expected: { reason: "project-mismatch", message: "Not this project." },
    outcome: null,
  },
])("maps $name", (testCase) => {
  const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
  const outcomes: Array<string | null> = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cloud-move-client-" });
    const file = `${dir}/seed.bundle`;
    const client = yield* CloudMoveClient.CloudMoveClient;

    const failure = yield* client
      .downloadSeed({
        environmentId: CLOUD,
        threadId: THREAD,
        haves: ["c".repeat(40)],
        file,
        check: () =>
          testCase.check === "refuse"
            ? Effect.fail(
                new ThreadMoveError({ reason: "project-mismatch", message: "Not this project." }),
              )
            : Effect.void,
      })
      .pipe(Effect.flip);

    assert.deepEqual({ reason: failure.reason, message: failure.message }, testCase.expected);
    assert.isFalse(yield* fs.exists(file));
    assert.deepEqual(outcomes, testCase.outcome === "none" ? [] : [testCase.outcome]);
    for (const request of requests) assert.equal(request.authorization, "Bearer link-token");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      layerFor({
        ...(testCase.answer === undefined ? {} : { answer: testCase.answer }),
        ...(testCase.resolve === undefined ? {} : { resolve: testCase.resolve }),
        ...(testCase.cloudImport === undefined ? {} : { cloudImport: testCase.cloudImport }),
        ...(testCase.transportFails === undefined ? {} : { transportFails: true }),
        requests,
        outcomes,
      }),
    ),
  );
});

it.effect("downloads a seed past the haves, and reads an empty one as nothing written", () => {
  const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
  const outcomes: Array<string | null> = [];
  const bytes = new Uint8Array([9, 8, 7, 6]);
  let answer: Answer = {
    status: 200,
    headers: {
      ...SEED_HEADERS,
      "t3-move-base": "main",
      "t3-move-snapshot": "b".repeat(40),
      "t3-move-snapshot-at": "2026-11-09T14:02:00.000Z",
    },
    body: bytes,
  };
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cloud-move-client-" });
    const client = yield* CloudMoveClient.CloudMoveClient;
    const download = (file: string) =>
      client.downloadSeed({
        environmentId: CLOUD,
        threadId: THREAD,
        haves: ["c".repeat(40), "d".repeat(40)],
        file,
        check: () => Effect.void,
      });

    const full = yield* download(`${dir}/full.bundle`);
    answer = { status: 204, headers: SEED_HEADERS };
    const empty = yield* download(`${dir}/empty.bundle`);

    assert.deepEqual(full, {
      written: true,
      facts: {
        mode: "move",
        branch: "feature/ünïcode",
        baseRef: "main",
        origin: "github.com/acme/app",
        head: "a".repeat(40),
        snapshot: "b".repeat(40),
      },
    });
    assert.deepEqual([...(yield* fs.readFile(`${dir}/full.bundle`))], [...bytes]);
    assert.equal(empty.written, false);
    assert.isFalse(yield* fs.exists(`${dir}/empty.bundle`));
    assert.equal(
      requests[0]?.url,
      `http://cloud.test/api/cloud-moves/threads/${THREAD}/seed?have=${"c".repeat(40)}&have=${"d".repeat(40)}`,
    );
    assert.deepEqual(outcomes, [null, null]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      layerFor({
        // Read on each request, so the second download gets the 204.
        get answer() {
          return answer;
        },
        requests,
        outcomes,
      }),
    ),
  );
});
