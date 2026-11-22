// @effect-diagnostics nodeBuiltinImport:off - the delivery command runs in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  type Agent37SandboxDriver,
  ComputeDriverId,
  EnvironmentId,
  SandboxId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import { TestClock } from "effect/testing";

import * as Agent37ApiFake from "./Agent37ApiTesting.ts";
import { agent37BaseTemplateName, deliveryCommand, makeWithApi } from "./Agent37ComputeDriver.ts";
import {
  type ComputeDriverCreateInput,
  type ComputeDriverError,
  type SandboxBootstrap,
  sandboxBackendName,
  sandboxTags,
} from "./ComputeDriver.ts";
import { vmBootstrapText } from "./vmHelpers.ts";

const INSTALL = EnvironmentId.make("3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f");
const SANDBOX = SandboxId.make("sbx_0123456789abcdef0123");
const OTHER_SANDBOX = SandboxId.make("sbx_fedcba9876543210fedc");
const DRIVER_ID = ComputeDriverId.make("agent37-test");
const IMAGE = "ghcr.io/rutvikchandla3/t3-sandbox:1.2.3";
const BASE = agent37BaseTemplateName(INSTALL, IMAGE);
const SECRET = "enroll-secret-value";
const NAME = sandboxBackendName(INSTALL, SANDBOX, 1);
const OTHER = sandboxBackendName(INSTALL, OTHER_SANDBOX, 1);

const config: Agent37SandboxDriver = {
  kind: "agent37",
  id: DRIVER_ID,
  label: "Agent37",
  apiKey: "sk_live_test",
  runnerUrl: "https://pair.example.test",
};

const setup = Effect.fn("Agent37ComputeDriverTest.setup")(function* (
  options: {
    readonly config?: Partial<Agent37SandboxDriver>;
    readonly cloudOnly?: boolean;
    readonly createStatus?: string;
    readonly unpullable?: ReadonlyArray<string>;
    readonly onRequest?: (request: Agent37ApiFake.FakeAgent37Request) => Effect.Effect<void>;
    /** Runs before the driver is built, so its first registration sees it. */
    readonly seed?: (fake: Agent37ApiFake.Agent37ApiFake) => void;
  } = {},
) {
  const fake = yield* Agent37ApiFake.make({
    ...(options.createStatus === undefined ? {} : { createStatus: options.createStatus }),
    ...(options.unpullable === undefined ? {} : { unpullable: options.unpullable }),
    ...(options.onRequest === undefined ? {} : { onRequest: options.onRequest }),
  });
  options.seed?.(fake);
  const driver = yield* makeWithApi({ ...config, ...options.config }, INSTALL, fake.api(), {
    cloudOnly: options.cloudOnly ?? true,
    version: "1.2.3",
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

const bodies = (fake: Agent37ApiFake.Agent37ApiFake, method: string, path: RegExp) =>
  fake.requests
    .filter((request) => request.method === method && path.test(request.path))
    .map((request) => request.body);

const failureOf = (error: ComputeDriverError) => ({
  reason: error.reason,
  retryable: error.retryable,
  retryAfterMs: error.retryAfterMs,
});

describe("Agent37ComputeDriver", () => {
  it.effect("imports the base image once and hands the secret only to a root exec", () =>
    Effect.gen(function* () {
      const { fake, driver } = yield* setup();
      const input = createInput();

      const result = yield* driver.create(input);
      assert.deepStrictEqual(result, {
        driverRef: NAME,
        baseImage: { ref: IMAGE, digest: fake.template(BASE)!.imageDigest!, version: "1.2.3" },
      });
      yield* driver.stop(NAME);
      yield* driver.start(NAME, bootstrap(2));
      yield* driver.create(createInput(1, OTHER_SANDBOX));

      const [template] = bodies(fake, "POST", /^\/templates$/) as Array<Record<string, unknown>>;
      assert.strictEqual(fake.count("POST /templates"), 1);
      assert.strictEqual(template?.image_ref, IMAGE);
      assert.isDefined(template);
      assert.deepStrictEqual((template.entrypoint as Array<string>).slice(0, 5), [
        "/usr/bin/tini",
        "-g",
        "--",
        "/bin/sh",
        "-c",
      ]);
      assert.deepStrictEqual(bodies(fake, "POST", /^\/instances$/)[0], {
        template: BASE,
        type: "default",
        region: "us",
        resources: { cpu: 2, memory: 4, disk: 12 },
        name: NAME,
        metadata: input.tags,
        mount_path: "/t3-sandbox",
        auto_sleep: false,
      });
      assert.deepStrictEqual(bodies(fake, "POST", /\/exec$/).slice(0, 2), [
        { command: deliveryCommand(1, vmBootstrapText(bootstrap(1))!), user: "root" },
        { command: deliveryCommand(2, vmBootstrapText(bootstrap(2))!), user: "root" },
      ]);
      for (const request of fake.requests) {
        const text = JSON.stringify(request);
        assert.notInclude(text, SECRET, `${request.method} ${request.path}`);
        if (!request.path.endsWith("/exec")) {
          assert.notInclude(text, "PAIR_RUNNER_ENROLL", `${request.method} ${request.path}`);
        }
      }
    }),
  );

  it.effect("ends a create its instance outlives, and the replay delivers to the same one", () =>
    Effect.gen(function* () {
      let slow = true;
      let fake: Agent37ApiFake.Agent37ApiFake | undefined;
      const context = yield* setup({
        createStatus: "provisioning",
        // A provisioning instance that the clock passes by, then one that runs.
        onRequest: (request) => {
          const id = /^\/instances\/([a-z0-9]+)$/.exec(request.path)?.[1];
          if (!slow || request.method !== "GET" || id === undefined) return Effect.void;
          return Effect.sync(() => {
            fake!.instance(id)!.held = true;
          }).pipe(Effect.andThen(TestClock.adjust("45 seconds")));
        },
      });
      fake = context.fake;

      const error = yield* Effect.flip(context.driver.create(createInput()));
      assert.deepStrictEqual(failureOf(error), {
        reason: "unavailable",
        retryable: true,
        retryAfterMs: 5_000,
      });
      assert.strictEqual(fake.count("POST /instances/{id}/exec"), 0);

      slow = false;
      fake.instance(NAME)!.held = false;
      yield* context.driver.create(createInput());
      assert.strictEqual(fake.count("POST /instances"), 1);
      assert.strictEqual(fake.count("POST /instances/{id}/exec"), 1);
    }),
  );

  it.effect("keeps the oldest of a name and deletes the copies a cut-short create left", () =>
    Effect.gen(function* () {
      const input = createInput();
      const { fake, driver } = yield* setup();
      const oldest = fake.putInstance({ name: NAME, metadata: input.tags });
      const copy = fake.putInstance({ name: NAME, metadata: input.tags });

      assert.strictEqual((yield* driver.create(input)).driverRef, NAME);
      assert.strictEqual(fake.count("POST /instances"), 0);
      assert.deepStrictEqual(
        fake.instances().map((instance) => instance.id),
        [oldest.id],
      );
      assert.strictEqual(fake.instance(oldest.id)?.generation, "1");
      assert.isUndefined(fake.instance(copy.id));
    }),
  );

  describe("starts", () => {
    const rows: ReadonlyArray<
      readonly [
        string,
        {
          readonly status?: string;
          readonly startFails?: Agent37ApiFake.FakeAgent37Failure;
        },
        (
          | { readonly started: boolean }
          | (Pick<ComputeDriverError, "reason" | "retryable" | "retryAfterMs"> & {
              readonly hint?: boolean;
            })
        ),
      ]
    > = [
      ["a stopped instance", { status: "stopped" }, { started: true }],
      ["a sleeping instance", { status: "sleeping" }, { started: true }],
      ["a failed instance", { status: "failed" }, { started: true }],
      ["a running instance, delivering only", { status: "running" }, { started: false }],
      [
        "a stopping instance as not yet",
        { status: "stopping" },
        { reason: "unavailable", retryable: true, retryAfterMs: 5_000 },
      ],
      ["a missing instance as not-found", {}, { reason: "not-found", retryable: false }],
      [
        "an empty wallet as retryable, fast and with its hint",
        { status: "stopped", startFails: { status: 402, code: "insufficient_balance" } },
        { reason: "quota", retryable: true, retryAfterMs: 5_000, hint: true },
      ],
      [
        "the memory limit as retryable within a minute, with its hint",
        { status: "stopped", startFails: { status: 409, code: "instance_limit_reached" } },
        { reason: "quota", retryable: true, retryAfterMs: 60_000, hint: true },
      ],
    ];
    it.effect.each(rows)("%s", ([_name, given, expected]) =>
      Effect.gen(function* () {
        const { fake, driver } = yield* setup();
        if (given.status !== undefined) {
          fake.putInstance({ name: NAME, metadata: createInput().tags, status: given.status });
        }
        if (given.startFails !== undefined) {
          fake.failNext("POST /instances/{id}/start", given.startFails);
        }
        const started = yield* Effect.result(driver.start(NAME, bootstrap(2)));
        if ("started" in expected) {
          assert.strictEqual(started._tag, "Success");
          assert.strictEqual(fake.count("POST /instances/{id}/start"), expected.started ? 1 : 0);
          assert.strictEqual(fake.instance(NAME)?.generation, "2");
          return;
        }
        assert.strictEqual(started._tag, "Failure");
        if (started._tag !== "Failure") return;
        const { hint, ...rest } = expected;
        assert.deepStrictEqual(failureOf(started.failure), { retryAfterMs: undefined, ...rest });
        assert.strictEqual(started.failure.setupHint !== undefined, hint === true);
        assert.strictEqual(fake.count("POST /instances/{id}/exec"), 0);
      }),
    );
  });

  it.effect("stops a running instance, and makes no call for one that runs nothing", () =>
    Effect.gen(function* () {
      const { fake, driver } = yield* setup();
      yield* driver.create(createInput());
      yield* driver.stop(NAME);
      assert.strictEqual((yield* driver.status(NAME)).status, "stopped");
      yield* driver.stop(NAME);
      for (const status of ["sleeping", "failed"]) {
        fake.instance(NAME)!.status = status;
        yield* driver.stop(NAME);
      }
      assert.strictEqual(fake.count("POST /instances/{id}/stop"), 1);
    }),
  );

  it.effect("forks a team image once, never over another machine's, and boots from it", () =>
    Effect.gen(function* () {
      const { fake, driver } = yield* setup();
      yield* driver.create({ ...createInput(), size: "default" });
      yield* driver.create(createInput(1, OTHER_SANDBOX));

      const image = yield* driver.snapshot(NAME, "t3-team-image:3");
      assert.deepStrictEqual(image, { imageRef: "pair-3f2a9c1e-team-image-3", sizeBytes: null });
      assert.deepStrictEqual(yield* driver.snapshot(NAME, "t3-team-image:3"), image);
      assert.strictEqual(fake.instance(image.imageRef)?.status, "stopped");
      assert.strictEqual(fake.count("POST /instances/{id}/fork"), 1);
      const conflict = yield* Effect.flip(driver.snapshot(OTHER, "t3-team-image:3"));
      assert.strictEqual(conflict.reason, "conflict");

      assert.strictEqual(
        yield* driver.readImageFile(image.imageRef, "/etc/t3/build.json"),
        "whole-disk",
      );
      assert.isNull(
        yield* driver.readImageFile("pair-3f2a9c1e-team-image-9", "/etc/t3/build.json"),
      );
      // A team image is never one of the machines.
      assert.deepStrictEqual(
        (yield* driver.list({ "pair.install": INSTALL }))
          .map((sandbox) => sandbox.driverRef)
          .toSorted(),
        [NAME, OTHER].toSorted(),
      );

      // Small asks for 12 GB; a fork of the 20 GB image needs all of it.
      const fromImage = {
        ...createInput(1, SandboxId.make("sbx_aaaaaaaaaaaaaaaaaaaa")),
        image: { type: "build", imageRef: image.imageRef },
      } satisfies ComputeDriverCreateInput;
      yield* driver.create(fromImage);
      const fork = bodies(fake, "POST", /\/fork$/).at(-1) as Record<string, unknown>;
      assert.deepStrictEqual(fork.resources, { cpu: 2, memory: 4, disk: 20 });
      assert.deepStrictEqual(fork.metadata, fromImage.tags);
      assert.strictEqual(fake.instance(fromImage.name)?.generation, "1");

      yield* driver.deleteImage("their-image");
      yield* driver.deleteImage(image.imageRef);
      assert.isUndefined(fake.instance(image.imageRef));
    }),
  );

  it.effect("deletes this install's older base templates before it reports the new one", () =>
    Effect.gen(function* () {
      const { fake, driver } = yield* setup({
        seed: (fake) => {
          fake.addTemplate({ name: "pair-3f2a9c1e-base-000000000000", imageRef: "old" });
          fake.addTemplate({ name: "pair-99999999-base-000000000000", imageRef: "theirs" });
        },
      });
      yield* driver.create(createInput());
      assert.deepStrictEqual(
        ["pair-3f2a9c1e-base-000000000000", "pair-99999999-base-000000000000", BASE].map(
          (name) => fake.template(name) !== undefined,
        ),
        [false, true, true],
      );
    }),
  );

  it.effect("fails creates for good when Agent37 cannot import the image, and says why", () =>
    Effect.gen(function* () {
      const { fake, driver } = yield* setup({ unpullable: [IMAGE] });
      const health = yield* driver.health;
      assert.deepInclude(health.baseImage as object, { missing: IMAGE });
      assert.include((health.baseImage as { readonly hint: string }).hint, "linux/amd64");
      const error = yield* Effect.flip(driver.create(createInput()));
      assert.deepStrictEqual(
        { ...failureOf(error), image: error.image?.state },
        { reason: "not-found", retryable: false, retryAfterMs: undefined, image: "missing" },
      );
      assert.strictEqual(fake.count("POST /instances"), 0);
    }),
  );

  it.effect("reports a slow import as under way, and leaves another image's template alone", () =>
    Effect.gen(function* () {
      const posted = yield* Deferred.make<void>();
      const never = yield* Deferred.make<void>();
      const slow = yield* setup({
        onRequest: (request) =>
          request.method === "POST" && request.path === "/templates"
            ? Deferred.succeed(posted, undefined).pipe(Effect.andThen(Deferred.await(never)))
            : Effect.void,
      });
      const health = yield* Effect.forkChild(slow.driver.health);
      yield* Deferred.await(posted);
      yield* TestClock.adjust("5 seconds");
      assert.deepStrictEqual((yield* Fiber.join(health)).baseImage, { pulling: IMAGE });
      const error = yield* Effect.flip(slow.driver.create(createInput()));
      assert.deepStrictEqual(
        { ...failureOf(error), image: error.image?.state },
        { reason: "unavailable", retryable: true, retryAfterMs: undefined, image: "pulling" },
      );

      const taken = yield* setup({
        seed: (fake) => fake.addTemplate({ name: BASE, imageRef: "ghcr.io/acme/other:1" }),
      });
      const conflict = yield* taken.driver.health;
      assert.include((conflict.baseImage as { readonly hint: string }).hint, BASE);
      assert.strictEqual(taken.fake.count("POST /templates"), 0);
      assert.strictEqual(taken.fake.template(BASE)?.imageRef, "ghcr.io/acme/other:1");
    }),
  );

  it.effect("asks for a key, an https runner URL and a VM outside the US before calling", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [Partial<Agent37SandboxDriver>, string, string]> = [
        [
          { apiKey: "", runnerUrl: "http://pair.example.test" },
          "auth",
          "Paste an Agent37 API key.",
        ],
        [{ runnerUrl: "http://pair.example.test" }, "invalid-request", "https://"],
        [{ region: "eu" }, "invalid-request", "VM"],
      ];
      for (const [given, reason, hint] of cases) {
        const { fake, driver } = yield* setup({ config: given });
        // Registration runs on its own; nothing here may reach an instance or the wallet.
        const error = yield* Effect.flip(driver.health);
        assert.strictEqual(error.reason, reason);
        assert.include(error.setupHint, hint);
        assert.strictEqual(
          (yield* Effect.flip(driver.create(createInput()))).reason,
          "invalid-request",
        );
        assert.strictEqual(fake.count("GET /billing"), 0);
        assert.strictEqual(fake.count("POST /instances"), 0);
      }
      const vm = yield* setup({ config: { region: "eu", instanceType: "vm" } });
      assert.strictEqual((yield* vm.driver.health).isolation, "vm");
      yield* vm.driver.create(createInput());
      assert.deepInclude(bodies(vm.fake, "POST", /^\/instances$/)[0] as object, {
        type: "vm",
        region: "eu",
      });

      const pastDue = yield* setup();
      pastDue.fake.billing.pastDue = true;
      const wallet = yield* Effect.flip(pastDue.driver.health);
      assert.strictEqual(wallet.reason, "quota");
      assert.include(wallet.setupHint, "wallet");
    }),
  );

  it.effect("refuses everything off a cloud-only server, without a call", () =>
    Effect.gen(function* () {
      const { fake, driver } = yield* setup({ cloudOnly: false });
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

  it.effect("lists this install's machines once per name, by Agent37's status", () =>
    Effect.gen(function* () {
      const { fake, driver } = yield* setup();
      const tags = createInput().tags;
      fake.putInstance({ name: NAME, metadata: tags, status: "sleeping" });
      fake.putInstance({ name: NAME, metadata: tags, status: "running" });
      fake.putInstance({
        name: OTHER,
        metadata: createInput(1, OTHER_SANDBOX).tags,
        status: "provisioning",
      });
      fake.putInstance({
        name: "theirs",
        metadata: { ...tags, "pair.install": "another-install" },
      });
      fake.putInstance({
        name: "pair-3f2a9c1e-team-image-1",
        metadata: { "pair.install": INSTALL },
      });
      fake.putInstance({ name: "untagged", metadata: { "pair.install": 7 } });

      const listed = yield* driver.list({ "pair.install": INSTALL });
      assert.deepStrictEqual(
        listed.map((sandbox) => `${sandbox.sandboxId} ${sandbox.status}`).toSorted(),
        [`${SANDBOX} stopped`, `${OTHER_SANDBOX} starting`].toSorted(),
      );
      assert.deepStrictEqual(yield* driver.list({ "pair.install": "another-install" }), []);
    }),
  );
});

describe("deliveryCommand", () => {
  /** Runs it as `sh` would on the machine, with its two directories under `root`. */
  const run = (root: string, generation: number, text: string) => {
    const command = deliveryCommand(generation, text)
      .replaceAll("/etc/pair-runner", `${root}/etc`)
      .replaceAll("/run/pair-runner", `${root}/run`);
    return NodeChildProcess.spawnSync("sh", ["-c", command], { encoding: "utf8" });
  };

  it.live("writes the bootstrap as given, and keeps a runner of its generation that enrolled", () =>
    Effect.sync(() => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pair-agent37-"));
      try {
        const text = vmBootstrapText({
          ...bootstrap(3),
          enrollmentSecret: Redacted.make(`it's "quoted" $HOME \`x\``),
        })!;
        assert.strictEqual(run(root, 3, text).status, 0);
        assert.strictEqual(NodeFS.readFileSync(`${root}/etc/bootstrap.env`, "utf8"), text);
        assert.strictEqual(NodeFS.readFileSync(`${root}/etc/generation`, "utf8"), "3\n");
        assert.strictEqual(NodeFS.statSync(`${root}/etc`).mode & 0o777, 0o700);
        assert.strictEqual(NodeFS.statSync(`${root}/etc/bootstrap.env`).mode & 0o777, 0o600);
        assert.strictEqual(NodeFS.statSync(`${root}/etc/generation`).mode & 0o777, 0o644);

        // The runner read and deleted it, then enrolled.
        NodeFS.rmSync(`${root}/etc/bootstrap.env`);
        NodeFS.mkdirSync(`${root}/run`);
        NodeFS.writeFileSync(`${root}/run/token`, "token");
        assert.strictEqual(run(root, 3, vmBootstrapText(bootstrap(3))!).status, 0);
        assert.isFalse(NodeFS.existsSync(`${root}/etc/bootstrap.env`));
        // A new generation always gets its bootstrap.
        assert.strictEqual(run(root, 4, vmBootstrapText(bootstrap(4))!).status, 0);
        assert.strictEqual(NodeFS.readFileSync(`${root}/etc/generation`, "utf8"), "4\n");
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
  );
});
