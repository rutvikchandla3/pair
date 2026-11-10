import { assert, describe, it } from "@effect/vitest";
import {
  ComputeDriverId,
  EnvironmentId,
  type GceSandboxDriver,
  SandboxId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import { TestClock } from "effect/testing";

import {
  type ComputeDriverCreateInput,
  ComputeDriverError,
  type SandboxBootstrap,
  sandboxBackendName,
  sandboxTags,
} from "./ComputeDriver.ts";
import { GceApiError, mapGceError } from "./GceApi.ts";
import * as GceApiFake from "./GceApiTesting.ts";
import { cloudSafeName, makeWithApi, teamImageName, vmBootstrapText } from "./GceComputeDriver.ts";
import type { SandboxProvisionTreeInfo } from "../image/SandboxProvisionTree.ts";

const INSTALL = EnvironmentId.make("3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f");
const SANDBOX = SandboxId.make("sbx_0123456789abcdef0123");
const OTHER_SANDBOX = SandboxId.make("sbx_fedcba9876543210fedc");
const DRIVER_ID = ComputeDriverId.make("gce-test");
const ZONE_A = "asia-south1-a";
const ZONE_B = "asia-south1-b";
const BASE_FAMILY = "pair-3f2a9c1e-base";
const BASE_IMAGE = `${BASE_FAMILY}-0a1b2c3d4e5f`;
const BUILDER = "pair-3f2a9c1e-basebuild-0a1b2c3d4e5f";
const TREE: SandboxProvisionTreeInfo = {
  tarGzBase64: "H4sIAAAAAAAAA+3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwN8GAAAAAA==",
  sha256: `0a1b2c3d4e5f${"0".repeat(52)}`,
  pairVersion: "1.2.3",
  baseBuildScript: "#!/bin/bash\n# vm/base-build.sh\n",
};
const SECRET = "enroll-secret-value";

const config: GceSandboxDriver = { kind: "gce", id: DRIVER_ID, label: "Compute Engine" };

const setup = Effect.fn("GceComputeDriverTest.setup")(function* (
  options: {
    readonly config?: Partial<GceSandboxDriver>;
    readonly zones?: ReadonlyArray<string>;
    readonly cloudOnly?: boolean;
    /** Absent: this tree's base image is built and ready. */
    readonly baseImage?: false | "foreign";
    readonly pageSize?: number;
    readonly stoppedLosesGuestAttributes?: boolean;
  } = {},
) {
  const fake = yield* GceApiFake.make({
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    ...(options.stoppedLosesGuestAttributes === undefined
      ? {}
      : { stoppedLosesGuestAttributes: options.stoppedLosesGuestAttributes }),
  });
  yield* fake.addImage({
    name: "ubuntu-2404-noble-amd64-v20261101",
    project: "ubuntu-os-cloud",
    family: "ubuntu-2404-lts-amd64",
  });
  const base =
    options.baseImage === false
      ? null
      : yield* fake.addImage({
          name: BASE_IMAGE,
          family: BASE_FAMILY,
          description: `Pair base image. pair-version=1.2.3 provision-sha256=${TREE.sha256}`,
          ...(options.baseImage === "foreign" ? {} : { labels: { "pair-install": INSTALL } }),
        });
  const driver = yield* makeWithApi({ ...config, ...options.config }, INSTALL, fake.api, {
    cloudOnly: options.cloudOnly ?? true,
    project: Effect.succeed(fake.project),
    zones: Effect.succeed(options.zones ?? [ZONE_A]),
    provisionTree: Effect.succeed(TREE),
  });
  return { fake, driver, base };
});

const bootstrap = (
  generation = 1,
  overrides: Partial<SandboxBootstrap> = {},
  sandboxId = SANDBOX,
): SandboxBootstrap => ({
  sandboxId,
  generation,
  runnerBuildId: "build-1",
  serverUrl: "http://10.0.0.2:3774",
  enrollmentSecret: Redacted.make(SECRET),
  ...overrides,
});

const createInput = (
  generation = 1,
  overrides: Partial<ComputeDriverCreateInput> = {},
  sandboxId = SANDBOX,
): ComputeDriverCreateInput => ({
  name: sandboxBackendName(INSTALL, sandboxId, generation),
  sandboxId,
  generation,
  image: { type: "base" },
  size: "small",
  tags: sandboxTags({ installId: INSTALL, sandboxId, generation, driverId: DRIVER_ID }),
  bootstrap: bootstrap(generation, {}, sandboxId),
  ...overrides,
});

const NAME = cloudSafeName(sandboxBackendName(INSTALL, SANDBOX, 1))!;

const countOf = (fake: GceApiFake.GceApiFake, method: GceApiFake.GceMethod) =>
  fake.calls.filter((entry) => entry.method === method).length;

const metadataOf = (
  instance: {
    readonly metadata?: {
      readonly items?: ReadonlyArray<{ readonly key: string; readonly value?: string }>;
    };
  } | null,
  key: string,
) => instance?.metadata?.items?.find((item) => item.key === key)?.value;

describe("GceComputeDriver", () => {
  it("names cloud resources", () => {
    assert.strictEqual(NAME, "pair-3f2a9c1e-sbx-0123456789abcdef0123-g1");
    assert.strictEqual(cloudSafeName("Bad Name"), null);
    assert.deepStrictEqual(teamImageName(INSTALL, "t3-team-image:14"), {
      name: "pair-3f2a9c1e-team-image-14",
      family: "pair-3f2a9c1e-team-image",
      build: "14",
    });
    assert.strictEqual(teamImageName(INSTALL, "no-build"), null);
  });

  it.effect("creates a machine with no identity, no address and only the bootstrap", () =>
    Effect.gen(function* () {
      const { fake, driver, base } = yield* setup();
      const input = createInput();

      const result = yield* driver.create(input);
      assert.deepStrictEqual(result, {
        driverRef: NAME,
        baseImage: { ref: base!.selfLink, digest: base!.id, version: "1.2.3" },
      });

      const [body] = GceApiFake.insertBodies(fake);
      assert.deepStrictEqual(body!.serviceAccounts, []);
      assert.deepStrictEqual(body!.networkInterfaces, [{ network: "global/networks/default" }]);
      assert.deepStrictEqual(body!.labels, {
        "pair-install": INSTALL,
        "pair-sandbox": SANDBOX,
        "pair-generation": "1",
        "pair-driver": DRIVER_ID,
      });
      assert.deepStrictEqual(body!.metadata.items, [
        { key: "pair-bootstrap", value: vmBootstrapText(input.bootstrap)! },
        { key: "pair-generation", value: "1" },
        { key: "block-project-ssh-keys", value: "TRUE" },
        { key: "enable-oslogin", value: "FALSE" },
        { key: "serial-port-enable", value: "FALSE" },
      ]);
      assert.strictEqual(
        vmBootstrapText(input.bootstrap),
        `PAIR_RUNNER_URL='http://10.0.0.2:3774'\nPAIR_SANDBOX_ID='${SANDBOX}'\nPAIR_RUNNER_BUILD='build-1'\nPAIR_RUNNER_ENROLL='${SECRET}'\n`,
      );
      assert.deepStrictEqual(body!.disks, [
        {
          boot: true,
          autoDelete: true,
          type: "PERSISTENT",
          initializeParams: {
            sourceImage: base!.selfLink,
            diskSizeGb: "50",
            diskType: `zones/${ZONE_A}/diskTypes/pd-balanced`,
            labels: body!.labels,
          },
        },
      ]);
      assert.strictEqual(body!.machineType, `zones/${ZONE_A}/machineTypes/e2-standard-2`);
      assert.deepStrictEqual(body!.scheduling, {
        automaticRestart: false,
        onHostMaintenance: "MIGRATE",
      });
      assert.deepStrictEqual(body!.shieldedInstanceConfig, {
        enableVtpm: true,
        enableIntegrityMonitoring: true,
      });
      // The secret is only in the bootstrap value.
      const { metadata: _, ...rest } = body!;
      assert.notInclude(JSON.stringify(rest), SECRET);
    }),
  );

  it.effect("sets the subnetwork, network tags and the KMS key when configured", () =>
    Effect.gen(function* () {
      const kmsKey = "projects/p/locations/asia-south1/keyRings/r/cryptoKeys/k";
      const { fake, driver } = yield* setup({
        config: {
          subnetwork: "regions/asia-south1/subnetworks/machines",
          networkTags: ["pair-machine"],
          kmsKey,
          diskGb: 80,
          machineTypes: { small: "n2-standard-2" },
        },
      });
      yield* driver.create(createInput());

      const [body] = GceApiFake.insertBodies(fake);
      assert.deepStrictEqual(body!.networkInterfaces, [
        { subnetwork: "regions/asia-south1/subnetworks/machines" },
      ]);
      assert.deepStrictEqual(body!.tags, { items: ["pair-machine"] });
      assert.deepStrictEqual(body!.disks[0]!.diskEncryptionKey, { kmsKeyName: kmsKey });
      assert.strictEqual(body!.disks[0]!.initializeParams.diskSizeGb, "80");
      assert.strictEqual(body!.machineType, `zones/${ZONE_A}/machineTypes/n2-standard-2`);
    }),
  );

  describe("refuses", () => {
    it.effect("everything off a cloud-only server, without a call", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* setup({ cloudOnly: false });
        const failures = yield* Effect.all([
          Effect.flip(driver.create(createInput())),
          Effect.flip(driver.start(NAME, bootstrap())),
          Effect.flip(driver.stop(NAME)),
          Effect.flip(driver.destroy(NAME)),
          Effect.flip(driver.status(NAME)),
          Effect.flip(driver.list({})),
          Effect.flip(driver.deleteImage("image")),
          Effect.flip(driver.snapshot(NAME, "t3-team-image:1")),
          Effect.flip(driver.readImageFile("image", "/etc/hostname")),
          Effect.flip(driver.health),
        ]);
        for (const error of failures) {
          assert.strictEqual(error.reason, "unsupported");
          assert.strictEqual(error.retryable, false);
          assert.include(error.message, "--cloud-only");
        }
        assert.deepStrictEqual(fake.calls, []);
      }),
    );

    it.effect("a bootstrap with a line break or a socket URL", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* setup();
        const broken = yield* Effect.flip(
          driver.create({ ...createInput(), bootstrap: bootstrap(1, { runnerBuildId: "a\nb" }) }),
        );
        assert.strictEqual(broken.reason, "invalid-request");
        const socket = yield* Effect.flip(
          driver.create({
            ...createInput(),
            bootstrap: bootstrap(1, { serverUrl: "unix:/run/t3/runner.sock" }),
          }),
        );
        assert.strictEqual(socket.reason, "invalid-request");
        assert.strictEqual(countOf(fake, "instances.insert"), 0);
      }),
    );

    it.effect("deleting an image this install did not make", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* setup();
        const theirs = yield* fake.addImage({
          name: "their-image",
          labels: { "pair-install": "someone-else" },
        });
        const error = yield* Effect.flip(driver.deleteImage(theirs.selfLink));
        assert.strictEqual(error.reason, "invalid-request");
        assert.notStrictEqual(fake.image("their-image"), null);
        assert.strictEqual(countOf(fake, "images.delete"), 0);
      }),
    );

    it.effect("a snapshot onto a name another machine made", () =>
      Effect.gen(function* () {
        const { driver } = yield* setup();
        const first = yield* driver.create(createInput());
        const second = yield* driver.create(createInput(1, {}, OTHER_SANDBOX));
        yield* driver.snapshot(first.driverRef, "t3-team-image:3");
        const error = yield* Effect.flip(driver.snapshot(second.driverRef, "t3-team-image:3"));
        assert.strictEqual(error.reason, "conflict");
      }),
    );

    it.effect("a build image that is gone", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* setup();
        const error = yield* Effect.flip(
          driver.create(
            createInput(1, {
              image: {
                type: "build",
                imageRef: `https://www.googleapis.com/compute/v1/projects/${fake.project}/global/images/pair-3f2a9c1e-team-image-9`,
              },
            }),
          ),
        );
        assert.strictEqual(error.reason, "not-found");
        assert.strictEqual(countOf(fake, "instances.insert"), 0);
      }),
    );
  });

  describe("builds its base image", () => {
    const failedHint =
      "The base image build failed at `provision`. The builder's last console lines are in this server's log. Choose Refresh to build it again.";

    it.effect("on a builder that reaches nothing of ours, and says so while it runs", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* setup({ baseImage: false });
        yield* Queue.take(fake.waits);

        const [body] = GceApiFake.insertBodies(fake);
        assert.strictEqual(body!.name, BUILDER);
        assert.deepStrictEqual(body!.labels, { "pair-install": INSTALL });
        assert.deepStrictEqual(body!.serviceAccounts, []);
        assert.deepStrictEqual(body!.networkInterfaces, [{ network: "global/networks/default" }]);
        assert.deepStrictEqual(body!.scheduling, {
          automaticRestart: false,
          onHostMaintenance: "MIGRATE",
        });
        assert.deepStrictEqual(body!.disks[0]!.initializeParams, {
          sourceImage: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
          diskSizeGb: "20",
          diskType: `zones/${ZONE_A}/diskTypes/pd-balanced`,
          labels: { "pair-install": INSTALL },
        });
        assert.deepStrictEqual(body!.metadata.items, [
          { key: "startup-script", value: TREE.baseBuildScript },
          { key: "pair-role", value: "base" },
          { key: "pair-provision", value: TREE.tarGzBase64 },
          { key: "pair-version", value: "1.2.3" },
          { key: "enable-guest-attributes", value: "TRUE" },
          { key: "block-project-ssh-keys", value: "TRUE" },
          { key: "enable-oslogin", value: "FALSE" },
          { key: "serial-port-enable", value: "FALSE" },
        ]);

        assert.deepStrictEqual((yield* driver.health).baseImage, { pulling: BASE_IMAGE });
        const error = yield* Effect.flip(driver.create(createInput()));
        assert.strictEqual(error.reason, "unavailable");
        assert.strictEqual(error.retryable, true);
        assert.deepStrictEqual(error.image, { ref: BASE_IMAGE, state: "building" });
        assert.deepStrictEqual(yield* driver.list({ "pair.install": INSTALL }), []);
        assert.strictEqual(countOf(fake, "instances.insert"), 1);
      }),
    );

    it.effect("captures the builder's disk once it reports ok, then deletes the builder", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* setup({ baseImage: false });
        yield* Queue.take(fake.waits);
        fake.setGuestAttribute(ZONE_A, BUILDER, "pair/provision", "ok");
        fake.powerOff(ZONE_A, BUILDER);

        yield* TestClock.adjust("30 seconds");
        const image = fake.image(BASE_IMAGE);
        assert.strictEqual(image?.family, BASE_FAMILY);
        assert.deepStrictEqual(image?.labels, { "pair-install": INSTALL });
        yield* TestClock.adjust("30 seconds");
        assert.deepStrictEqual(fake.instancesNamed(BUILDER), []);
        yield* TestClock.adjust("30 seconds");

        assert.deepStrictEqual((yield* driver.health).baseImage, {
          ref: image!.selfLink,
          digest: image!.id,
          version: "1.2.3",
        });
        yield* driver.create(createInput());
        const [, machine] = GceApiFake.insertBodies(fake);
        assert.strictEqual(machine!.disks[0]!.initializeParams.sourceImage, image!.selfLink);
        // Ready and settled: it stops stepping.
        const reads = countOf(fake, "images.get");
        yield* TestClock.adjust("10 minutes");
        assert.strictEqual(countOf(fake, "images.get"), reads);
      }),
    );

    it.effect("reads a stopped builder's result from its console, past a failed step", () =>
      Effect.gen(function* () {
        const { fake } = yield* setup({ baseImage: false, stoppedLosesGuestAttributes: true });
        yield* Queue.take(fake.waits);
        fake.setGuestAttribute(ZONE_A, BUILDER, "pair/provision", "ok");
        fake.writeSerial(ZONE_A, BUILDER, "pair-base-build: finished");
        fake.writeSerial(ZONE_A, BUILDER, "pair-provision-result=ok");
        fake.powerOff(ZONE_A, BUILDER);
        fake.failNext(
          "images.insert",
          new GceApiError({ endpoint: "POST /global/images", failure: "status", status: 503 }),
        );

        yield* TestClock.adjust("30 seconds");
        assert.strictEqual(fake.image(BASE_IMAGE), null);
        yield* TestClock.adjust("30 seconds");
        assert.notStrictEqual(fake.image(BASE_IMAGE), null);
      }),
    );

    it.effect("names the step that failed, then waits for health to start again", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* setup({ baseImage: false });
        yield* Queue.take(fake.waits);
        fake.setGuestAttribute(ZONE_A, BUILDER, "pair/provision", "failed:provision");
        fake.powerOff(ZONE_A, BUILDER);
        yield* TestClock.adjust("30 seconds");
        assert.deepStrictEqual(fake.instancesNamed(BUILDER), []);

        const error = yield* Effect.flip(driver.create(createInput()));
        assert.strictEqual(error.retryable, false);
        assert.deepStrictEqual(error.image, {
          ref: BASE_IMAGE,
          state: "missing",
          hint: failedHint,
        });
        yield* TestClock.adjust("10 minutes");
        assert.strictEqual(countOf(fake, "instances.insert"), 1);

        yield* Queue.clear(fake.waits);
        assert.deepStrictEqual((yield* driver.health).baseImage, {
          missing: BASE_IMAGE,
          hint: failedHint,
        });
        yield* Queue.take(fake.waits);
        assert.strictEqual(countOf(fake, "instances.insert"), 2);
        assert.deepStrictEqual((yield* driver.health).baseImage, { pulling: BASE_IMAGE });
      }),
    );

    it.effect("leaves an image of its name that this install did not make", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* setup({ baseImage: "foreign" });
        assert.deepStrictEqual((yield* driver.health).baseImage, {
          missing: BASE_IMAGE,
          hint: `\`${BASE_IMAGE}\` is in this project but this server did not make it, so it is left alone. Delete or rename it, then choose Refresh.`,
        });
        assert.notStrictEqual(fake.image(BASE_IMAGE), null);
        assert.strictEqual(countOf(fake, "images.delete"), 0);
        assert.strictEqual(countOf(fake, "instances.insert"), 0);
      }),
    );

    it.effect("never when one is named", () =>
      Effect.gen(function* () {
        const { fake, driver, base } = yield* setup({ config: { baseImage: BASE_IMAGE } });
        assert.deepStrictEqual((yield* driver.health).baseImage, {
          ref: base!.selfLink,
          digest: base!.id,
          version: "1.2.3",
        });
        assert.strictEqual(countOf(fake, "instances.get"), 0);
        assert.strictEqual(countOf(fake, "images.list"), 0);
      }),
    );
  });

  describe("maps Compute Engine errors", () => {
    const status = (code: number, reason?: string, retryAfterMs?: number) =>
      new GceApiError({
        endpoint: "GET /zones/{zone}/instances/{name}",
        failure: "status",
        status: code,
        ...(reason === undefined ? {} : { reason }),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    const operation = (code: string, httpStatus = 503) =>
      new GceApiError({
        endpoint: "POST /zones/{zone}/instances",
        failure: "operation",
        status: httpStatus,
        reason: code,
      });
    const rows: ReadonlyArray<
      readonly [
        string,
        GceApiError,
        Pick<ComputeDriverError, "reason" | "retryable" | "retryAfterMs">,
      ]
    > = [
      ["404", status(404, "notFound"), { reason: "not-found", retryable: false }],
      ["409 alreadyExists", status(409, "alreadyExists"), { reason: "conflict", retryable: false }],
      [
        "ZONE_RESOURCE_POOL_EXHAUSTED",
        operation("ZONE_RESOURCE_POOL_EXHAUSTED"),
        { reason: "capacity", retryable: true, retryAfterMs: 60_000 },
      ],
      [
        "ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS",
        operation("ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS"),
        { reason: "capacity", retryable: true, retryAfterMs: 60_000 },
      ],
      ["503", status(503), { reason: "capacity", retryable: true, retryAfterMs: 60_000 }],
      ["QUOTA_EXCEEDED", operation("QUOTA_EXCEEDED", 403), { reason: "quota", retryable: false }],
      ["403 quotaExceeded", status(403, "quotaExceeded"), { reason: "quota", retryable: false }],
      ["429", status(429), { reason: "rate-limited", retryable: true, retryAfterMs: 5_000 }],
      [
        "429 with Retry-After",
        status(429, undefined, 7_000),
        { reason: "rate-limited", retryable: true, retryAfterMs: 7_000 },
      ],
      [
        "403 rateLimitExceeded",
        status(403, "rateLimitExceeded"),
        { reason: "rate-limited", retryable: true, retryAfterMs: 5_000 },
      ],
      ["401", status(401), { reason: "auth", retryable: false }],
      ["403 forbidden", status(403, "forbidden"), { reason: "auth", retryable: false }],
      ["400", status(400, "invalid"), { reason: "invalid-request", retryable: false }],
      ["500", status(500, "backendError"), { reason: "unavailable", retryable: true }],
      [
        "a network error",
        new GceApiError({ endpoint: "GET /zones/{zone}/instances", failure: "transport" }),
        { reason: "unavailable", retryable: true },
      ],
    ];
    it.each(rows)("%s", (_name, error, expected) => {
      const mapped = mapGceError(error, { driverId: DRIVER_ID, operation: "create" });
      assert.deepStrictEqual(
        { reason: mapped.reason, retryable: mapped.retryable, retryAfterMs: mapped.retryAfterMs },
        { retryAfterMs: undefined, ...expected },
      );
      if (expected.reason === "quota" || expected.reason === "auth") {
        assert.isDefined(mapped.setupHint);
      }
      assert.strictEqual(mapped.backendStatus, error.status);
    });
  });

  describe("replays", () => {
    it.effect("a create into one machine", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* setup();
        const first = yield* driver.create(createInput());
        const second = yield* driver.create(createInput());
        assert.strictEqual(second.driverRef, first.driverRef);
        assert.strictEqual(countOf(fake, "instances.insert"), 1);
        assert.strictEqual(fake.instancesNamed(NAME).length, 1);
      }),
    );

    it.effect("a create that crashed between the insert and its wait", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* setup();
        fake.failNext(
          "waitZoneOperation",
          new GceApiError({ endpoint: "wait", failure: "transport" }),
        );
        const error = yield* Effect.flip(driver.create(createInput()));
        assert.strictEqual(error.reason, "unavailable");
        assert.strictEqual(error.retryable, true);

        const replay = yield* driver.create(createInput());
        assert.strictEqual(replay.driverRef, NAME);
        assert.strictEqual(countOf(fake, "instances.insert"), 1);
      }),
    );

    it.effect("a start of a running generation without a restart, and the next with one", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* setup();
        yield* driver.create(createInput());

        yield* driver.start(NAME, bootstrap(1));
        assert.strictEqual(countOf(fake, "instances.stop"), 0);
        assert.strictEqual(countOf(fake, "instances.start"), 0);

        yield* driver.start(NAME, bootstrap(2));
        yield* driver.start(NAME, bootstrap(2));
        assert.strictEqual(countOf(fake, "instances.stop"), 1);
        assert.strictEqual(countOf(fake, "instances.start"), 1);
        const instance = fake.instance(ZONE_A, NAME);
        assert.strictEqual(instance?.status, "RUNNING");
        assert.strictEqual(metadataOf(instance, "pair-generation"), "2");
        assert.strictEqual(metadataOf(instance, "pair-bootstrap"), vmBootstrapText(bootstrap(2))!);
        assert.strictEqual(metadataOf(instance, "block-project-ssh-keys"), "TRUE");
      }),
    );

    it.effect("a stop and a destroy", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* setup();
        yield* driver.create(createInput());
        yield* driver.stop(NAME);
        yield* driver.stop(NAME);
        assert.strictEqual(countOf(fake, "instances.stop"), 1);
        assert.strictEqual((yield* driver.status(NAME)).status, "stopped");
        yield* driver.destroy(NAME);
        yield* driver.destroy(NAME);
        assert.strictEqual(countOf(fake, "instances.delete"), 1);
        assert.strictEqual((yield* driver.status(NAME)).status, "missing");
      }),
    );

    it.effect("a destroy of a machine this install did not make", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* setup();
        yield* fake.putInstance({
          zone: ZONE_A,
          name: NAME,
          labels: { "pair-install": "someone-else", "pair-sandbox": SANDBOX },
        });
        const error = yield* Effect.flip(driver.destroy(NAME));
        assert.strictEqual(error.reason, "invalid-request");
        assert.strictEqual(countOf(fake, "instances.delete"), 0);
      }),
    );

    it.effect("a snapshot, also while its image is pending", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* setup();
        yield* driver.create(createInput());
        fake.hold("images.insert");
        yield* Queue.clear(fake.waits);
        const first = yield* driver
          .snapshot(NAME, "t3-team-image:7")
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Queue.take(fake.waits);
        yield* TestClock.adjust("50 seconds");
        const timedOut = yield* Fiber.join(first);
        assert.strictEqual(timedOut.reason, "unavailable");
        assert.strictEqual(timedOut.retryAfterMs, 5_000);
        assert.strictEqual(fake.image("pair-3f2a9c1e-team-image-7")?.status, "PENDING");

        const replay = yield* driver
          .snapshot(NAME, "t3-team-image:7")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* fake.release("images.insert");
        yield* TestClock.adjust("5 seconds");
        const image = yield* Fiber.join(replay);
        const again = yield* driver.snapshot(NAME, "t3-team-image:7");
        assert.deepStrictEqual(again, image);
        assert.strictEqual(image.imageRef, fake.image("pair-3f2a9c1e-team-image-7")?.selfLink);
        assert.strictEqual(countOf(fake, "images.insert"), 1);
        assert.deepStrictEqual(fake.image("pair-3f2a9c1e-team-image-7")?.labels, {
          "pair-install": INSTALL,
          "pair-team-image-build": "7",
          "pair-team-image-machine": NAME,
        });
        // A capture needs a stopped disk.
        assert.strictEqual(fake.instance(ZONE_A, NAME)?.status, "TERMINATED");

        yield* driver.deleteImage(image.imageRef);
        yield* driver.deleteImage(image.imageRef);
        assert.strictEqual(fake.image("pair-3f2a9c1e-team-image-7"), null);
      }),
    );
  });

  describe("zones", () => {
    it.effect("a create with no capacity in the first zone lands in the second", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* setup({ zones: [ZONE_A, ZONE_B] });
        fake.setCapacity(ZONE_A, false);
        const { driverRef } = yield* driver.create(createInput());
        assert.deepStrictEqual(
          fake.instancesNamed(driverRef).map((instance) => instance.zone),
          [ZONE_B],
        );
        assert.strictEqual(countOf(fake, "instances.insert"), 2);
        assert.strictEqual((yield* driver.status(driverRef)).status, "running");
      }),
    );

    it.effect("a create with no capacity anywhere fails capacity", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* setup({ zones: [ZONE_A, ZONE_B] });
        fake.setCapacity(ZONE_A, false);
        fake.setCapacity(ZONE_B, false);
        const error = yield* Effect.flip(driver.create(createInput()));
        assert.strictEqual(error.reason, "capacity");
        assert.strictEqual(error.retryAfterMs, 60_000);
        assert.deepStrictEqual(fake.instancesNamed(NAME), []);
      }),
    );

    const stoppedWithMarker = Effect.fn("GceComputeDriverTest.stoppedWithMarker")(function* (
      zones: ReadonlyArray<string>,
    ) {
      const context = yield* setup({ zones });
      yield* context.driver.create(createInput());
      context.fake.instance(ZONE_A, NAME)!.disk.marker = "g1";
      yield* context.driver.stop(NAME);
      context.fake.setCapacity(ZONE_A, false);
      return context;
    });

    it.effect("a start with no capacity waits, then moves after three minutes", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* stoppedWithMarker([ZONE_A, ZONE_B]);

        const waiting = yield* Effect.flip(driver.start(NAME, bootstrap(2)));
        assert.strictEqual(waiting.reason, "capacity");
        assert.strictEqual(waiting.retryable, true);
        assert.strictEqual(waiting.retryAfterMs, 60_000);
        assert.strictEqual(fake.instance(ZONE_A, NAME)?.labels?.["pair-capacity-since"], "0");

        yield* TestClock.adjust("120 seconds");
        yield* Effect.flip(driver.start(NAME, bootstrap(2)));
        assert.strictEqual(fake.instancesNamed(NAME)[0]?.zone, ZONE_A);

        yield* TestClock.adjust("60 seconds");
        yield* driver.start(NAME, bootstrap(2));
        const moved = fake.instancesNamed(NAME);
        assert.deepStrictEqual(
          moved.map((instance) => [instance.zone, instance.status]),
          [[ZONE_B, "RUNNING"]],
        );
        const instance = fake.instance(ZONE_B, NAME);
        assert.strictEqual(instance?.disk.marker, "g1");
        assert.deepStrictEqual(instance?.labels, {
          "pair-install": INSTALL,
          "pair-sandbox": SANDBOX,
          "pair-generation": "1",
          "pair-driver": DRIVER_ID,
        });
        assert.strictEqual(metadataOf(instance, "pair-generation"), "2");
        assert.strictEqual(instance?.machineType, `zones/${ZONE_B}/machineTypes/e2-standard-2`);
        assert.strictEqual(fake.snapshot(`${NAME}-move`), null);
        assert.strictEqual((yield* driver.status(NAME)).status, "running");
      }),
    );

    it.effect("a move that crashed after the delete resumes at the insert", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* stoppedWithMarker([ZONE_A, ZONE_B]);
        yield* Effect.flip(driver.start(NAME, bootstrap(2)));
        yield* TestClock.adjust("180 seconds");
        fake.failNext(
          "instances.insert",
          new GceApiError({ endpoint: "insert", failure: "transport" }),
        );

        const crashed = yield* Effect.flip(driver.start(NAME, bootstrap(2)));
        assert.strictEqual(crashed.reason, "unavailable");
        assert.deepStrictEqual(fake.instancesNamed(NAME), []);
        assert.strictEqual(fake.snapshot(`${NAME}-move`)?.status, "READY");

        yield* driver.start(NAME, bootstrap(2));
        assert.strictEqual(fake.instance(ZONE_B, NAME)?.disk.marker, "g1");
        assert.strictEqual(fake.snapshot(`${NAME}-move`), null);
      }),
    );

    it.effect("a start with one zone keeps failing capacity", () =>
      Effect.gen(function* () {
        const { fake, driver } = yield* stoppedWithMarker([ZONE_A]);
        yield* Effect.flip(driver.start(NAME, bootstrap(2)));
        yield* TestClock.adjust("600 seconds");
        const error = yield* Effect.flip(driver.start(NAME, bootstrap(2)));
        assert.strictEqual(error.reason, "capacity");
        assert.strictEqual(countOf(fake, "disks.createSnapshot"), 0);

        fake.setCapacity(ZONE_A, true);
        yield* driver.start(NAME, bootstrap(2));
        const instance = fake.instance(ZONE_A, NAME);
        assert.strictEqual(instance?.status, "RUNNING");
        assert.isUndefined(instance?.labels?.["pair-capacity-since"]);
      }),
    );
  });

  it.effect("lists only this install's sandboxes, every page, never the base builder", () =>
    Effect.gen(function* () {
      const { fake, driver } = yield* setup({ pageSize: 1 });
      yield* driver.create(createInput());
      yield* driver.create(createInput(1, {}, OTHER_SANDBOX));
      yield* fake.putInstance({
        zone: ZONE_A,
        name: "pair-3f2a9c1e-basebuild-0a1b2c3d4e5f",
        labels: { "pair-install": INSTALL },
      });
      yield* fake.putInstance({
        zone: ZONE_A,
        name: "pair-99999999-sbx-0123456789abcdef0123-g1",
        labels: { "pair-install": "another-install", "pair-sandbox": SANDBOX },
      });

      const listed = yield* driver.list({ "pair.install": INSTALL });
      assert.deepStrictEqual(
        listed.map((sandbox) => `${sandbox.sandboxId} ${sandbox.status}`).toSorted(),
        [`${OTHER_SANDBOX} running`, `${SANDBOX} running`].toSorted(),
      );
      assert.deepStrictEqual(
        (yield* driver.list({ "pair.sandbox": SANDBOX })).map((sandbox) => sandbox.driverRef),
        [NAME],
      );
      assert.deepStrictEqual(yield* driver.list({ "pair.install": "another-install" }), []);
    }),
  );

  it.effect("ends a slow stop at 50 seconds, and the replay returns once it is done", () =>
    Effect.gen(function* () {
      const { fake, driver } = yield* setup();
      yield* driver.create(createInput());
      fake.hold("instances.stop");
      yield* Queue.clear(fake.waits);

      const fiber = yield* driver
        .stop(NAME)
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      yield* Queue.take(fake.waits);
      yield* TestClock.adjust("50 seconds");
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error.reason, "unavailable");
      assert.strictEqual(error.retryable, true);
      assert.strictEqual(error.retryAfterMs, 5_000);
      assert.strictEqual((yield* driver.status(NAME)).status, "running");

      yield* fake.release("instances.stop");
      yield* driver.stop(NAME);
      assert.strictEqual(countOf(fake, "instances.stop"), 1);
      assert.strictEqual((yield* driver.status(NAME)).status, "stopped");
    }),
  );
});
