import { assert, describe, it } from "@effect/vitest";
import { ComputeDriverId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { BoatApiError, makeBoatApi, mapBoatError } from "./BoatApi.ts";
import * as BoatApiFake from "./BoatApiTesting.ts";
import type { ComputeDriverError } from "./ComputeDriver.ts";

const DRIVER_ID = ComputeDriverId.make("boat-test");

const status = (code: number, boatCode?: string, retryAfterMs?: number) =>
  new BoatApiError({
    endpoint: "POST /sandboxes",
    failure: "status",
    status: code,
    ...(boatCode === undefined ? {} : { code: boatCode }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

type Expected = Pick<ComputeDriverError, "reason" | "retryable" | "retryAfterMs"> & {
  readonly hint?: boolean;
};

describe("mapBoatError", () => {
  const rows: ReadonlyArray<
    readonly [string, ComputeDriverError["operation"], BoatApiError, Expected]
  > = [
    ["404", "create", status(404), { reason: "not-found", retryable: false }],
    [
      "409 snapshot_data_expired",
      "create",
      status(409, "snapshot_data_expired"),
      { reason: "not-found", retryable: false },
    ],
    [
      "409 idempotency_key_reused",
      "create",
      status(409, "idempotency_key_reused"),
      { reason: "conflict", retryable: false },
    ],
    [
      "409 sandbox_stopping with Retry-After",
      "create",
      status(409, "sandbox_stopping", 3_000),
      { reason: "unavailable", retryable: true, retryAfterMs: 3_000 },
    ],
    [
      "409 idempotency_in_progress",
      "create",
      status(409, "idempotency_in_progress"),
      { reason: "unavailable", retryable: true, retryAfterMs: 5_000 },
    ],
    [
      "429 rate_limited",
      "create",
      status(429, "rate_limited", 7_000),
      { reason: "rate-limited", retryable: true, retryAfterMs: 7_000 },
    ],
    [
      "429 IP_RATE_LIMIT_EXCEEDED",
      "create",
      status(429, "IP_RATE_LIMIT_EXCEEDED", 2_000),
      { reason: "rate-limited", retryable: true, retryAfterMs: 2_000 },
    ],
    [
      "429 limit_reached",
      "create",
      status(429, "limit_reached"),
      { reason: "quota", retryable: true, retryAfterMs: 60_000, hint: true },
    ],
    [
      "429 member_limit_reached",
      "create",
      status(429, "member_limit_reached"),
      { reason: "quota", retryable: true, retryAfterMs: 60_000, hint: true },
    ],
    [
      "402 credit_required",
      "create",
      status(402, "credit_required"),
      { reason: "quota", retryable: false, hint: true },
    ],
    [
      "402 billing_required",
      "create",
      status(402, "billing_required"),
      { reason: "quota", retryable: false, hint: true },
    ],
    [
      "402 team_member_cap_reached",
      "create",
      status(402, "team_member_cap_reached"),
      { reason: "quota", retryable: false, hint: true },
    ],
    [
      "429 trial_compute_limit_reached",
      "create",
      status(429, "trial_compute_limit_reached"),
      { reason: "quota", retryable: false, hint: true },
    ],
    [
      "400 trial_auto_stop_required",
      "create",
      status(400, "trial_auto_stop_required"),
      { reason: "quota", retryable: false, hint: true },
    ],
    [
      "403 trial_saved_snapshots_not_allowed",
      "snapshot",
      status(403, "trial_saved_snapshots_not_allowed"),
      { reason: "quota", retryable: false, hint: true },
    ],
    [
      "403 trial_machine_class_not_allowed",
      "create",
      status(403, "trial_machine_class_not_allowed"),
      { reason: "quota", retryable: false, hint: true },
    ],
    [
      "403 machine_class_plan_required",
      "create",
      status(403, "machine_class_plan_required"),
      { reason: "quota", retryable: false, hint: true },
    ],
    [
      "403 api_key_expired",
      "create",
      status(403, "api_key_expired"),
      { reason: "auth", retryable: false, hint: true },
    ],
    [
      "401",
      "create",
      status(401, "unauthorized"),
      { reason: "auth", retryable: false, hint: true },
    ],
    [
      "403 api_key_missing_action",
      "create",
      status(403, "api_key_missing_action"),
      { reason: "auth", retryable: false, hint: true },
    ],
    [
      "503 out_of_capacity",
      "create",
      status(503, "out_of_capacity", 30_000),
      { reason: "capacity", retryable: true, retryAfterMs: 30_000 },
    ],
    [
      "503 no_ready_machine",
      "create",
      status(503, "no_ready_machine", 2_000),
      { reason: "capacity", retryable: true, retryAfterMs: 2_000 },
    ],
    ["400", "create", status(400, "invalid_json"), { reason: "invalid-request", retryable: false }],
    [
      "413",
      "create",
      status(413, "file_too_large"),
      { reason: "invalid-request", retryable: false },
    ],
    [
      "502 boat_direct_failed",
      "create",
      status(502, "boat_direct_failed"),
      { reason: "unavailable", retryable: true, retryAfterMs: 5_000 },
    ],
    [
      "a network error",
      "create",
      new BoatApiError({ endpoint: "GET /sandboxes/{id}", failure: "transport" }),
      { reason: "unavailable", retryable: true, retryAfterMs: 5_000 },
    ],
    [
      "an unreadable key",
      "create",
      new BoatApiError({ endpoint: "GET /sandboxes/{id}", failure: "credential" }),
      { reason: "auth", retryable: false, hint: true },
    ],
    // B11: on start and stop only not-found is final, account errors fail fast, delays cap at 60 s.
    ["start: 404", "start", status(404), { reason: "not-found", retryable: false }],
    [
      "start: 409 snapshot_data_expired",
      "start",
      status(409, "snapshot_data_expired"),
      { reason: "not-found", retryable: false },
    ],
    [
      "start: 402 credit_required",
      "start",
      status(402, "credit_required"),
      { reason: "quota", retryable: true, retryAfterMs: 5_000, hint: true },
    ],
    [
      "start: 403 api_key_expired",
      "start",
      status(403, "api_key_expired"),
      { reason: "auth", retryable: true, retryAfterMs: 5_000, hint: true },
    ],
    [
      "start: 429 rate_limited for an hour",
      "start",
      status(429, "rate_limited", 3_600_000),
      { reason: "rate-limited", retryable: true, retryAfterMs: 60_000 },
    ],
    [
      "stop: 401",
      "stop",
      status(401, "unauthorized"),
      { reason: "auth", retryable: true, retryAfterMs: 5_000, hint: true },
    ],
    [
      "stop: 400",
      "stop",
      status(400, "invalid_json"),
      { reason: "invalid-request", retryable: true, retryAfterMs: 5_000 },
    ],
  ];
  it.each(rows)("%s", (_name, operation, error, expected) => {
    const mapped = mapBoatError(error, { driverId: DRIVER_ID, operation });
    const { hint, ...rest } = expected;
    assert.deepStrictEqual(
      { reason: mapped.reason, retryable: mapped.retryable, retryAfterMs: mapped.retryAfterMs },
      { retryAfterMs: undefined, ...rest },
    );
    assert.strictEqual(mapped.setupHint !== undefined, hint === true);
    assert.strictEqual(mapped.backendStatus, error.status);
  });
});

describe("BoatApi", () => {
  it.effect("reads a missing file as null, as boat answers one (400 ENOENT)", () =>
    Effect.gen(function* () {
      const fake = yield* BoatApiFake.make();
      const sandbox = fake.putSandbox({ name: "machine", labels: {}, state: "ready" });
      const api = fake.api();
      assert.isNull(yield* api.files.read(sandbox.id, "/tmp/pair-base-build/result"));
      yield* api.files.write(sandbox.id, "/tmp/pair-base-build/result", "ok\n");
      assert.strictEqual(yield* api.files.read(sandbox.id, "/tmp/pair-base-build/result"), "ok\n");
    }),
  );

  it.effect("reads the key again once on a 401, and keeps the new one", () =>
    Effect.gen(function* () {
      const fake = yield* BoatApiFake.make();
      fake.failNext("GET /limits", { status: 401, code: "unauthorized" });
      const reads: Array<boolean> = [];
      const api = makeBoatApi(fake.client, {
        apiKey: (refresh) =>
          Effect.sync(() => {
            reads.push(refresh);
            return refresh ? "boat_rotated" : "boat_old";
          }),
        organization: "team_1",
      });
      yield* api.limits;
      yield* api.limits;
      assert.deepStrictEqual(reads, [false, true]);
      assert.deepStrictEqual(
        fake.requests.map((request) => request.headers.authorization),
        ["Bearer boat_old", "Bearer boat_rotated", "Bearer boat_rotated"],
      );
      assert.isTrue(fake.requests.every((request) => request.headers["x-boat-org"] === "team_1"));
    }),
  );
});
