#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - the benchmark needs hrtime, a plain HTTP server and a forced GC.
/**
 * Measures runner latency, throughput, memory and startup against 03 section 9 and 2.3, over a
 * local baseline, a `runner.mjs` subprocess and a sandbox-image container. Exits 1 when a Docker
 * figure misses its budget. Not CI: timings belong in a script, never in tests.
 */
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodeV8 from "node:v8";
import * as NodeVM from "node:vm";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SandboxId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { HttpRouter, HttpServer } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../src/config.ts";
import * as SqlitePersistence from "../src/persistence/Sqlite.ts";
import * as NodePtyAdapter from "../src/terminal/NodePtyAdapter.ts";
import * as WorkspaceHosts from "../src/workspaceHost/WorkspaceHosts.ts";
import * as RunnerBundle from "../src/sandbox/runnerHub/RunnerBundle.ts";
import type { RunnerConnection } from "../src/sandbox/runnerHub/RunnerConnection.ts";
import * as RunnerGrants from "../src/sandbox/runnerHub/RunnerGrants.ts";
import * as RunnerHub from "../src/sandbox/runnerHub/RunnerHub.ts";
import * as RunnerRoute from "../src/sandbox/runnerHub/RunnerRoute.ts";

// Docker figures that exceed these fail the run (03 section 9 and 2.3).
const BUDGET = {
  startupMountedMs: 500,
  startupFetchedMs: 700,
  stdoutP50Ms: 1,
  stdoutP99Ms: 5,
  echoP50Ms: 2,
  throughputMBps: 50,
  cpuMsPerMB: 5,
  memoryMiBPerSandbox: 8,
} as const;

const MiB = 1024 * 1024;
const MB = 1_000_000;
const CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";
const CHILD_ENV = { PATH: CHILD_PATH, TERM: "xterm-256color" };
const DONE_MARKER = "__PAIR_BENCH_DONE__";

interface Sizes {
  readonly boots: number;
  readonly stdoutLines: number;
  readonly keystrokes: number;
  readonly fileMiB: number;
  readonly idleRunners: number;
}
const FULL: Sizes = {
  boots: 10,
  stdoutLines: 10_000,
  keystrokes: 1_000,
  fileMiB: 256,
  idleRunners: 5,
};
const QUICK: Sizes = { boots: 3, stdoutLines: 1_000, keystrokes: 100, fileMiB: 32, idleRunners: 5 };

const nowNs = () => process.hrtime.bigint();
const toMs = (ns: number | bigint) => Number(ns) / 1e6;

const percentile = (samples: ReadonlyArray<number>, quantile: number) => {
  const sorted = Array.from(samples).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)] ?? Number.NaN;
};

/** What each case needs from a place that runs commands: the baseline and both runners fit it. */
interface Target {
  /** The `node` the target's children run. */
  readonly node: string;
  readonly exec: (script: string) => Effect.Effect<void>;
  readonly stdout: (source: string) => Effect.Effect<Stream.Stream<Uint8Array>, never, Scope.Scope>;
  readonly pty: (script: string) => Effect.Effect<BenchPty, never, Scope.Scope>;
}
interface BenchPty {
  readonly write: (data: string) => void;
  readonly output: Stream.Stream<string>;
}

const spawnInput = (command: string, args: ReadonlyArray<string>) =>
  ({
    command,
    args,
    cwd: "/",
    env: CHILD_ENV,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    extraFds: [],
  }) as const;

const localTarget = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const ptys = yield* PtyAdapter.PtyAdapter;
  return {
    node: process.execPath,
    exec: Effect.fn("local.exec")(
      function* (script) {
        const child = yield* spawner.spawn(
          ChildProcess.make("/bin/sh", ["-c", script], { env: CHILD_ENV, stdin: "ignore" }),
        );
        yield* child.exitCode;
      },
      Effect.scoped,
      Effect.orDie,
    ),
    stdout: Effect.fn("local.stdout")(function* (source) {
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, ["-e", source], {
          env: CHILD_ENV,
          stdin: "ignore",
          stderr: "ignore",
        }),
      );
      return child.stdout.pipe(Stream.orDie);
    }, Effect.orDie),
    pty: Effect.fn("local.pty")(function* (script) {
      const proc = yield* ptys
        .spawn({
          shell: "/bin/sh",
          args: ["-c", script],
          cwd: "/",
          cols: 80,
          rows: 24,
          env: CHILD_ENV,
        })
        .pipe(Effect.orDie);
      yield* Effect.addFinalizer(() => Effect.sync(() => proc.kill()));
      // Registered in the spawn's own tick, so early output is queued, not lost.
      const output = yield* Queue.unbounded<string>();
      proc.onData((data) => Queue.offerUnsafe(output, data));
      return { write: (data) => proc.write(data), output: Stream.fromQueue(output) };
    }),
  } satisfies Target;
});

const remoteTarget = (connection: RunnerConnection, node: string): Target => ({
  node,
  exec: Effect.fn("remote.exec")(function* (script) {
    const client = yield* connection.client;
    const result = yield* client["process.run"]({
      command: "/bin/sh",
      args: ["-c", script],
      cwd: "/",
      env: CHILD_ENV,
    });
    if (result.exitCode !== 0)
      return yield* Effect.die(new Error(`${script} exited ${result.exitCode}`));
  }, Effect.orDie),
  stdout: Effect.fn("remote.stdout")(function* (source) {
    const client = yield* connection.client;
    const { handle } = yield* client["process.spawn"](spawnInput(node, ["-e", source]));
    yield* Effect.addFinalizer(() => client["process.release"]({ handle }).pipe(Effect.ignore));
    return connection.output(handle, "fd:1").pipe(Stream.orDie);
  }, Effect.orDie),
  pty: Effect.fn("remote.pty")(function* (script) {
    const client = yield* connection.client;
    const { handle } = yield* client["pty.open"]({
      shell: "/bin/sh",
      args: ["-c", script],
      cwd: "/",
      cols: 80,
      rows: 24,
      env: CHILD_ENV,
    });
    yield* Effect.addFinalizer(() => client["pty.release"]({ handle }).pipe(Effect.ignore));
    const writer = yield* connection.ptyWriter(handle);
    return { write: writer.write, output: connection.output(handle, "pty").pipe(Stream.orDie) };
  }, Effect.orDie),
});

const percentiles = (samples: ReadonlyArray<number>) => ({
  p50: toMs(percentile(samples, 0.5)),
  p99: toMs(percentile(samples, 0.99)),
});

/** A child that prints one stamped line per millisecond; the stamp is the hrtime at its write. */
const stampedLines = (count: number) => `
const fs = require("node:fs");
const start = process.hrtime.bigint();
for (let i = 0; i < ${count}; i++) {
  const due = start + BigInt(i) * 1000000n;
  while (process.hrtime.bigint() < due) {}
  fs.writeSync(1, (process.hrtime.bigint() + "").padEnd(63) + "\\n");
}`;

const stdoutLatency = Effect.fn("stdoutLatency")(function* (target: Target, lines: number) {
  const output = yield* target.stdout(stampedLines(lines));
  const latencies: Array<number> = [];
  let pending = "";
  yield* output.pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        const at = nowNs();
        pending += Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("latin1");
        for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
          latencies.push(Number(at - BigInt(pending.slice(0, end).trim())));
          pending = pending.slice(end + 1);
        }
      }),
    ),
  );
  if (latencies.length !== lines) {
    return yield* Effect.die(new Error(`expected ${lines} lines, received ${latencies.length}`));
  }
  return percentiles(latencies);
}, Effect.scoped);

/** One byte at a time through `cat` in raw mode, each sent after the previous echo arrived. */
const keystrokeEcho = Effect.fn("keystrokeEcho")(function* (target: Target, keystrokes: number) {
  const pty = yield* target.pty("stty raw -echo; printf READY; exec cat");
  // The consumer stamps the arrival itself, so the sender's wake-up is not in the figure.
  const arrivals = yield* Queue.unbounded<{ readonly at: bigint; readonly length: number }>();
  yield* pty.output.pipe(
    Stream.runForEach((text) =>
      Effect.sync(() => Queue.offerUnsafe(arrivals, { at: nowNs(), length: text.length })),
    ),
    Effect.forkScoped,
  );
  // "READY" is five characters; the tty is raw from here on.
  for (let seen = 0; seen < 5; seen += (yield* Queue.take(arrivals)).length);
  const latencies: Array<number> = [];
  for (let i = 0; i < keystrokes; i++) {
    const sent = nowNs();
    pty.write(String.fromCharCode(97 + (i % 26)));
    let echoed = 0;
    let at = sent;
    while (echoed < 1) {
      const arrival = yield* Queue.take(arrivals);
      echoed += arrival.length;
      at = arrival.at;
    }
    latencies.push(Number(at - sent));
  }
  return percentiles(latencies);
}, Effect.scoped);

/** `cat` of a large file in a PTY, and what the server process spent on it. */
const ptyThroughput = Effect.fn("ptyThroughput")(function* (target: Target, fileMiB: number) {
  const file = `/tmp/pair-bench-${process.pid}.bin`;
  const bytes = fileMiB * MiB;
  yield* target.exec(`yes ${"x".repeat(63)} | head -c ${bytes} > ${file}`);
  yield* Effect.addFinalizer(() => target.exec(`rm -f ${file}`));
  const cpuBefore = process.cpuUsage();
  const startedAt = nowNs();
  const pty = yield* target.pty(`cat ${file}; printf ${DONE_MARKER}`);
  let received = 0;
  let tail = "";
  yield* pty.output.pipe(
    Stream.takeUntil((text) => {
      received += text.length;
      tail =
        text.length >= DONE_MARKER.length
          ? text.slice(-DONE_MARKER.length)
          : (tail + text).slice(-DONE_MARKER.length);
      return tail === DONE_MARKER;
    }),
    Stream.runDrain,
  );
  const seconds = Number(nowNs() - startedAt) / 1e9;
  const cpu = process.cpuUsage(cpuBefore);
  return {
    mbps: received / MB / seconds,
    cpuMsPerMB: (cpu.user + cpu.system) / 1000 / (received / MB),
  };
}, Effect.scoped);

type RunnerKind = "loopback" | "docker";

interface Harness {
  readonly hub: RunnerHub.RunnerHub["Service"];
  readonly bundle: RunnerBundle.RunnerBundleInfo;
  readonly port: number;
  readonly image: string;
  readonly runId: string;
  readonly bootCounter: { next: number };
}

const forceGc = (() => {
  NodeV8.setFlagsFromString("--expose-gc");
  return NodeVM.runInNewContext("gc") as () => void;
})();

const docker = Effect.fn("docker")(
  function* (args: ReadonlyArray<string>) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(ChildProcess.make("docker", args, { stdin: "ignore" }));
    const [stdout, stderr, code] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (code !== 0) {
      return yield* Effect.die(
        new Error(`docker ${args.join(" ")} exited ${code}: ${stderr.trim()}`),
      );
    }
    return stdout.trim();
  },
  Effect.scoped,
  Effect.orDie,
);

/**
 * Starts one runner for a new sandbox and returns when `start` has returned, with a fiber that
 * resolves to the connection and the instant the hub answered its `runner.hello`.
 */
const startRunner = Effect.fn("startRunner")(function* (
  harness: Harness,
  kind: RunnerKind,
  options: { readonly mounted: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const boot = harness.bootCounter.next++;
  const sandboxId = SandboxId.make(`sbx_${boot.toString(16).padStart(20, "0")}`);
  const secret = Redacted.value(yield* harness.hub.mintEnrollment(sandboxId, 1).pipe(Effect.orDie));
  const url = `http://127.0.0.1:${harness.port}`;
  const arrived = yield* harness.hub.connection(sandboxId).pipe(
    Effect.map((connection) => ({ connection, at: nowNs() })),
    Effect.orDie,
    Effect.forkScoped,
  );

  let startedAt: bigint;
  if (kind === "loopback") {
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-benchmark-" });
    yield* fs.writeFileString(path.join(stateDir, "enroll"), secret, { mode: 0o600 });
    yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [path.join(harness.bundle.directory, "runner.mjs"), "runner"],
        {
          env: {
            PATH: CHILD_PATH,
            PAIR_RUNNER_URL: url,
            PAIR_SANDBOX_ID: sandboxId,
            PAIR_RUNNER_BUILD: harness.bundle.runnerBuildId,
            PAIR_RUNNER_DIR: stateDir,
            PAIR_AGENT_USER: NodeOS.userInfo().username,
          },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "inherit",
        },
      ),
    );
    startedAt = nowNs();
  } else {
    const name = `pair-bench-${harness.runId}-${boot}`;
    yield* docker([
      "create",
      "--name",
      name,
      "--label",
      `pair.bench=${harness.runId}`,
      "--network",
      "host",
      "--tmpfs",
      "/run/pair-runner:rw,nosuid,nodev,noexec,mode=0700,size=16m",
      ...(options.mounted
        ? ["-v", `${harness.bundle.directory}:/opt/pair-runner/${harness.bundle.runnerBuildId}:ro`]
        : []),
      "-e",
      `PAIR_RUNNER_URL=${url}`,
      "-e",
      `PAIR_SANDBOX_ID=${sandboxId}`,
      "-e",
      `PAIR_RUNNER_BUILD=${harness.bundle.runnerBuildId}`,
      "-e",
      `PAIR_RUNNER_ENROLL=${secret}`,
      harness.image,
    ]);
    // Removed by name: the one this call created, never a match.
    yield* Effect.addFinalizer(() => docker(["rm", "-f", name]).pipe(Effect.ignore));
    yield* docker(["start", name]);
    startedAt = nowNs();
  }
  return { startedAt, arrived: Fiber.join(arrived) };
});

/** A runner that is attached and idle, for as long as the caller's scope lasts. */
const attachedRunner = Effect.fn("attachedRunner")(function* (harness: Harness, kind: RunnerKind) {
  const { arrived } = yield* startRunner(harness, kind, { mounted: true });
  return (yield* arrived).connection;
});

const startupFigure = Effect.fn("startupFigure")(function* (
  harness: Harness,
  kind: RunnerKind,
  mounted: boolean,
  boots: number,
) {
  const times: Array<number> = [];
  for (let i = 0; i < boots; i++) {
    yield* Effect.gen(function* () {
      const { startedAt, arrived } = yield* startRunner(harness, kind, { mounted });
      const { at } = yield* arrived;
      // The hello can beat `docker start` returning on a fast machine: that boot counts as 0.
      times.push(Math.max(0, Number(at - startedAt)));
    }).pipe(Effect.scoped);
  }
  return toMs(percentile(times, 0.5));
});

/** Heap and RSS the server gains per attached idle runner, after a forced GC. */
const memoryPerSandbox = Effect.fn("memoryPerSandbox")(function* (
  harness: Harness,
  kind: RunnerKind,
  runners: number,
) {
  const settle = Effect.sync(() => {
    forceGc();
    return { heap: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss };
  });
  // The first attach pays for lazily loaded code, which is not per-sandbox cost.
  yield* Effect.scoped(attachedRunner(harness, kind));
  const before = yield* settle;
  yield* Effect.forEach(Array.from({ length: runners }), () => attachedRunner(harness, kind));
  yield* Effect.sleep("2 seconds");
  const after = yield* settle;
  return {
    heapMiB: (after.heap - before.heap) / runners / MiB,
    rssMiB: (after.rss - before.rss) / runners / MiB,
  };
}, Effect.scoped);

interface Column {
  readonly startupMountedMs?: number;
  readonly startupFetchedMs?: number;
  readonly stdoutP50Ms: number;
  readonly stdoutP99Ms: number;
  readonly echoP50Ms: number;
  readonly throughputMBps: number;
  readonly cpuMsPerMB: number;
  readonly heapMiB?: number;
  readonly rssMiB?: number;
}

const runCases = Effect.fn("runCases")(function* (target: Target, sizes: Sizes) {
  const stdout = yield* stdoutLatency(target, sizes.stdoutLines);
  const echo = yield* keystrokeEcho(target, sizes.keystrokes);
  const throughput = yield* ptyThroughput(target, sizes.fileMiB);
  return {
    stdoutP50Ms: stdout.p50,
    stdoutP99Ms: stdout.p99,
    echoP50Ms: echo.p50,
    throughputMBps: throughput.mbps,
    cpuMsPerMB: throughput.cpuMsPerMB,
  } satisfies Column;
});

const runnerColumn = Effect.fn("runnerColumn")(function* (
  harness: Harness,
  kind: RunnerKind,
  sizes: Sizes,
  fetched: boolean,
) {
  yield* Console.error(`[${kind}] memory`);
  const memory = yield* memoryPerSandbox(harness, kind, sizes.idleRunners);
  yield* Console.error(`[${kind}] startup`);
  const startupMountedMs = yield* startupFigure(harness, kind, true, sizes.boots);
  const startupFetchedMs = fetched
    ? yield* startupFigure(harness, kind, false, sizes.boots)
    : undefined;
  yield* Console.error(`[${kind}] stdout, echo and throughput`);
  const connection = yield* attachedRunner(harness, kind);
  const cases = yield* runCases(
    remoteTarget(connection, kind === "docker" ? "node" : process.execPath),
    sizes,
  );
  return {
    ...cases,
    startupMountedMs,
    ...(startupFetchedMs === undefined ? {} : { startupFetchedMs }),
    heapMiB: memory.heapMiB,
    rssMiB: memory.rssMiB,
  } satisfies Column;
}, Effect.scoped);

const fmt = (value: number | undefined, digits = 2) =>
  value === undefined ? "n/a" : value.toFixed(digits);

interface Row {
  readonly figure: string;
  readonly pick: (column: Column) => number | undefined;
  /** Stdout latency is shown as added over the local baseline for the two runners. */
  readonly budget: string;
  readonly fails: (value: number) => boolean;
  readonly digits?: number;
}

const ROWS: ReadonlyArray<Row> = [
  {
    figure: "Startup, bundle mounted, p50 (ms)",
    pick: (c) => c.startupMountedMs,
    budget: `<= ${BUDGET.startupMountedMs}`,
    fails: (v) => v > BUDGET.startupMountedMs,
    digits: 0,
  },
  {
    figure: "Startup, bundle fetched, p50 (ms)",
    pick: (c) => c.startupFetchedMs,
    budget: `<= ${BUDGET.startupFetchedMs}`,
    fails: (v) => v > BUDGET.startupFetchedMs,
    digits: 0,
  },
  {
    figure: "Provider stdout added latency, p50 (ms)",
    pick: (c) => c.stdoutP50Ms,
    budget: `<= ${BUDGET.stdoutP50Ms}`,
    fails: (v) => v > BUDGET.stdoutP50Ms,
  },
  {
    figure: "Provider stdout added latency, p99 (ms)",
    pick: (c) => c.stdoutP99Ms,
    budget: `<= ${BUDGET.stdoutP99Ms}`,
    fails: (v) => v > BUDGET.stdoutP99Ms,
  },
  {
    figure: "Keystroke to echo, p50 (ms)",
    pick: (c) => c.echoP50Ms,
    budget: `<= ${BUDGET.echoP50Ms}`,
    fails: (v) => v > BUDGET.echoP50Ms,
  },
  {
    figure: "PTY throughput (MB/s)",
    pick: (c) => c.throughputMBps,
    budget: `>= ${BUDGET.throughputMBps}`,
    fails: (v) => v < BUDGET.throughputMBps,
    digits: 0,
  },
  {
    figure: "Server CPU per MB (ms)",
    pick: (c) => c.cpuMsPerMB,
    budget: `<= ${BUDGET.cpuMsPerMB}`,
    fails: (v) => v > BUDGET.cpuMsPerMB,
  },
  {
    figure: "Server heap per sandbox (MiB)",
    pick: (c) => c.heapMiB,
    budget: `<= ${BUDGET.memoryMiBPerSandbox}`,
    fails: (v) => v > BUDGET.memoryMiBPerSandbox,
  },
  {
    figure: "Server RSS per sandbox (MiB)",
    pick: (c) => c.rssMiB,
    budget: `<= ${BUDGET.memoryMiBPerSandbox}`,
    fails: (v) => v > BUDGET.memoryMiBPerSandbox,
  },
];

const withAddedLatency = (column: Column, local: Column): Column => ({
  ...column,
  stdoutP50Ms: Math.max(0, column.stdoutP50Ms - local.stdoutP50Ms),
  stdoutP99Ms: Math.max(0, column.stdoutP99Ms - local.stdoutP99Ms),
});

const renderTable = (columns: {
  readonly local: Column;
  readonly loopback: Column;
  readonly docker: Column | undefined;
}) => {
  const failures: Array<string> = [];
  const lines = [
    "| Figure | Local | Loopback | Docker | Budget (Docker) | Pass |",
    "| --- | ---: | ---: | ---: | --- | :---: |",
  ];
  for (const row of ROWS) {
    const [local, loopback, docker] = [columns.local, columns.loopback, columns.docker].map(
      (column) => (column === undefined ? undefined : row.pick(column)),
    );
    const failed = docker !== undefined && row.fails(docker);
    if (failed) failures.push(row.figure);
    lines.push(
      `| ${row.figure} | ${fmt(local, row.digits)} | ${fmt(loopback, row.digits)} | ${fmt(docker, row.digits)} | ${row.budget} | ${docker === undefined ? "n/a" : failed ? "FAIL" : "pass"} |`,
    );
  }
  return { table: lines.join("\n"), failures };
};

const program = Effect.fn("runnerBenchmark")(
  function* (options: {
    readonly image: string;
    readonly skipDocker: boolean;
    readonly quick: boolean;
  }) {
    const sizes = options.quick ? QUICK : FULL;
    const useDocker = !options.skipDocker && (yield* HostProcess.Platform) === "linux";
    const services = yield* Layer.build(
      HttpRouter.serve(RunnerRoute.layer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(NodeHttp.createServer, { port: 0, host: "127.0.0.1" }),
        ),
        Layer.provideMerge(
          Layer.mergeAll(
            RunnerHub.layer.pipe(
              // A benchmark registers nothing anywhere a server would route to.
              Layer.provide(WorkspaceHosts.layer.pipe(Layer.provide(NodePtyAdapter.layer))),
              Layer.provideMerge(RunnerGrants.layer),
              Layer.provide(SqlitePersistence.layerMemory),
              Layer.provide(NodeCrypto.layer),
            ),
            // A source build packs a dev bundle once; the temp state dir goes with the run.
            RunnerBundle.layer.pipe(
              Layer.provide(
                ServerConfig.layerTest(process.cwd(), { prefix: "t3-runner-benchmark-" }),
              ),
              Layer.provide(NodeServices.layer),
            ),
          ),
        ),
      ),
    );
    const address = Context.get(services, HttpServer.HttpServer).address;
    if (address._tag === "UnixPathAddress") return yield* Effect.die(new Error("no TCP address"));
    yield* Console.error("[bundle] building");
    const harness: Harness = {
      hub: Context.get(services, RunnerHub.RunnerHub),
      bundle: yield* Context.get(services, RunnerBundle.RunnerBundle).current.pipe(Effect.orDie),
      port: address.port,
      image: options.image,
      runId: String(process.pid),
      bootCounter: { next: 0 },
    };

    yield* Console.error("[local] stdout, echo and throughput");
    const local = yield* localTarget.pipe(
      Effect.flatMap((target) => runCases(target, sizes)),
      Effect.provide(NodePtyAdapter.layer),
    );
    const loopback = withAddedLatency(
      yield* runnerColumn(harness, "loopback", sizes, false),
      local,
    );
    const dockerColumn = useDocker
      ? withAddedLatency(yield* runnerColumn(harness, "docker", sizes, true), local)
      : undefined;

    const { table, failures } = renderTable({ local, loopback, docker: dockerColumn });
    yield* Console.log(
      [
        table,
        "",
        `Runner build ${harness.bundle.runnerBuildId.slice(0, 12)}, ${NodeOS.cpus().length} CPUs, ` +
          `image ${useDocker ? options.image : "not run"}${options.quick ? ", QUICK sizes (not comparable)" : ""}.`,
        "Stdout latency is receipt minus child stamp, minus the local baseline (local itself is absolute).",
      ].join("\n"),
    );
    if (failures.length > 0) {
      yield* Console.error(`Over budget on Docker: ${failures.join("; ")}`);
      process.exitCode = 1;
    }
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  // Migrations and every runner connect log at info.
  Effect.provideService(References.MinimumLogLevel, "Warn"),
);

const cli = Command.make(
  "runner-benchmark",
  {
    image: Flag.String("image").pipe(
      Flag.withDefault("t3-sandbox:dev"),
      Flag.withDescription("Sandbox image for the Docker runner (the sandbox.baseImage override)."),
    ),
    skipDocker: Flag.Boolean("skip-docker").pipe(Flag.withDefault(false)),
    quick: Flag.Boolean("quick").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Small sizes for a smoke run; the figures are not comparable."),
    ),
  },
  program,
).pipe(
  Command.withDescription(
    "Measure runner latency, throughput, memory and startup against the 03 section 9 budgets.",
  ),
);

if (import.meta.main) {
  Command.run(cli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
