import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import type {
  DockerSandboxDriver,
  EnvironmentId,
  SandboxId,
  SandboxSize,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import packageJson from "../../../package.json" with { type: "json" };
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  type BaseImageMissingError,
  baseImageCandidates,
  baseImageMissingHint,
  ensureBaseImage,
  type ResolvedBaseImage,
} from "../image/SandboxBaseImage.ts";
import {
  RunnerBundle,
  type RunnerBundleInfo,
  type RunnerBundleUnavailableError,
} from "../runnerHub/RunnerBundle.ts";
import {
  RunnerEndpoint,
  type RunnerDialPlan,
  type RunnerRouteError,
} from "../runnerHub/RunnerEndpoint.ts";
import {
  type BackendSandbox,
  type BackendSandboxStatus,
  type ComputeCapabilities,
  ComputeDriver,
  type ComputeDriverCreateInput,
  ComputeDriverError,
  type ComputeDriverHealth,
  parseSandboxTags,
  type SandboxBootstrap,
} from "./ComputeDriver.ts";
import {
  type DockerEngine,
  DockerEngineError,
  type DockerHost,
  type EngineContainer,
  type EngineImage,
  type EngineInfo,
  makeDockerEngine,
  mapEngineError,
  parseDockerHost,
  readFirstTarFile,
  ustar,
} from "./DockerEngineApi.ts";

/** The runner's drain grace. */
const STOP_GRACE_SECONDS = 10;
const TRANSIENT_RETRY = { times: 3, schedule: Schedule.spaced("2 seconds") } as const;
/** Where a local server's runner socket directory is mounted. */
const SERVER_SOCKET_MOUNT = "/run/pair-host";
/** Where a local server's runner bundles are mounted, one directory per build. */
const RUNNER_BUNDLE_MOUNT = "/opt/pair-runner";
const TEAM_IMAGE_BUILD_LABEL = "pair.team-image.build";
const TEAM_IMAGE_MACHINE_LABEL = "pair.team-image.machine";
const RUNNING_STATES = new Set(["running", "restarting", "paused"]);

const SIZES: ComputeCapabilities["sizes"] = [
  { size: "small", vcpus: 2, memoryGb: 4 },
  { size: "default", vcpus: 4, memoryGb: 8 },
  { size: "large", vcpus: 8, memoryGb: 16 },
];

const capabilities: Omit<ComputeCapabilities, "defaultRunningCap"> = {
  persistentDisk: true,
  memoryOnStop: false,
  snapshot: false,
  imageBuild: "snapshot",
  maxSessionMs: null,
  diskRetentionDays: null,
  // The floor; `health` reports what the daemon offers.
  isolation: "container",
  egressRules: "none",
  regions: [],
  nestedDocker: false,
  sizes: SIZES,
  // Idle costs only memory on a box the team already pays for (04 §2).
  sleepOnSettle: true,
  defaultIdleSleepMs: 60 * 60_000,
};

/** gVisor refuses connects to host sockets unless runsc runs with `--host-uds=open` or `all`. */
const runscReachesHostSockets = (runsc: unknown) => {
  const args =
    typeof runsc === "object" && runsc !== null && "runtimeArgs" in runsc
      ? runsc.runtimeArgs
      : undefined;
  if (!Array.isArray(args)) return false;
  let value = "none";
  args.forEach((arg, index) => {
    const match = /^--?host-uds(?:=(.*))?$/u.exec(String(arg));
    if (match !== null) value = match[1] ?? String(args[index + 1] ?? "");
  });
  return value === "open" || value === "all";
};

/** gVisor's own network stack cannot reach Docker's embedded resolver on a user-defined network. */
const GVISOR_RESOLVERS = "1.1.1.1 8.8.8.8";

/** gVisor whenever the daemon offers it. */
export const isolationFromInfo = (
  info: Pick<EngineInfo, "Runtimes" | "SecurityOptions">,
): {
  readonly isolation: ComputeCapabilities["isolation"];
  readonly runtime: "runc" | "runsc";
  /** Whether a machine can connect to a socket bound in from the server's machine. */
  readonly hostSockets: boolean;
} => {
  if (info.Runtimes != null && "runsc" in info.Runtimes) {
    return {
      isolation: "gvisor",
      runtime: "runsc",
      hostSockets: runscReachesHostSockets(info.Runtimes.runsc),
    };
  }
  const rootless = (info.SecurityOptions ?? []).some((option) =>
    option.split(",").includes("name=rootless"),
  );
  return {
    isolation: rootless ? "rootless-container" : "container",
    runtime: "runc",
    hostSockets: true,
  };
};

const limitsFor = (size: SandboxSize, info: Pick<EngineInfo, "NCPU" | "MemTotal">) => {
  const spec = SIZES.find((entry) => entry.size === size) ?? SIZES[0]!;
  return {
    nanoCpus: Math.min(spec.vcpus, info.NCPU) * 1e9,
    memoryBytes: Math.min(spec.memoryGb * 2 ** 30, info.MemTotal),
  };
};

export const containerCreateBody = (input: {
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly sandboxId: SandboxId;
  readonly volume: string;
  readonly network: string;
  readonly limits: { readonly nanoCpus: number; readonly memoryBytes: number };
  readonly runtime: "runc" | "runsc";
  /** Local daemon only: what to bind from the server's machine. */
  readonly local: Option.Option<{
    readonly serverSocketDir: string;
    readonly bundle: Option.Option<{ readonly runnerBuildId: string; readonly path: string }>;
  }>;
}) => ({
  Image: input.image,
  Labels: input.labels,
  // Nothing from the bootstrap: env shows in `docker inspect` (03 §2.2).
  Env: [],
  HostConfig: {
    Runtime: input.runtime,
    NetworkMode: input.network,
    Privileged: false,
    // Docker's default set otherwise: sudo and apt need the rest. No `no-new-privileges` (breaks
    // sudo, 06 §9); default seccomp and AppArmor profiles.
    CapDrop: ["NET_RAW", "MKNOD"],
    NanoCpus: input.limits.nanoCpus,
    Memory: input.limits.memoryBytes,
    MemorySwap: input.limits.memoryBytes,
    PidsLimit: 4096,
    // A restart cannot re-enroll: the bootstrap file is gone.
    RestartPolicy: { Name: "no" },
    // Traversable but not listable, so agents reach the forward sockets; the token stays 0600.
    Tmpfs: { "/run/pair-runner": "rw,nosuid,nodev,noexec,mode=0711,size=16m" },
    Mounts: [
      { Type: "volume", Source: input.volume, Target: `/t3-sandbox/${input.sandboxId}` },
      // By directory, so a restarted server's new socket inode is visible; read-only, so the
      // sandbox cannot replace it. Never the Docker socket.
      ...Option.match(input.local, {
        onNone: () => [],
        onSome: (local) => [
          {
            Type: "bind",
            Source: local.serverSocketDir,
            Target: SERVER_SOCKET_MOUNT,
            ReadOnly: true,
          },
          ...Option.match(local.bundle, {
            onNone: () => [],
            onSome: (bundle) => [
              {
                Type: "bind",
                Source: bundle.path,
                Target: `${RUNNER_BUNDLE_MOUNT}/${bundle.runnerBuildId}`,
                ReadOnly: true,
              },
            ],
          }),
        ],
      }),
    ],
  },
});

const PRIVATE_RANGES = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "169.254.0.0/16",
  "0.0.0.0/8",
  "198.18.0.0/15",
  "224.0.0.0/4",
];
const IPTABLES_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,27}$/;
const BRIDGE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/;
const HOST_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

const isIpv4Cidr = (value: string) => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value);
  return (
    match !== null &&
    match.slice(1, 5).every((octet) => Number(octet) <= 255) &&
    Number(match[5]) <= 32
  );
};

/** The helper's exit codes the driver turns into a reason. */
const EGRESS_EXIT_NO_DOCKER_USER = 3;
const EGRESS_EXIT_UNRESOLVED = 4;

/**
 * The fixed script the egress helper runs on the Docker host's network namespace. Inputs are
 * validated here and never reach the shell unchecked; it throws on any other value.
 */
export const egressScript = (input: {
  readonly chain: string;
  readonly subnet: string;
  readonly bridge: string;
  readonly allow: ReadonlyArray<{ readonly host: string; readonly port: number }>;
}): string => {
  if (!IPTABLES_NAME.test(`${input.chain}-in`)) throw new Error("Invalid egress chain name.");
  if (!isIpv4Cidr(input.subnet)) throw new Error("Invalid egress subnet.");
  if (!BRIDGE_NAME.test(input.bridge)) throw new Error("Invalid egress bridge name.");
  for (const entry of input.allow) {
    if (!HOST_NAME.test(entry.host) || !Number.isInteger(entry.port)) {
      throw new Error("Invalid egress allow entry.");
    }
    if (entry.port < 1 || entry.port > 65535) throw new Error("Invalid egress allow entry.");
  }
  const { chain, subnet, bridge } = input;
  const inbound = `${chain}-in`;
  const allow = input.allow.flatMap((entry) => [
    `addrs=$(getent ahostsv4 '${entry.host}' | awk '{print $1}' | sort -u)`,
    `[ -n "$addrs" ] || exit ${EGRESS_EXIT_UNRESOLVED}`,
    `for a in $addrs; do`,
    `  allow="$allow-A ${chain} -d $a/32 -p tcp --dport ${entry.port} -j RETURN\n"`,
    `  allow="$allow-A ${inbound} -d $a/32 -p tcp --dport ${entry.port} -j RETURN\n"`,
    `done`,
  ]);
  return [
    "set -eu",
    // Whichever backend holds Docker's chain is the one the kernel consults for it.
    "if iptables-legacy -S DOCKER-USER >/dev/null 2>&1; then ipt=iptables-legacy",
    "elif iptables-nft -S DOCKER-USER >/dev/null 2>&1; then ipt=iptables-nft",
    `else exit ${EGRESS_EXIT_NO_DOCKER_USER}; fi`,
    "allow=''",
    ...allow,
    // Declaring the chains in a no-flush restore replaces their rules in one transaction.
    `printf '*filter\\n:${chain} - [0:0]\\n:${inbound} - [0:0]\\n%b%b%bCOMMIT\\n' \\`,
    `  '-A ${chain} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN\\n-A ${inbound} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN\\n' \\`,
    `  "$allow" \\`,
    `  '${[
      ...PRIVATE_RANGES.map((range) => `-A ${chain} -d ${range} -j DROP`),
      `-A ${chain} -j RETURN`,
      `-A ${inbound} -j DROP`,
    ].join("\\n")}\\n' | "$ipt-restore" -n`,
    `"$ipt" -C DOCKER-USER -s '${subnet}' -j '${chain}' 2>/dev/null || "$ipt" -I DOCKER-USER -s '${subnet}' -j '${chain}'`,
    `"$ipt" -C INPUT -i '${bridge}' -j '${inbound}' 2>/dev/null || "$ipt" -I INPUT -i '${bridge}' -j '${inbound}'`,
  ].join("\n");
};

const egressScriptOrNull = (input: Parameters<typeof egressScript>[0]) => {
  try {
    return egressScript(input);
  } catch {
    return null;
  }
};

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type EngineSetup =
  | { readonly _tag: "Ready"; readonly engine: DockerEngine; readonly local: boolean }
  | {
      readonly _tag: "Unusable";
      readonly reason: "unsupported" | "invalid-request";
      readonly cause: Error;
    };

const statusOf = (state: string): BackendSandboxStatus => {
  if (RUNNING_STATES.has(state)) return "running";
  if (state === "created" || state === "exited") return "stopped";
  return "failed";
};

/** One resolution of the base image; readers wait for its first decision, never for a whole pull. */
type BaseImageState =
  | { readonly _tag: "Pulling"; readonly ref: string }
  | { readonly _tag: "Ready"; readonly image: ResolvedBaseImage }
  | { readonly _tag: "Missing"; readonly error: BaseImageMissingError };

interface BaseImageAttempt {
  readonly override: string | undefined;
  readonly state: Ref.Ref<BaseImageState>;
  readonly decided: Deferred.Deferred<void>;
}

const baseImageInfo = ({ ref, digest, version }: ResolvedBaseImage) => ({ ref, digest, version });

/** The driver over an Engine client; `make` builds the client from the instance's config. */
export const makeWithEngine = Effect.fn("DockerComputeDriver.makeWithEngine")(function* (
  config: DockerSandboxDriver,
  installId: EnvironmentId,
  setup: EngineSetup,
  runner: {
    /** How this instance's sandboxes reach the server; the egress block must let it through. */
    readonly route: Effect.Effect<RunnerDialPlan, RunnerRouteError>;
    /** The server's own bundle, which a local daemon mounts instead of downloading. */
    readonly bundle: Effect.Effect<RunnerBundleInfo, RunnerBundleUnavailableError>;
  },
  server: {
    readonly version: string;
    /** Run from a checkout, where a developer's own `t3-sandbox:dev` build is tried first. */
    readonly fromSource: boolean;
  },
) {
  const settings = yield* ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const driverId = config.id;
  const installKey = installId.slice(0, 8);
  const networkName = `pair-${installKey}`;
  const setupLock = yield* Semaphore.make(1);
  // Only touched while holding `setupLock`.
  let blockEnsuredOnCreate = false;

  const failure = (
    operation: ComputeDriverError["operation"],
    reason: ComputeDriverError["reason"],
    cause?: unknown,
  ) =>
    new ComputeDriverError({
      driverId,
      operation,
      reason,
      retryable: false,
      ...(cause === undefined ? {} : { cause }),
    });

  const engineFor = (operation: ComputeDriverError["operation"]) =>
    setup._tag === "Ready"
      ? Effect.succeed(setup)
      : Effect.fail(failure(operation, setup.reason, setup.cause));

  /** Maps Engine failures to this operation and retries transient ones; every call is idempotent. */
  const run =
    (operation: ComputeDriverError["operation"]) =>
    <A, R>(effect: Effect.Effect<A, DockerEngineError | ComputeDriverError, R>) =>
      effect.pipe(
        Effect.catchTags({
          DockerEngineError: (error) => Effect.fail(mapEngineError(error, { driverId, operation })),
        }),
        Effect.retry({
          ...TRANSIENT_RETRY,
          // An image still downloading is retried by the caller's outbox, not here.
          while: (error) =>
            error.retryable && error.reason === "unavailable" && error.image === undefined,
        }),
      );

  const scope = yield* Effect.scope;
  const imageLock = yield* Semaphore.make(1);
  // Only touched while holding `imageLock`.
  let attempt: BaseImageAttempt | undefined;

  const startAttempt = Effect.fn("DockerComputeDriver.startBaseImageAttempt")(function* (
    engine: DockerEngine,
    override: string | undefined,
  ) {
    const candidates = baseImageCandidates({ override, ...server });
    const state = yield* Ref.make<BaseImageState>({
      _tag: "Pulling",
      ref: candidates[0]?.ref ?? "",
    });
    const decided = yield* Deferred.make<void>();
    const settle = (next: BaseImageState) =>
      Ref.set(state, next).pipe(Effect.andThen(Deferred.succeed(decided, undefined)));
    // A pull takes minutes, far past a sandbox effect's bound, so it never runs inside one.
    yield* ensureBaseImage(engine, candidates, {
      onPulling: (ref) => settle({ _tag: "Pulling", ref }),
    }).pipe(
      Effect.matchEffect({
        onSuccess: (image) => settle({ _tag: "Ready", image }),
        onFailure: (error) => settle({ _tag: "Missing", error }),
      }),
      Effect.ensuring(Deferred.succeed(decided, undefined)),
      Effect.forkIn(scope),
    );
    return { override, state, decided } satisfies BaseImageAttempt;
  });

  /** Starts a resolution if none is current for this setting; a missing one is retried on request. */
  const currentAttempt = Effect.fn("DockerComputeDriver.currentBaseImageAttempt")(function* (
    operation: ComputeDriverError["operation"],
    retryMissing: boolean,
  ) {
    const { engine } = yield* engineFor(operation);
    const override = (yield* settings.getSettings.pipe(
      Effect.mapError((cause) => failure(operation, "unavailable", cause)),
    )).sandbox?.baseImage;
    return yield* imageLock.withPermits(1)(
      Effect.gen(function* () {
        if (attempt !== undefined && attempt.override === override) {
          const state = yield* Ref.get(attempt.state);
          if (!(retryMissing && state._tag === "Missing")) return attempt;
        }
        attempt = yield* startAttempt(engine, override);
        return attempt;
      }),
    );
  });

  const baseImageState = Effect.fn("DockerComputeDriver.baseImageState")(function* (
    operation: ComputeDriverError["operation"],
    retryMissing: boolean,
  ) {
    const current = yield* currentAttempt(operation, retryMissing);
    yield* Deferred.await(current.decided);
    return yield* Ref.get(current.state);
  });

  const readyBaseImage = Effect.fn("DockerComputeDriver.readyBaseImage")(function* () {
    const state = yield* baseImageState("create", false);
    switch (state._tag) {
      case "Ready":
        return state.image;
      case "Pulling":
        return yield* new ComputeDriverError({
          driverId,
          operation: "create",
          reason: "unavailable",
          retryable: true,
          image: { ref: state.ref, state: "pulling" },
        });
      case "Missing":
        return yield* new ComputeDriverError({
          driverId,
          operation: "create",
          reason: "not-found",
          retryable: false,
          image: {
            ref: state.error.refs.join(", "),
            state: "missing",
            hint: baseImageMissingHint(state.error),
          },
        });
    }
  });

  const ensureNetwork = Effect.fn("DockerComputeDriver.ensureNetwork")(function* (
    engine: DockerEngine,
  ) {
    const existing = yield* engine.inspectNetwork(networkName);
    if (existing !== null) return existing;
    yield* engine.createNetwork({
      Name: networkName,
      CheckDuplicate: true,
      Driver: "bridge",
      EnableIPv6: false,
      Labels: { "pair.install": installId, "pair.role": "network" },
      Options: {
        "com.docker.network.bridge.name": networkName,
        // Sandboxes cannot reach each other, as separate networks would give.
        "com.docker.network.bridge.enable_icc": "false",
      },
    });
    const created = yield* engine.inspectNetwork(networkName);
    if (created === null) {
      return yield* new DockerEngineError({ endpoint: "GET /networks/{id}", failure: "response" });
    }
    return created;
  });

  const runnerAllow = runner.route.pipe(
    Effect.map((plan): ReadonlyArray<{ readonly host: string; readonly port: number }> => {
      const url = URL.parse(plan.serverUrl);
      if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) return [];
      const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
      return [{ host: url.hostname, port }];
    }),
    // A sandbox that cannot dial fails at boot with the route's reason, not here.
    Effect.orElseSucceed(() => []),
  );

  /** Never reports `applied: true` unless the helper exited 0 on this pass. */
  const ensureBlock = Effect.fn("DockerComputeDriver.ensureBlock")(function* (
    engine: DockerEngine,
    image: string,
  ) {
    const network = yield* ensureNetwork(engine);
    const subnet = network.IPAM.Config?.find((entry) => isIpv4Cidr(entry.Subnet ?? ""))?.Subnet;
    if (subnet === undefined) {
      return { applied: false, reason: "The sandbox network has no IPv4 subnet." } as const;
    }
    const script = egressScriptOrNull({
      chain: `PAIR-${installKey}`,
      subnet,
      bridge: networkName,
      allow: yield* runnerAllow,
    });
    if (script === null) {
      return {
        applied: false,
        reason: "The install id or runner URL cannot be written as firewall rules.",
      } as const;
    }
    if ((yield* engine.inspectImage(image)) === null) {
      return {
        applied: false,
        reason: `The egress helper needs the base image ${image} on the Docker host.`,
      } as const;
    }
    const helper = `${networkName}-egress`;
    // Removed by name rather than AutoRemove, so its exit code can be read first.
    yield* engine.removeContainer(helper);
    const code = yield* Effect.gen(function* () {
      yield* engine.createContainer(helper, {
        Image: image,
        User: "0",
        Entrypoint: ["/bin/sh", "-c"],
        Cmd: [script],
        Labels: { "pair.install": installId, "pair.role": "egress" },
        // The only container with NET_ADMIN or host networking, and it runs a fixed script.
        HostConfig: {
          NetworkMode: "host",
          CapAdd: ["NET_ADMIN", "NET_RAW"],
          Runtime: "runc",
          RestartPolicy: { Name: "no" },
        },
      });
      yield* engine.startContainer(helper);
      return yield* engine.waitContainer(helper);
    }).pipe(Effect.ensuring(engine.removeContainer(helper).pipe(Effect.ignore)));
    if (code === 0) return { applied: true } as const;
    return {
      applied: false,
      reason:
        code === EGRESS_EXIT_NO_DOCKER_USER
          ? "Docker has no DOCKER-USER chain; its firewall backend is not iptables."
          : code === EGRESS_EXIT_UNRESOLVED
            ? "The runner URL's host does not resolve on the Docker host."
            : `The egress helper exited with code ${code}.`,
    } as const;
  });

  const blockOrReason = (engine: DockerEngine, image: string) =>
    ensureBlock(engine, image).pipe(
      Effect.catchTags({
        DockerEngineError: (error) =>
          Effect.succeed({
            applied: false,
            reason: `The Docker daemon refused the egress helper (${error.endpoint}).`,
          } as const),
      }),
    );

  const serverUrlFor = (operation: ComputeDriverError["operation"], serverUrl: string) => {
    if (!serverUrl.startsWith("unix:")) return Effect.succeed(serverUrl);
    // A remote daemon cannot bind a socket on the server's machine.
    if (setup._tag !== "Ready" || !setup.local)
      return Effect.fail(failure(operation, "invalid-request"));
    const basename = serverUrl.slice(serverUrl.lastIndexOf("/") + 1);
    return Effect.succeed(`unix:${SERVER_SOCKET_MOUNT}/${basename}`);
  };

  const readGeneration = Effect.fn("DockerComputeDriver.readGeneration")(function* (
    engine: DockerEngine,
    driverRef: string,
  ) {
    const archive = yield* engine.getArchive(driverRef, "/etc/pair-runner/generation");
    const file = archive === null ? null : readFirstTarFile(archive);
    const text = file === null ? "" : decoder.decode(file).trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  });

  /** Writes the bootstrap into the container layer (never env or the volume), then starts it. */
  const boot = Effect.fn("DockerComputeDriver.boot")(function* (
    operation: "create" | "start",
    engine: DockerEngine,
    container: EngineContainer,
    bootstrap: SandboxBootstrap,
  ) {
    const driverRef = container.Name.replace(/^\//, "");
    if (RUNNING_STATES.has(container.State.Status)) {
      // A replay must not restart a healthy runner of the same generation.
      if ((yield* readGeneration(engine, driverRef)) === bootstrap.generation) return;
      yield* engine.stopContainer(driverRef, STOP_GRACE_SECONDS);
    }
    const values = {
      PAIR_RUNNER_URL: yield* serverUrlFor(operation, bootstrap.serverUrl),
      PAIR_SANDBOX_ID: bootstrap.sandboxId,
      PAIR_RUNNER_BUILD: bootstrap.runnerBuildId,
      PAIR_RUNNER_ENROLL: Redacted.value(bootstrap.enrollmentSecret),
      ...(container.HostConfig?.Runtime === "runsc" ? { PAIR_DNS: GVISOR_RESOLVERS } : {}),
    };
    if (Object.values(values).some((value) => /[\0\n\r]/.test(value))) {
      return yield* failure(operation, "invalid-request");
    }
    const env = Object.entries(values)
      .map(([name, value]) => `${name}=${shellQuote(value)}\n`)
      .join("");
    yield* engine.putArchive(
      driverRef,
      "/",
      ustar([
        { name: "etc/pair-runner", mode: 0o700 },
        { name: "etc/pair-runner/bootstrap.env", mode: 0o600, content: encoder.encode(env) },
        {
          name: "etc/pair-runner/generation",
          mode: 0o644,
          content: encoder.encode(`${bootstrap.generation}\n`),
        },
      ]),
    );
    yield* engine.startContainer(driverRef);
  });

  const bootImage = Effect.fn("DockerComputeDriver.bootImage")(function* (
    engine: DockerEngine,
    requested: ComputeDriverCreateInput["image"],
  ) {
    if (requested.type === "base") {
      const resolved = yield* readyBaseImage();
      return { image: resolved.id, baseImage: baseImageInfo(resolved) };
    }
    if ((yield* engine.inspectImage(requested.imageRef)) === null) {
      return yield* failure("create", "not-found");
    }
    return { image: requested.imageRef, baseImage: null };
  });

  const create = Effect.fn("DockerComputeDriver.create")(function* (
    input: ComputeDriverCreateInput,
  ) {
    const { engine, local } = yield* engineFor("create");
    // A sandbox boots from the image id it resolved, never from a tag that could move.
    const { image, baseImage } = yield* bootImage(engine, input.image);
    const info = yield* engine.info;
    const isolation = isolationFromInfo(info);
    const socketPath = input.bootstrap.serverUrl.startsWith("unix:")
      ? input.bootstrap.serverUrl.slice("unix:".length)
      : null;
    if (local && socketPath !== null && !isolation.hostSockets) {
      return yield* new ComputeDriverError({
        driverId,
        operation: "create",
        reason: "unsupported",
        retryable: false,
        setupHint:
          "Docker's gVisor runtime blocks machines from reaching this server. An admin can fix it " +
          "with `sudo runsc install -- --host-uds=open` and a Docker restart.",
      });
    }
    const network = yield* setupLock.withPermits(1)(
      Effect.gen(function* () {
        if (!blockEnsuredOnCreate) {
          blockEnsuredOnCreate = true;
          const block = yield* blockOrReason(engine, image);
          // Sandboxes still start; health and the reconciler try again.
          if (!block.applied) {
            yield* Effect.logWarning("Private network block not applied", {
              reason: block.reason,
            });
          }
        }
        return yield* ensureNetwork(engine);
      }),
    );
    const labels = { ...input.tags, "pair.size": input.size };
    // The volume takes the container's name: a stray from a lost create owns its own disk.
    yield* engine.createVolume({ Name: input.name, Labels: labels });
    // A bundle of another build than this boot's would not be the one it runs.
    const bundle =
      local && socketPath !== null
        ? yield* runner.bundle.pipe(
            Effect.map((info) =>
              info.runnerBuildId === input.bootstrap.runnerBuildId
                ? Option.some({ runnerBuildId: info.runnerBuildId, path: info.directory })
                : Option.none(),
            ),
            Effect.orElseSucceed(() => Option.none()),
          )
        : Option.none();
    const created = yield* engine.createContainer(
      input.name,
      containerCreateBody({
        image,
        labels,
        sandboxId: input.sandboxId,
        volume: input.name,
        network: network.Id,
        limits: limitsFor(input.size, info),
        runtime: isolation.runtime,
        local:
          local && socketPath !== null
            ? Option.some({
                serverSocketDir: socketPath.slice(0, socketPath.lastIndexOf("/")) || "/",
                bundle,
              })
            : Option.none(),
      }),
    );
    const container = yield* engine.inspectContainer(input.name);
    if (container === null) return yield* failure("create", "unavailable");
    if (!created) {
      const existing = container.Config.Labels ?? {};
      if (
        existing["pair.sandbox"] !== input.tags["pair.sandbox"] ||
        existing["pair.generation"] !== input.tags["pair.generation"]
      ) {
        return yield* failure("create", "conflict");
      }
    }
    yield* boot("create", engine, container, input.bootstrap);
    return {
      driverRef: input.name,
      baseImage,
    };
  }, run("create"));

  const start = Effect.fn("DockerComputeDriver.start")(function* (
    driverRef: string,
    bootstrap: SandboxBootstrap,
  ) {
    const { engine } = yield* engineFor("start");
    const container = yield* engine.inspectContainer(driverRef);
    if (container === null) return yield* failure("start", "not-found");
    // An update prunes the release this machine mounted; the bootstrap fetches the server's build.
    for (const mount of container.Mounts ?? []) {
      if (mount.Type === "bind" && mount.Destination.startsWith(`${RUNNER_BUNDLE_MOUNT}/`)) {
        yield* fs
          .makeDirectory(mount.Source, { recursive: true })
          .pipe(Effect.mapError((cause) => failure("start", "not-found", cause)));
      }
    }
    yield* boot("start", engine, container, bootstrap);
  }, run("start"));

  const stop = Effect.fn("DockerComputeDriver.stop")(function* (driverRef: string) {
    const { engine } = yield* engineFor("stop");
    yield* engine.stopContainer(driverRef, STOP_GRACE_SECONDS);
  }, run("stop"));

  const destroy = Effect.fn("DockerComputeDriver.destroy")(function* (driverRef: string) {
    const { engine } = yield* engineFor("destroy");
    yield* engine.removeContainer(driverRef);
    yield* engine.removeVolume(driverRef).pipe(
      Effect.catchTags({
        // Still in use, e.g. by a container mid-removal: the caller retries.
        DockerEngineError: (error) =>
          error.status === 409
            ? Effect.fail(
                new ComputeDriverError({
                  driverId,
                  operation: "destroy",
                  reason: "conflict",
                  retryable: true,
                  backendStatus: 409,
                  cause: error,
                }),
              )
            : Effect.fail(error),
      }),
    );
  }, run("destroy"));

  const status = Effect.fn("DockerComputeDriver.status")(function* (driverRef: string) {
    const { engine } = yield* engineFor("status");
    const container = yield* engine.inspectContainer(driverRef);
    const now = yield* DateTime.now;
    if (container === null) {
      return {
        driverRef,
        name: driverRef,
        sandboxId: null,
        status: "missing",
        createdAt: now,
      } satisfies BackendSandbox;
    }
    return {
      driverRef,
      name: container.Name.replace(/^\//, ""),
      sandboxId: parseSandboxTags(container.Config.Labels ?? {})?.sandboxId ?? null,
      status: statusOf(container.State.Status),
      createdAt: DateTime.make(container.Created).pipe(Option.getOrElse(() => now)),
    } satisfies BackendSandbox;
  }, run("status"));

  const list = Effect.fn("DockerComputeDriver.list")(function* (
    tags: Readonly<Record<string, string>>,
  ) {
    const { engine } = yield* engineFor("list");
    // Never another install's resources, whatever the caller asks for.
    const filter = { ...tags, "pair.install": installId };
    const now = yield* DateTime.now;
    const containers = yield* engine.listContainers(filter, ["pair.sandbox"]);
    const volumes = yield* engine.listVolumes(filter);
    const sandboxes: Array<BackendSandbox> = containers.map((container) => {
      const name = (container.Names[0] ?? container.Id).replace(/^\//, "");
      return {
        driverRef: name,
        name,
        sandboxId: parseSandboxTags(container.Labels ?? {})?.sandboxId ?? null,
        status: statusOf(container.State),
        createdAt: DateTime.make(container.Created * 1000).pipe(Option.getOrElse(() => now)),
      };
    });
    const named = new Set(sandboxes.map((sandbox) => sandbox.name));
    // A disk whose container is gone, so the reconciler can remove it.
    for (const volume of volumes) {
      if (named.has(volume.Name)) continue;
      sandboxes.push({
        driverRef: volume.Name,
        name: volume.Name,
        sandboxId: parseSandboxTags(volume.Labels ?? {})?.sandboxId ?? null,
        status: "stopped",
        createdAt:
          volume.CreatedAt === undefined
            ? now
            : DateTime.make(volume.CreatedAt).pipe(Option.getOrElse(() => now)),
      });
    }
    return sandboxes;
  }, run("list"));

  const deleteImage = Effect.fn("DockerComputeDriver.deleteImage")(function* (imageRef: string) {
    const { engine } = yield* engineFor("deleteImage");
    yield* engine.removeImage(imageRef);
  }, run("deleteImage"));

  const snapshot = Effect.fn("DockerComputeDriver.snapshot")(function* (
    driverRef: string,
    name: string,
  ) {
    const { engine } = yield* engineFor("snapshot");
    const colon = name.lastIndexOf(":");
    if (colon <= name.lastIndexOf("/")) return yield* failure("snapshot", "invalid-request");
    const repo = name.slice(0, colon);
    const tag = name.slice(colon + 1);
    // The machine label tells this commit's image from another install's of the same name.
    const labels = { [TEAM_IMAGE_BUILD_LABEL]: tag, [TEAM_IMAGE_MACHINE_LABEL]: driverRef };
    const made = (image: EngineImage | null) =>
      image !== null &&
      image.Config?.Labels?.[TEAM_IMAGE_BUILD_LABEL] === tag &&
      image.Config.Labels[TEAM_IMAGE_MACHINE_LABEL] === driverRef;
    let image = yield* engine.inspectImage(name);
    if (!made(image)) {
      const imageId = yield* engine.commit({ container: driverRef, repo, tag, labels });
      image = yield* engine.inspectImage(imageId);
    }
    if (image === null) return yield* failure("snapshot", "not-found");
    return { imageRef: image.Id, sizeBytes: image.Size ?? null };
  }, run("snapshot"));

  const health = Effect.gen(function* () {
    const { engine } = yield* engineFor("health");
    const info = yield* engine.info;
    const state = yield* baseImageState("health", true);
    return {
      isolation: isolationFromInfo(info).isolation,
      privateNetworkBlock:
        state._tag === "Ready"
          ? yield* setupLock.withPermits(1)(blockOrReason(engine, state.image.id))
          : ({ applied: false, reason: "The base image is not on the Docker host yet." } as const),
      baseImage:
        state._tag === "Ready"
          ? baseImageInfo(state.image)
          : state._tag === "Pulling"
            ? { pulling: state.ref }
            : {
                missing: state.error.refs.join(", "),
                hint: baseImageMissingHint(state.error),
              },
    } satisfies ComputeDriverHealth;
  }).pipe(run("health"), Effect.withSpan("DockerComputeDriver.health"));

  // Pulls start when the driver is built, so enabling Docker in Settings begins the download.
  if (setup._tag === "Ready") yield* currentAttempt("health", false).pipe(Effect.ignore);
  // A quarter of the host's CPUs. Read once: a daemon that is down now gets 1 until its settings change.
  const defaultRunningCap =
    setup._tag === "Ready"
      ? yield* setup.engine.info.pipe(
          Effect.timeout("5 seconds"),
          Effect.map((info) => Math.max(1, Math.floor(info.NCPU / 4))),
          Effect.orElseSucceed(() => 1),
        )
      : 1;

  return ComputeDriver.of({
    driverId,
    kind: "docker",
    capabilities: { ...capabilities, defaultRunningCap },
    create,
    start,
    stop,
    destroy,
    status,
    list,
    deleteImage,
    snapshot,
    health,
  });
});

const SSH_ADVICE =
  "Docker over ssh:// is not supported. Forward the socket with `ssh -NL <local.sock>:/var/run/docker.sock` and use unix://.";

// node:http, not undici: a single executable cannot import the undici the server keeps external.
const nodeHttpClient = (options: NodeHttpClient.HttpAgentOptions | undefined) =>
  NodeHttpClient.makeAgent(options).pipe(
    Effect.flatMap((agent) =>
      NodeHttpClient.makeNodeHttp.pipe(Effect.provideService(NodeHttpClient.HttpAgent, agent)),
    ),
  );

const resolveEngine = Effect.fn("DockerComputeDriver.resolveEngine")(function* (host: DockerHost) {
  const fs = yield* FileSystem.FileSystem;
  if (host._tag === "Unsupported") {
    return {
      _tag: "Unusable",
      reason: "unsupported",
      cause: new Error(
        host.scheme === "ssh"
          ? SSH_ADVICE
          : `Docker hosts of kind ${host.scheme} are not supported.`,
      ),
    } satisfies EngineSetup;
  }
  if (host._tag === "Unix") {
    let socketPath = host.socketPaths.at(-1)!;
    for (const candidate of host.socketPaths) {
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        socketPath = candidate;
        break;
      }
    }
    const client = yield* nodeHttpClient({ socketPath });
    return {
      _tag: "Ready",
      engine: makeDockerEngine(client, "http://docker"),
      local: true,
    } satisfies EngineSetup;
  }
  let connect: { readonly ca: string; readonly cert: string; readonly key: string } | undefined;
  if (host.tls !== null) {
    const read = (name: string) => fs.readFileString(`${host.tls!.certPath}/${name}`);
    const files = yield* Effect.all([read("ca.pem"), read("cert.pem"), read("key.pem")]).pipe(
      Effect.result,
    );
    if (files._tag === "Failure") {
      return {
        _tag: "Unusable",
        reason: "invalid-request",
        cause: new Error("DOCKER_CERT_PATH must hold ca.pem, cert.pem and key.pem.", {
          cause: files.failure,
        }),
      } satisfies EngineSetup;
    }
    const [ca, cert, key] = files.success;
    connect = { ca, cert, key };
  }
  const client = yield* nodeHttpClient(connect);
  return {
    _tag: "Ready",
    engine: makeDockerEngine(client, host.origin),
    local: false,
  } satisfies EngineSetup;
});

/**
 * The registry factory for `kind: "docker"`. The HTTP agents live in the registry's scope for
 * this instance, so a config change closes them.
 */
export const make = Effect.fn("DockerComputeDriver.make")(function* (config: DockerSandboxDriver) {
  const installId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const env = yield* HostProcess.Environment;
  const host = parseDockerHost(config.dockerHost, env, yield* HostProcess.HomeDirectory);
  const endpoint = yield* RunnerEndpoint;
  const bundle = yield* RunnerBundle;
  return yield* makeWithEngine(
    config,
    installId,
    yield* resolveEngine(host),
    {
      route: endpoint.planFor(config),
      bundle: bundle.current,
    },
    { version: packageJson.version, fromSource: import.meta.url.endsWith(".ts") },
  );
});
