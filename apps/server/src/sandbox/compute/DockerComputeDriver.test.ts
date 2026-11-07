import { assert, describe, it } from "@effect/vitest";
import { ComputeDriverId, EnvironmentId, SandboxId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { ServerSettingsService } from "../../serverSettings.ts";
import { type ComputeDriverError, sandboxBackendName, sandboxTags } from "./ComputeDriver.ts";
import {
  containerCreateBody,
  egressScript,
  isolationFromInfo,
  makeWithEngine,
} from "./DockerComputeDriver.ts";
import {
  DockerEngineError,
  makeDockerEngine,
  mapEngineError,
  parseDockerHost,
  readFirstTarFile,
  ustar,
} from "./DockerEngineApi.ts";

const driverId = ComputeDriverId.make("local");
const sandboxId = SandboxId.make("sbx_0123456789abcdef0123");
const installId = EnvironmentId.make("abcd1234-0000-4000-8000-000000000000");

describe("containerCreateBody", () => {
  const body = (local: Parameters<typeof containerCreateBody>[0]["local"], runtime = "runc") =>
    containerCreateBody({
      image: "t3-sandbox:dev",
      labels: { "pair.sandbox": sandboxId },
      sandboxId,
      volume: "pair-vol",
      network: "net",
      limits: { nanoCpus: 2e9, memoryBytes: 4 * 2 ** 30 },
      runtime: runtime as "runc" | "runsc",
      local,
    });

  it("keeps every bind off a remote daemon and never mounts the Docker socket", () => {
    const remote = body(Option.none());
    assert.deepStrictEqual(remote.HostConfig.Mounts, [
      { Type: "volume", Source: "pair-vol", Target: `/t3-sandbox/${sandboxId}` },
    ]);
    const local = body(
      Option.some({
        serverSocketDir: "/srv/t3/runner",
        bundle: Option.some({ runnerBuildId: "b1", path: "/srv/t3/bundles/b1" }),
      }),
      "runsc",
    );
    assert.deepStrictEqual(local.HostConfig.Mounts.slice(1), [
      { Type: "bind", Source: "/srv/t3/runner", Target: "/run/pair-server" },
      { Type: "bind", Source: "/srv/t3/bundles/b1", Target: "/opt/pair-runner/b1", ReadOnly: true },
    ]);
    for (const config of [remote, local]) {
      assert.isFalse(JSON.stringify(config).includes("docker.sock"));
      assert.deepStrictEqual(config.Env, []);
      assert.strictEqual(config.HostConfig.Privileged, false);
      assert.deepStrictEqual(config.HostConfig.CapDrop, ["NET_RAW", "MKNOD"]);
      assert.strictEqual(config.HostConfig.MemorySwap, config.HostConfig.Memory);
    }
    assert.strictEqual(local.HostConfig.Runtime, "runsc");
  });
});

describe("parseDockerHost", () => {
  it.each([
    {
      name: "the default sockets",
      value: undefined,
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      expected: {
        _tag: "Unix",
        socketPaths: [
          "/run/user/1000/docker.sock",
          "/home/me/.docker/run/docker.sock",
          "/var/run/docker.sock",
        ],
      },
    },
    {
      name: "DOCKER_HOST unix://",
      value: undefined,
      env: { DOCKER_HOST: "unix:///srv/docker.sock" },
      expected: { _tag: "Unix", socketPaths: ["/srv/docker.sock"] },
    },
    {
      name: "tcp://",
      value: "tcp://build.lan:2375",
      env: {},
      expected: { _tag: "Tcp", origin: "http://build.lan:2375", tls: null },
    },
    {
      name: "tcp:// with TLS",
      value: "tcp://build.lan",
      env: { DOCKER_TLS_VERIFY: "1", DOCKER_CERT_PATH: "/certs" },
      expected: { _tag: "Tcp", origin: "https://build.lan:2376", tls: { certPath: "/certs" } },
    },
    {
      name: "ssh:// as unsupported",
      value: "ssh://me@build.lan",
      env: {},
      expected: { _tag: "Unsupported", scheme: "ssh" },
    },
  ] as const)("parses $name", ({ value, env, expected }) => {
    assert.deepStrictEqual(parseDockerHost(value, env, "/home/me"), expected);
  });
});

describe("mapEngineError", () => {
  const cases: ReadonlyArray<{
    readonly error: DockerEngineError;
    readonly reason: ComputeDriverError["reason"];
    readonly retryable: boolean;
  }> = [
    {
      error: new DockerEngineError({
        endpoint: "GET /info",
        failure: "transport",
        socketCode: "ENOENT",
      }),
      reason: "unavailable",
      retryable: true,
    },
    {
      error: new DockerEngineError({
        endpoint: "GET /info",
        failure: "transport",
        socketCode: "EACCES",
      }),
      reason: "auth",
      retryable: false,
    },
    ...(
      [
        [400, "invalid-request", false],
        [404, "not-found", false],
        [409, "conflict", false],
        [500, "unavailable", true],
      ] as const
    ).map(([status, reason, retryable]) => ({
      error: new DockerEngineError({ endpoint: "x", failure: "status", status }),
      reason,
      retryable,
    })),
    {
      error: new DockerEngineError({
        endpoint: "POST /containers/create",
        failure: "status",
        status: 500,
        cause: new Error("write /var/lib/docker: no space left on device"),
      }),
      reason: "capacity",
      retryable: false,
    },
  ];
  it.each(cases)("maps to $reason", ({ error, reason, retryable }) => {
    const mapped = mapEngineError(error, { driverId, operation: "create" });
    assert.deepStrictEqual([mapped.reason, mapped.retryable], [reason, retryable]);
  });
});

it("prefers gVisor, then rootless, then plain containers", () => {
  assert.deepStrictEqual(isolationFromInfo({ Runtimes: { runc: {}, runsc: {} } }), {
    isolation: "gvisor",
    runtime: "runsc",
  });
  assert.deepStrictEqual(
    isolationFromInfo({ SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless"] }),
    { isolation: "rootless-container", runtime: "runc" },
  );
  assert.deepStrictEqual(isolationFromInfo({ Runtimes: { runc: {} }, SecurityOptions: null }), {
    isolation: "container",
    runtime: "runc",
  });
});

describe("egressScript", () => {
  const input = { chain: "PAIR-abcd1234", subnet: "172.30.0.0/16", bridge: "pair-abcd1234" };

  it("drops private ranges and the host for one subnet, allowing only the runner URL", () => {
    const closed = egressScript({ ...input, allow: [] });
    assert.include(closed, "-A PAIR-abcd1234 -d 169.254.0.0/16 -j DROP");
    assert.include(closed, "-A PAIR-abcd1234-in -j DROP");
    assert.include(closed, "-I DOCKER-USER -s '172.30.0.0/16' -j 'PAIR-abcd1234'");
    assert.include(closed, "-I INPUT -i 'pair-abcd1234' -j 'PAIR-abcd1234-in'");
    assert.notInclude(closed, "getent");

    const open = egressScript({ ...input, allow: [{ host: "team.example.com", port: 443 }] });
    assert.include(open, "getent ahostsv4 'team.example.com'");
    assert.include(open, "--dport 443 -j RETURN");
  });

  it("refuses inputs that are not what they claim to be", () => {
    assert.throws(() => egressScript({ ...input, subnet: "172.30.0.0/16'; reboot", allow: [] }));
    assert.throws(() => egressScript({ ...input, allow: [{ host: "a$(reboot)", port: 443 }] }));
    assert.throws(() => egressScript({ ...input, bridge: "pair-much-too-long-name", allow: [] }));
  });
});

interface FakeContainer {
  labels: Record<string, string>;
  status: string;
  generation: number;
}

/** An Engine API answering from memory; `calls` records `METHOD /path` for each request. */
const fakeEngine = (containers: Map<string, FakeContainer>) => {
  const calls: Array<string> = [];
  const archives: Array<Uint8Array> = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const path = decodeURIComponent(url.pathname.replace(/^\/v1\.41/, ""));
      calls.push(`${request.method} ${path}`);
      const reply = (status: number, body?: unknown) =>
        HttpClientResponse.fromWeb(
          request,
          new Response(body === undefined ? null : JSON.stringify(body), { status }),
        );
      const bodyBytes = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
      const container = /^\/containers\/([^/]+)/.exec(path)?.[1];
      const existing = container === undefined ? undefined : containers.get(container);
      if (path === "/info") {
        return reply(200, { NCPU: 4, MemTotal: 16 * 2 ** 30, Runtimes: { runc: {} } });
      }
      if (path.startsWith("/images/")) return reply(200, { Id: "sha256:base" });
      if (path.startsWith("/networks/")) {
        return reply(200, { Id: "net", IPAM: { Config: [{ Subnet: "172.30.0.0/16" }] } });
      }
      if (path === "/volumes/create") return reply(201, {});
      if (path === "/containers/create") {
        const name = url.searchParams.get("name")!;
        if (containers.has(name)) return reply(409, { message: "Conflict" });
        const body = JSON.parse(new TextDecoder().decode(bodyBytes)) as {
          readonly Labels?: Record<string, string>;
        };
        containers.set(name, { labels: body.Labels ?? {}, status: "created", generation: 0 });
        return reply(201, { Id: name });
      }
      if (existing === undefined) return request.method === "DELETE" ? reply(204) : reply(404, {});
      if (path.endsWith("/json")) {
        return reply(200, {
          Id: container,
          Name: `/${container}`,
          Created: "2026-11-07T00:00:00Z",
          State: { Status: existing.status },
          Config: { Labels: existing.labels },
        });
      }
      if (path.endsWith("/archive") && request.method === "GET") {
        const tar = ustar([
          {
            name: "generation",
            mode: 0o644,
            content: new TextEncoder().encode(`${existing.generation}\n`),
          },
        ]);
        return HttpClientResponse.fromWeb(request, new Response(tar, { status: 200 }));
      }
      if (path.endsWith("/archive")) {
        archives.push(bodyBytes);
        return reply(200);
      }
      if (path.endsWith("/start")) {
        existing.status = "running";
        return reply(204);
      }
      if (path.endsWith("/stop")) {
        existing.status = "exited";
        return reply(204);
      }
      if (path.endsWith("/wait")) return reply(200, { StatusCode: 0 });
      containers.delete(container!);
      return reply(204);
    }),
  );
  return { engine: makeDockerEngine(client, "http://docker"), calls, archives };
};

const withDriver = <A, E>(
  containers: Map<string, FakeContainer>,
  use: (
    driver: Effect.Success<ReturnType<typeof makeWithEngine>>,
    fake: ReturnType<typeof fakeEngine>,
  ) => Effect.Effect<A, E>,
) => {
  const fake = fakeEngine(containers);
  return makeWithEngine({ kind: "docker", id: driverId, label: "Local" }, installId, {
    _tag: "Ready",
    engine: fake.engine,
    local: true,
  }).pipe(
    Effect.flatMap((driver) => use(driver, fake)),
    Effect.provide(ServerSettingsService.layerTest()),
  );
};

const bootstrap = (generation: number) => ({
  sandboxId,
  generation,
  runnerBuildId: "b1",
  serverUrl: "unix:/srv/t3/runner/runner.sock",
  enrollmentSecret: Redacted.make("enroll"),
});
const name = sandboxBackendName(installId, sandboxId, 1);
const tags = sandboxTags({ installId, sandboxId, generation: 1, driverId });
const createInput = {
  name,
  sandboxId,
  generation: 1,
  image: { type: "base" } as const,
  size: "small" as const,
  tags,
  bootstrap: bootstrap(1),
};

describe("DockerComputeDriver", () => {
  it.effect(
    "returns the same driverRef for a create replayed after a 409, without a restart",
    () => {
      const containers = new Map([
        [name, { labels: { ...tags }, status: "running", generation: 1 }],
      ]);
      return withDriver(containers, (driver, fake) =>
        Effect.gen(function* () {
          const result = yield* driver.create(createInput);
          assert.strictEqual(result.driverRef, name);
          assert.notInclude(fake.calls, `POST /containers/${name}/stop`);
          assert.notInclude(fake.calls, `PUT /containers/${name}/archive`);
        }),
      );
    },
  );

  it.effect("refuses a create whose name holds another sandbox generation", () => {
    const containers = new Map([
      [name, { labels: { ...tags, "pair.generation": "2" }, status: "running", generation: 2 }],
    ]);
    return withDriver(containers, (driver) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(driver.create(createInput));
        assert.strictEqual(error.reason, "conflict");
      }),
    );
  });

  it.effect("start leaves a runner of the same generation alone and replaces an older one", () => {
    const containers = new Map([[name, { labels: { ...tags }, status: "running", generation: 1 }]]);
    return withDriver(containers, (driver, fake) =>
      Effect.gen(function* () {
        yield* driver.start(name, bootstrap(1));
        assert.deepStrictEqual(fake.calls, [
          `GET /containers/${name}/json`,
          `GET /containers/${name}/archive`,
        ]);

        fake.calls.length = 0;
        yield* driver.start(name, bootstrap(2));
        assert.deepStrictEqual(fake.calls, [
          `GET /containers/${name}/json`,
          `GET /containers/${name}/archive`,
          `POST /containers/${name}/stop`,
          `PUT /containers/${name}/archive`,
          `POST /containers/${name}/start`,
        ]);
        const env = new TextDecoder().decode(readFirstTarFile(fake.archives[0]!)!);
        assert.include(env, "PAIR_RUNNER_URL='unix:/run/pair-server/runner.sock'\n");
        assert.include(env, "PAIR_RUNNER_ENROLL='enroll'\n");
      }),
    );
  });
});
