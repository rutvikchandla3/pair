import { assert, describe, it } from "@effect/vitest";
import {
  type BoatSandboxDriver,
  ComputeDriverId,
  EnvironmentId,
  SandboxId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { TestClock } from "effect/testing";

import * as BoatApiFake from "./BoatApiTesting.ts";
import { builderStateOf, makeWithApi } from "./BoatComputeDriver.ts";
import {
  type ComputeDriverCreateInput,
  type ComputeDriverError,
  type SandboxBootstrap,
  sandboxBackendName,
  sandboxTags,
} from "./ComputeDriver.ts";
import { vmBootstrapText } from "./vmHelpers.ts";
import type { SandboxProvisionTreeInfo } from "../image/SandboxProvisionTree.ts";

const INSTALL = EnvironmentId.make("3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f");
const SANDBOX = SandboxId.make("sbx_0123456789abcdef0123");
const OTHER_SANDBOX = SandboxId.make("sbx_fedcba9876543210fedc");
const DRIVER_ID = ComputeDriverId.make("boat-test");
const TREE: SandboxProvisionTreeInfo = {
  tarGzBase64: "H4sIAAAAAAAAA+3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwN8GAAAAAA==",
  sha256: `0a1b2c3d4e5f${"0".repeat(52)}`,
  pairVersion: "1.2.3",
  baseBuildScript: "#!/bin/bash\n# vm/base-build.sh\n",
};
const BASE_IMAGE = "pair-3f2a9c1e-base-0a1b2c3d4e5f";
const BUILDER = "pair-3f2a9c1e-basebuild-0a1b2c3d4e5f";
const SECRET = "enroll-secret-value";
const NAME = sandboxBackendName(INSTALL, SANDBOX, 1);
const LIST_STATES =
  "init,provisioning,provisioned,cloning,ready,idle,running,archiving,archived,error";

const config: BoatSandboxDriver = {
  kind: "boat",
  id: DRIVER_ID,
  label: "boat.dev",
  apiKey: "boat_test_key",
  runnerUrl: "https://pair.example.test",
};

const setup = Effect.fn("BoatComputeDriverTest.setup")(function* (
  options: {
    readonly config?: Partial<BoatSandboxDriver>;
    readonly cloudOnly?: boolean;
    /** Absent: this tree's base image is saved and ready. */
    readonly baseImage?: false;
    readonly pageSize?: number;
    readonly onRequest?: (request: BoatApiFake.FakeBoatRequest) => Effect.Effect<void>;
  } = {},
) {
  const fake = yield* BoatApiFake.make({
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    ...(options.onRequest === undefined ? {} : { onRequest: options.onRequest }),
  });
  if (options.baseImage !== false) {
    fake.addSavedSnapshot({
      name: BASE_IMAGE,
      files: { "etc/pair-image.json": '{"pairVersion":"1.2.3","providers":{}}' },
    });
  }
  const driver = yield* makeWithApi({ ...config, ...options.config }, INSTALL, fake.api(), {
    cloudOnly: options.cloudOnly ?? true,
    provisionTree: Effect.succeed(TREE),
  });
  return { fake, driver };
});

const bootstrap = (generation = 1, sandboxId = SANDBOX): SandboxBootstrap => ({
  sandboxId,
  generation,
  runnerBuildId: "build-1",
  serverUrl: "https://pair.example.test",
  enrollmentSecret: Redacted.make(SECRET),
});

const createInput = (generation = 1, sandboxId = SANDBOX): ComputeDriverCreateInput => ({
  name: sandboxBackendName(INSTALL, sandboxId, generation),
  sandboxId,
  generation,
  image: { type: "base" },
  size: "small",
  tags: sandboxTags({ installId: INSTALL, sandboxId, generation, driverId: DRIVER_ID }),
  bootstrap: bootstrap(generation, sandboxId),
});

const bodies = (fake: BoatApiFake.BoatApiFake, method: string, path: RegExp) =>
  fake.requests
    .filter((request) => request.method === method && path.test(request.path))
    .map((request) => request.body);

describe("BoatComputeDriver", () => {
  it.effect("delivers the secret only through a file, never in a create, resume or command", () =>
    Effect.gen(function* () {
      const { fake, driver } = yield* setup();
      const input = createInput();

      const result = yield* driver.create(input);
      assert.deepStrictEqual(result, {
        driverRef: NAME,
        baseImage: {
          ref: BASE_IMAGE,
          digest: fake.savedSnapshot(BASE_IMAGE)!.snapshotId,
          version: "1.2.3",
        },
      });
      yield* driver.stop(NAME);
      yield* driver.start(NAME, bootstrap(2));

      const create = fake.requests.find(
        (request) => request.method === "POST" && request.path === "/sandboxes",
      );
      assert.deepStrictEqual(create?.body, {
        name: NAME,
        type: "small",
        from: BASE_IMAGE,
        labels: input.tags,
        ttlSeconds: null,
        noEnv: true,
        monitoring: false,
        snapshots: true,
      });
      assert.strictEqual(create?.headers["idempotency-key"], NAME);
      // A `type` would force a cold machine; `ttlSeconds` is kept.
      assert.deepStrictEqual(bodies(fake, "POST", /\/resume$/), [{}]);
      assert.deepStrictEqual(bodies(fake, "PUT", /\/files$/), [
        {
          path: "/tmp/pair-boot/bootstrap.env",
          content: vmBootstrapText(bootstrap(1))!,
          encoding: "utf8",
        },
        {
          path: "/tmp/pair-boot/bootstrap.env",
          content: vmBootstrapText(bootstrap(2))!,
          encoding: "utf8",
        },
      ]);
      assert.deepStrictEqual(bodies(fake, "POST", /\/commands$/), [
        { command: "sudo /usr/local/bin/pair-boat-boot 1", timeoutSeconds: 30 },
        { command: "sudo /usr/local/bin/pair-boat-boot 2", timeoutSeconds: 30 },
      ]);
      for (const request of fake.requests) {
        if (request.method === "PUT" && request.path.endsWith("/files")) continue;
        assert.notInclude(JSON.stringify(request), SECRET, `${request.method} ${request.path}`);
      }
    }),
  );

  it.effect("ends a create its sandbox outlives, and the replay delivers to the same one", () =>
    Effect.gen(function* () {
      let slow = true;
      let fake: BoatApiFake.BoatApiFake | undefined;
      const context = yield* setup({
        // A provisioning machine that the clock passes by, then one that is ready.
        onRequest: (request) => {
          const id = /^\/sandboxes\/(bx_[^/]+)$/.exec(request.path)?.[1];
          if (!slow || request.method !== "GET" || id === undefined) return Effect.void;
          return Effect.sync(() => {
            fake!.sandbox(id)!.held = true;
          }).pipe(Effect.andThen(TestClock.adjust("45 seconds")));
        },
      });
      fake = context.fake;

      const error = yield* Effect.flip(context.driver.create(createInput()));
      assert.deepStrictEqual(
        { reason: error.reason, retryable: error.retryable, retryAfterMs: error.retryAfterMs },
        { reason: "unavailable", retryable: true, retryAfterMs: 5_000 },
      );
      assert.strictEqual(fake.count("POST /sandboxes/{id}/commands"), 0);

      slow = false;
      fake.sandbox(NAME)!.held = false;
      yield* context.driver.create(createInput());
      assert.strictEqual(fake.count("POST /sandboxes"), 1);
      assert.strictEqual(fake.count("POST /sandboxes/{id}/commands"), 1);
    }),
  );

  it.effect("finds the first attempt's sandbox when boat says its key was reused", () =>
    Effect.gen(function* () {
      const input = createInput();
      let fake: BoatApiFake.BoatApiFake | undefined;
      const context = yield* setup({
        // The first attempt landed with another base image's body.
        onRequest: (request) =>
          request.method === "POST" && request.path === "/sandboxes"
            ? Effect.sync(() => {
                fake!.putSandbox({ name: NAME, labels: input.tags });
              })
            : Effect.void,
      });
      fake = context.fake;
      fake.failNext("POST /sandboxes", { status: 409, code: "idempotency_key_reused" });

      assert.strictEqual((yield* context.driver.create(input)).driverRef, NAME);
      assert.strictEqual(fake.sandboxes().filter((sandbox) => sandbox.name === NAME).length, 1);
      assert.strictEqual(fake.count("POST /sandboxes/{id}/commands"), 1);
    }),
  );

  describe("starts", () => {
    const rows: ReadonlyArray<
      readonly [
        string,
        {
          readonly state: string;
          readonly dataExpired?: boolean;
          readonly resumeFails?: BoatApiFake.FakeBoatFailure;
        },
        (
          | { readonly resumed: true }
          | (Pick<ComputeDriverError, "reason" | "retryable" | "retryAfterMs"> & {
              readonly hint?: boolean;
            })
        ),
      ]
    > = [
      ["a sandbox still archiving", { state: "archiving" }, { resumed: true }],
      ["a sandbox in error", { state: "error" }, { resumed: true }],
      [
        "a disk boat deleted as not-found",
        { state: "archived", dataExpired: true },
        { reason: "not-found", retryable: false },
      ],
      [
        "a resume refused with snapshot_data_expired as not-found",
        { state: "archived", resumeFails: { status: 409, code: "snapshot_data_expired" } },
        { reason: "not-found", retryable: false },
      ],
      [
        "an empty wallet as retryable, fast and with its hint",
        { state: "archived", resumeFails: { status: 402, code: "credit_required" } },
        { reason: "quota", retryable: true, retryAfterMs: 5_000, hint: true },
      ],
      [
        "an expired key as retryable, fast and with its hint",
        { state: "archived", resumeFails: { status: 403, code: "api_key_expired" } },
        { reason: "auth", retryable: true, retryAfterMs: 5_000, hint: true },
      ],
      [
        "an hour-long rate limit capped at a minute",
        {
          state: "archived",
          resumeFails: { status: 429, code: "rate_limited", retryAfterSeconds: 3600 },
        },
        { reason: "rate-limited", retryable: true, retryAfterMs: 60_000 },
      ],
    ];
    it.effect.each(rows)("%s", ([_name, given, expected]) =>
      Effect.gen(function* () {
        const { fake, driver } = yield* setup();
        const input = createInput();
        const sandbox = fake.putSandbox({ name: NAME, labels: input.tags, state: given.state });
        if (given.dataExpired === true) sandbox.dataExpiredAt = "2026-11-01T00:00:00.000Z";
        if (given.resumeFails !== undefined) {
          fake.failNext("POST /sandboxes/{id}/resume", given.resumeFails);
        }
        const started = yield* Effect.result(driver.start(NAME, bootstrap(2)));
        if ("resumed" in expected) {
          assert.strictEqual(started._tag, "Success");
          assert.strictEqual(fake.count("POST /sandboxes/{id}/resume"), 1);
          assert.strictEqual(fake.count("POST /sandboxes/{id}/commands"), 1);
          return;
        }
        assert.strictEqual(started._tag, "Failure");
        if (started._tag !== "Failure") return;
        const { hint, ...rest } = expected;
        assert.deepStrictEqual(
          {
            reason: started.failure.reason,
            retryable: started.failure.retryable,
            retryAfterMs: started.failure.retryAfterMs,
          },
          { retryAfterMs: undefined, ...rest },
        );
        assert.strictEqual(started.failure.setupHint !== undefined, hint === true);
        assert.strictEqual(fake.count("POST /sandboxes/{id}/commands"), 0);
      }),
    );
  });

  it.effect("stops at archiving, and makes no call for a stopped sandbox", () =>
    Effect.gen(function* () {
      const { fake, driver } = yield* setup();
      yield* driver.create(createInput());
      fake.sandbox(NAME)!.held = true;
      yield* driver.stop(NAME);
      assert.strictEqual(fake.sandbox(NAME)?.state, "archiving");
      assert.strictEqual((yield* driver.status(NAME)).status, "stopped");
      fake.sandbox(NAME)!.state = "archived";
      yield* driver.stop(NAME);
      assert.strictEqual(fake.count("POST /sandboxes/{id}/stop"), 1);
    }),
  );

  it.effect("deletes no image whose name is not this install's, without a call", () =>
    Effect.gen(function* () {
      const { fake, driver } = yield* setup();
      fake.addSavedSnapshot({ name: "their-image" });
      yield* driver.deleteImage("their-image");
      yield* driver.deleteImage("pair-contract-missing:4f1c");
      yield* driver.deleteImage("pair-3f2a9c1e-Not_A_Name");
      assert.strictEqual(fake.count("DELETE /saved-snapshots/{name}"), 0);
      assert.isDefined(fake.savedSnapshot("their-image"));

      fake.addSavedSnapshot({ name: "pair-3f2a9c1e-team-image-2" });
      yield* driver.deleteImage("pair-3f2a9c1e-team-image-2");
      assert.isUndefined(fake.savedSnapshot("pair-3f2a9c1e-team-image-2"));
    }),
  );

  it.effect("saves a team image once, never over another's, and again after a failed save", () =>
    Effect.gen(function* () {
      const { fake, driver } = yield* setup();
      yield* driver.create(createInput());
      yield* driver.create(createInput(1, OTHER_SANDBOX));

      const image = yield* driver.snapshot(NAME, "t3-team-image:3");
      assert.deepStrictEqual(yield* driver.snapshot(NAME, "t3-team-image:3"), image);
      assert.strictEqual(image.imageRef, "pair-3f2a9c1e-team-image-3");
      const other = sandboxBackendName(INSTALL, OTHER_SANDBOX, 1);
      const error = yield* Effect.flip(driver.snapshot(other, "t3-team-image:3"));
      assert.strictEqual(error.reason, "conflict");
      assert.strictEqual(fake.count("POST /saved-snapshots"), 1);

      fake.addSavedSnapshot({
        name: "pair-3f2a9c1e-team-image-4",
        status: "failed",
        sourceSandboxId: fake.sandbox(NAME)!.id,
      });
      const failed = yield* Effect.flip(driver.snapshot(NAME, "t3-team-image:4"));
      assert.strictEqual(failed.reason, "unavailable");
      assert.isUndefined(fake.savedSnapshot("pair-3f2a9c1e-team-image-4"));
      yield* driver.snapshot(NAME, "t3-team-image:4");
      assert.strictEqual(fake.savedSnapshot("pair-3f2a9c1e-team-image-4")?.status, "ready");
    }),
  );

  it.effect("reads an image's file, and null for a missing or stock one", () =>
    Effect.gen(function* () {
      const { fake, driver } = yield* setup();
      fake.addSavedSnapshot({
        name: "pair-3f2a9c1e-team-image-5",
        files: { "etc/t3/build.json": '{"ok":true}', "usr/bin/ls": "base-image" },
      });
      const read = (path: string) => driver.readImageFile("pair-3f2a9c1e-team-image-5", path);
      const file = yield* read("/etc/t3/build.json");
      assert.strictEqual(
        file instanceof Uint8Array ? new TextDecoder().decode(file) : file,
        '{"ok":true}',
      );
      assert.isNull(yield* read("/usr/bin/ls"));
      assert.isNull(yield* read("/etc/missing"));
    }),
  );

  it.effect("lists every state and page, and never the base builder", () =>
    Effect.gen(function* () {
      const { fake, driver } = yield* setup({ pageSize: 1 });
      yield* driver.create(createInput());
      yield* driver.create(createInput(1, OTHER_SANDBOX));
      yield* driver.stop(NAME);
      fake.putSandbox({ name: BUILDER, labels: { "pair.install": INSTALL } });
      fake.putSandbox({
        name: "pair-99999999-sbx_0123456789abcdef0123-g1",
        labels: { "pair.install": "another-install", "pair.sandbox": SANDBOX },
      });

      const listed = yield* driver.list({ "pair.install": INSTALL });
      assert.deepStrictEqual(
        listed.map((sandbox) => `${sandbox.sandboxId} ${sandbox.status}`).toSorted(),
        [`${OTHER_SANDBOX} running`, `${SANDBOX} stopped`].toSorted(),
      );
      const lists = fake.requests.filter(
        (request) => request.method === "GET" && request.path === "/sandboxes",
      );
      assert.isTrue(
        lists.every((request) =>
          request.query.some(([key, value]) => key === "state" && value === LIST_STATES),
        ),
      );
    }),
  );

  it.effect("asks for a key first, then an https runner URL, before calling boat", () =>
    Effect.gen(function* () {
      const noKey = yield* setup({ config: { apiKey: "", runnerUrl: "http://pair.example.test" } });
      const first = yield* Effect.flip(noKey.driver.health);
      assert.strictEqual(first.reason, "auth");
      assert.strictEqual(first.setupHint, "Paste a boat API key.");

      const http = yield* setup({ config: { runnerUrl: "http://pair.example.test" } });
      const second = yield* Effect.flip(http.driver.health);
      assert.strictEqual(second.reason, "invalid-request");
      assert.include(second.setupHint, "https://");
      const refused = yield* Effect.flip(http.driver.create(createInput()));
      assert.strictEqual(refused.reason, "invalid-request");
      assert.strictEqual(http.fake.count("GET /limits"), 0);
      assert.strictEqual(http.fake.count("POST /sandboxes"), 0);
    }),
  );

  it.effect("refuses everything off a cloud-only server, without a call", () =>
    Effect.gen(function* () {
      const { fake, driver } = yield* setup({ cloudOnly: false, baseImage: false });
      const failures = yield* Effect.all([
        Effect.flip(driver.create(createInput())),
        Effect.flip(driver.start(NAME, bootstrap())),
        Effect.flip(driver.stop(NAME)),
        Effect.flip(driver.list({})),
        Effect.flip(driver.health),
      ]);
      for (const error of failures) {
        assert.strictEqual(error.reason, "unsupported");
        assert.include(error.message, "--cloud-only");
      }
      assert.deepStrictEqual(fake.requests, []);
    }),
  );

  it.effect("launches the base image builder with the tree as files and no secrets", () =>
    Effect.gen(function* () {
      const launched = yield* Deferred.make<unknown>();
      yield* setup({
        baseImage: false,
        onRequest: (request) =>
          request.method === "POST" && request.path === "/sandboxes"
            ? Deferred.succeed(launched, request.body).pipe(Effect.asVoid)
            : Effect.void,
      });
      assert.deepStrictEqual(yield* Deferred.await(launched), {
        name: BUILDER,
        type: "small",
        ttlSeconds: 3600,
        noEnv: true,
        monitoring: false,
        snapshots: true,
        labels: { "pair.install": INSTALL },
        files: [
          { path: "/tmp/pair-base-build/metadata/pair-role", content: "base" },
          { path: "/tmp/pair-base-build/metadata/pair-provision", content: TREE.tarGzBase64 },
          { path: "/tmp/pair-base-build/metadata/pair-version", content: "1.2.3" },
          { path: "/tmp/pair-base-build/base-build.sh", content: TREE.baseBuildScript },
        ],
        setupScript:
          "sudo env PAIR_VM_TARGET=boat PAIR_METADATA_DIR=/tmp/pair-base-build/metadata bash /tmp/pair-base-build/base-build.sh >/tmp/pair-base-build/build.log 2>&1",
      });
    }),
  );

  it.each([
    ["provisioning", null, null, "starting"],
    ["ready", "running", null, "running"],
    ["running", "running", "ok", "stopped"],
    ["ready", "running", "failed:provision", "stopped"],
    ["idle", "done", null, "stopped"],
    ["ready", "failed", null, "stopped"],
    ["archived", null, null, "stopped"],
    ["error", "running", null, "stopped"],
  ] as const)(
    "reads a %s builder (setup %s, result %s) as %s",
    (state, setup, result, expected) => {
      assert.strictEqual(builderStateOf(state, setup, result), expected);
    },
  );
});
