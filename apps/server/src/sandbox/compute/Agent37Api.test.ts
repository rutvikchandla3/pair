import { assert, describe, it } from "@effect/vitest";
import { ComputeDriverId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { Agent37ApiError, makeAgent37Api, mapAgent37Error } from "./Agent37Api.ts";
import * as Agent37ApiFake from "./Agent37ApiTesting.ts";
import type { ComputeDriverError } from "./ComputeDriver.ts";

const DRIVER_ID = ComputeDriverId.make("agent37-test");

const status = (code: number, agent37Code?: string, retryAfterMs?: number) =>
  new Agent37ApiError({
    endpoint: "POST /instances",
    failure: "status",
    status: code,
    ...(agent37Code === undefined ? {} : { code: agent37Code }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

type Expected = Pick<ComputeDriverError, "reason" | "retryable" | "retryAfterMs"> & {
  readonly hint?: boolean;
};

describe("mapAgent37Error", () => {
  const rows: ReadonlyArray<
    readonly [string, ComputeDriverError["operation"], Agent37ApiError, Expected]
  > = [
    ["404", "create", status(404, "not_found"), { reason: "not-found", retryable: false }],
    [
      "402 insufficient_balance",
      "create",
      status(402, "insufficient_balance"),
      { reason: "quota", retryable: false, hint: true },
    ],
    [
      "402 on start stays retryable, fast",
      "start",
      status(402, "insufficient_balance"),
      { reason: "quota", retryable: true, retryAfterMs: 5_000, hint: true },
    ],
    [
      "409 instance_limit_reached",
      "create",
      status(409, "instance_limit_reached"),
      { reason: "quota", retryable: true, retryAfterMs: 60_000, hint: true },
    ],
    [
      "503 no_capacity",
      "create",
      status(503, "no_capacity"),
      { reason: "capacity", retryable: true, retryAfterMs: 5_000 },
    ],
    [
      "409 capacity_unavailable on start",
      "start",
      status(409, "capacity_unavailable"),
      { reason: "capacity", retryable: true, retryAfterMs: 5_000 },
    ],
    [
      "409 try_again with Retry-After",
      "stop",
      status(409, "try_again", 3_000),
      { reason: "unavailable", retryable: true, retryAfterMs: 3_000 },
    ],
    [
      "409 template_conflict",
      "health",
      status(409, "template_conflict"),
      { reason: "conflict", retryable: false },
    ],
    [
      "429 capped at a minute on stop",
      "stop",
      status(429, "rate_limited", 3_600_000),
      { reason: "rate-limited", retryable: true, retryAfterMs: 60_000 },
    ],
    [
      "401 invalid_api_key",
      "create",
      status(401, "invalid_api_key"),
      { reason: "auth", retryable: false, hint: true },
    ],
    [
      "403 ip_not_allowed",
      "health",
      status(403, "ip_not_allowed"),
      { reason: "auth", retryable: false, hint: true },
    ],
    [
      "502 provisioning_failed",
      "create",
      status(502, "provisioning_failed"),
      { reason: "unavailable", retryable: true, retryAfterMs: 5_000 },
    ],
    [
      "400 invalid_request",
      "create",
      status(400, "invalid_request"),
      { reason: "invalid-request", retryable: false },
    ],
    [
      "transport",
      "create",
      new Agent37ApiError({ endpoint: "POST /instances", failure: "transport" }),
      { reason: "unavailable", retryable: true, retryAfterMs: 5_000 },
    ],
    [
      "an unreadable key",
      "create",
      new Agent37ApiError({ endpoint: "API key", failure: "credential" }),
      { reason: "auth", retryable: false, hint: true },
    ],
  ];
  it.each(rows)("%s", (_name, operation, error, expected) => {
    const mapped = mapAgent37Error(error, { driverId: DRIVER_ID, operation });
    const { hint, ...rest } = expected;
    assert.deepStrictEqual(
      { reason: mapped.reason, retryable: mapped.retryable, retryAfterMs: mapped.retryAfterMs },
      { retryAfterMs: undefined, ...rest },
    );
    assert.strictEqual(mapped.setupHint !== undefined, hint === true);
    assert.strictEqual(mapped.backendStatus, error.status);
  });
});

describe("Agent37Api", () => {
  it.effect("reads a transport rejection's flat string code", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "container_unavailable" }, { status: 502 }),
          ),
        ),
      );
      const api = makeAgent37Api(client, { apiKey: () => Effect.succeed("sk_live_test") });
      const error = yield* Effect.flip(api.instances.exec("ab12cd34ef", "true"));
      assert.deepStrictEqual(
        { status: error.status, code: error.code },
        { status: 502, code: "container_unavailable" },
      );
    }),
  );

  it.effect("reads the key again once on a 401, and keeps the new one", () =>
    Effect.gen(function* () {
      const fake = yield* Agent37ApiFake.make();
      fake.failNext("GET /billing", { status: 401, code: "invalid_api_key" });
      const reads: Array<boolean> = [];
      const api = makeAgent37Api(fake.client, {
        apiKey: (refresh) =>
          Effect.sync(() => {
            reads.push(refresh);
            return refresh ? "sk_live_rotated" : "sk_live_old";
          }),
      });
      yield* api.billing;
      yield* api.billing;
      assert.deepStrictEqual(reads, [false, true]);
      assert.deepStrictEqual(
        fake.requests.map((request) => request.headers.authorization),
        ["Bearer sk_live_old", "Bearer sk_live_rotated", "Bearer sk_live_rotated"],
      );
    }),
  );
});
