import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CloudStagingKey,
  EnvironmentId,
  PeerLinkError,
  ProjectId,
  ThreadId,
  ThreadMoveError,
} from "@t3tools/contracts";
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

interface Sent {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly method?: string;
  readonly contentLength?: number | undefined;
  readonly contentType?: string | undefined;
}

const layerFor = (options: {
  readonly answer?: Answer;
  /** Answered in order, before `answer`. */
  readonly answers?: Array<Answer>;
  readonly resolve?: PeerLinkError;
  readonly cloudImport?: boolean;
  readonly transportFails?: boolean;
  readonly requests: Array<Sent>;
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
              method: request.method,
              contentLength:
                "contentLength" in request.body ? request.body.contentLength : undefined,
              contentType: "contentType" in request.body ? request.body.contentType : undefined,
            });
            if (options.transportFails === true) {
              return Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({ request }),
                }),
              );
            }
            const answer = options.answers?.shift() ?? options.answer ?? { status: 204 };
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
  const requests: Array<Sent> = [];
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
  const requests: Array<Sent> = [];
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

const KEY = CloudStagingKey.make(`mv_${"c".repeat(32)}`);
const resolved = {
  link: { environmentId: CLOUD, label: LABEL },
  url: "http://cloud.test",
  token: "link-token",
  capabilities: { cloudImport: true },
} as unknown as PeerLinks.ResolvedPeerLink;
const refusal = (reason: string) => JSON.stringify({ reason, message: `Refused: ${reason}.` });

it.effect.each<{
  readonly name: string;
  readonly answer: Answer;
  readonly expected: string | Pick<ThreadMoveError, "reason" | "message">;
}>([
  { name: "a stored seed", answer: { status: 204 }, expected: "stored" },
  {
    name: "a claimed key",
    answer: { status: 409, body: refusal("claimed") },
    expected: "claimed",
  },
  {
    name: "a missing prerequisite",
    answer: { status: 409, body: refusal("missing-prerequisite") },
    expected: "missing-prerequisite",
  },
  {
    name: "a seed over the cap",
    answer: { status: 413, body: refusal("too-large") },
    expected: { reason: "seed-too-large", message: "Refused: too-large." },
  },
  {
    name: "any other refusal",
    answer: { status: 422, body: refusal("invalid-seed") },
    expected: { reason: "upload-failed", message: "Refused: invalid-seed." },
  },
])("puts a seed with its length and reads $name", ({ answer, expected }) => {
  const requests: Array<Sent> = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* fs.makeTempFileScoped({ suffix: ".bundle" });
    yield* fs.writeFileString(file, "bundle bytes");
    const client = yield* CloudMoveClient.CloudMoveClient;

    const result = yield* client
      .putSeed(resolved, { key: KEY, projectId: ProjectId.make("project-cloud"), file })
      .pipe(
        Effect.map((outcome): typeof expected => outcome),
        Effect.catch((error) => Effect.succeed({ reason: error.reason, message: error.message })),
      );

    assert.deepEqual(result, expected);
    assert.deepEqual(requests, [
      {
        url: `http://cloud.test/api/cloud-moves/staged/${KEY}/seed?projectId=project-cloud`,
        authorization: "Bearer link-token",
        method: "PUT",
        contentLength: 12,
        contentType: "application/x-git-bundle",
      },
    ]);
  }).pipe(Effect.scoped, Effect.provide(layerFor({ answer, requests, outcomes: [] })));
});

it.effect("checks, launches and reads a launch's refusals", () => {
  const requests: Array<Sent> = [];
  const answers: Array<Answer> = [];
  return Effect.gen(function* () {
    const client = yield* CloudMoveClient.CloudMoveClient;
    const body = {
      projectId: ProjectId.make("project-cloud"),
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      title: "Fix the login form",
      baseRef: "main",
      seeded: false,
      runtimeMode: "full-access",
      interactionMode: "default",
      message: "Go on.",
      createdBy: "user",
      creationSource: "web",
    } as const;

    const launched = yield* client.launch(resolved, { key: KEY, body: body as never });
    const lost = yield* client.launch(resolved, { key: KEY, body: body as never });
    const refused = yield* client
      .launch(resolved, { key: KEY, body: body as never })
      .pipe(Effect.flip);
    const checkRefused = yield* client
      .check(resolved, {
        originKey: "github.com/acme/app",
        model: { driver: "codex", model: "gpt-5" },
      } as never)
      .pipe(Effect.flip);

    assert.deepEqual(launched, { threadId: ThreadId.make("thread-cloud") });
    assert.equal(lost, "branch-not-pushed");
    assert.deepEqual([refused.reason, refused.message], ["refused", "Refused: refused."]);
    assert.deepEqual(
      [checkRefused.reason, checkRefused.message],
      ["refused", "Refused: unknown-project."],
    );
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ...Array.from({ length: 3 }, () => [
          "POST",
          `http://cloud.test/api/cloud-moves/staged/${KEY}/launch?`,
        ]),
        ["POST", "http://cloud.test/api/cloud-moves/check?"],
      ],
    );
  }).pipe(
    Effect.provide(
      Layer.unwrap(
        Effect.sync(() => {
          answers.push(
            { status: 200, body: JSON.stringify({ threadId: "thread-cloud" }) },
            { status: 409, body: refusal("branch-not-pushed") },
            { status: 409, body: refusal("refused") },
            { status: 409, body: refusal("unknown-project") },
          );
          return layerFor({ answers, requests, outcomes: [] });
        }),
      ),
    ),
  );
});
