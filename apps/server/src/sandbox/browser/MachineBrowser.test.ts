// @effect-diagnostics nodeBuiltinImport:off -- the bridge is a node:net listener; the tests dial it.
import * as NodeNet from "node:net";

import { expect, it } from "@effect/vitest";
import { type ComputeDriverKind, SandboxId } from "@t3tools/contracts";
import { RunnerUnsupportedError } from "@t3tools/contracts/runner";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import { PREVIEW_BROWSER_ARGS } from "../../preview/ServerBrowserContexts.ts";
import {
  SANDBOX_ROOT,
  type WorkspaceHost,
  type WorkspaceHostId,
  type WorkspaceHostInfo,
  type WorkspaceHostTcpConnection,
} from "../../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";
import * as WorkspaceHostTesting from "../../workspaceHost/WorkspaceHostTesting.ts";
import type { RunnerConnection } from "../runnerHub/RunnerConnection.ts";
import { RunnerHub, RunnerUnavailableError } from "../runnerHub/RunnerHub.ts";
import * as MachineBrowser from "./MachineBrowser.ts";

const sandboxA = SandboxId.make("sbx_aaaaaaaaaaaaaaaaaaaa");
const sandboxB = SandboxId.make("sbx_bbbbbbbbbbbbbbbbbbbb");

const info: WorkspaceHostInfo = {
  platform: "linux",
  architecture: "x64",
  homeDirectory: "/home/t3",
  // The machine's base environment carries the server's git identity; Chrome must not.
  environment: {
    PATH: "/usr/bin",
    HOME: "/home/t3",
    LANG: "C.UTF-8",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "Ada",
  },
  userId: 1000,
  executablePath: "/opt/pair-runner/build/t3",
};

interface FakeChrome {
  readonly sandboxId: SandboxId;
  readonly pid: number;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, unknown>>;
  readonly guid: string;
  readonly stderr: Queue.Queue<string, Cause.Done>;
  readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
  /** The spawn's scope closed: on a machine, the runner kills the group. */
  readonly killed: Deferred.Deferred<void>;
}

const devtoolsLine = (chrome: FakeChrome) =>
  `DevTools listening on ws://127.0.0.1:9222/devtools/browser/${chrome.guid}`;

const setup = Effect.fnUntraced(function* (
  kinds: Readonly<Record<string, ComputeDriverKind>> = {},
) {
  const spawned = yield* Queue.unbounded<FakeChrome>();
  let spawns = 0;
  const boots = new Map<SandboxId, RunnerConnection>();
  const layer = Layer.mock(RunnerHub)({
    connection: (sandboxId) => {
      const connection = boots.get(sandboxId);
      return connection === undefined
        ? Effect.fail(new RunnerUnavailableError({ sandboxId }))
        : Effect.succeed(connection);
    },
  }).pipe(Layer.provideMerge(WorkspaceHostTesting.layerFromContext));
  const scope = yield* Scope.make();
  const { browser, hosts } = yield* Effect.gen(function* () {
    return {
      browser: yield* MachineBrowser.make((sandboxId) => Effect.succeed(kinds[sandboxId])),
      hosts: yield* WorkspaceHosts.WorkspaceHosts,
    };
  }).pipe(Effect.provide(layer), Scope.provide(scope));

  /** One runner boot of a machine whose Chrome, when `auto`, prints its address at once. */
  const boot = Effect.fnUntraced(function* (
    sandboxId: SandboxId,
    options: {
      readonly installed?: boolean;
      readonly unsupported?: boolean;
      readonly auto?: boolean;
    } = {},
  ) {
    const ended = yield* Deferred.make<void>();
    // MachineBrowser reads only the boot's end from its connection.
    const connection = { ended: Deferred.await(ended) } as Partial<RunnerConnection>;
    const dials: Array<number> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* Effect.die("piped");
        const index = spawns++;
        const chrome: FakeChrome = {
          sandboxId,
          pid: 700 + index,
          args: command.args.map((arg) => (Redacted.isRedacted(arg) ? Redacted.value(arg) : arg)),
          env: command.options.env ?? {},
          guid: `guid-${sandboxId.slice(-1)}-${index}`,
          stderr: yield* Queue.unbounded<string, Cause.Done>(),
          exit: yield* Deferred.make<ChildProcessSpawner.ExitCode>(),
          killed: yield* Deferred.make<void>(),
        };
        yield* Effect.addFinalizer(() => Deferred.succeed(chrome.killed, undefined));
        if (options.auto !== false) {
          yield* Queue.offerAll(chrome.stderr, ["[WARNING] fontconfig", devtoolsLine(chrome)]);
        }
        yield* Queue.offer(spawned, chrome);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(chrome.pid),
          exitCode: Deferred.await(chrome.exit),
          isRunning: Effect.map(Deferred.isDone(chrome.exit), (done) => !done),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.fromQueue(chrome.stderr).pipe(
            Stream.map((line) => `${line}\n`),
            Stream.encodeText,
          ),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    // Chrome stand-in: echoes each write back, tagged with its machine.
    const connect = (port: number) =>
      Effect.gen(function* () {
        if (options.unsupported === true) {
          return yield* new RunnerUnsupportedError({ method: "tcp.connect" });
        }
        dials.push(port);
        const queue = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        yield* Effect.addFinalizer(() => Queue.shutdown(queue));
        const tag = new TextEncoder().encode(`${sandboxId}|`);
        return {
          read: Stream.fromQueue(queue),
          write: (data) => Queue.offer(queue, Buffer.concat([tag, data])).pipe(Effect.asVoid),
          close: Queue.end(queue).pipe(Effect.asVoid),
        } satisfies WorkspaceHostTcpConnection;
      });
    const host: WorkspaceHost = {
      ...hosts.local,
      id: sandboxId as string as WorkspaceHostId,
      kind: "sandbox",
      info: Effect.succeed(info),
      fileSystem: FileSystem.makeNoop({ exists: () => Effect.succeed(options.installed ?? true) }),
      spawner,
      ports: { connect },
    };
    const bootScope = yield* Scope.make();
    yield* hosts.register(`${SANDBOX_ROOT}/${sandboxId}`, host).pipe(Scope.provide(bootScope));
    boots.set(sandboxId, connection as RunnerConnection);
    const sleep = Effect.sync(() => boots.delete(sandboxId)).pipe(
      Effect.andThen(Scope.close(bootScope, Exit.void)),
      Effect.andThen(Deferred.succeed(ended, undefined)),
    );
    return { dials, sleep };
  });

  return { browser, boot, spawned, shutdown: Scope.close(scope, Exit.void) };
});

const reasonOf = <A>(effect: Effect.Effect<A, MachineBrowser.MachineBrowserError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

/** Writes `request`, half-closes, and reads to EOF. */
const exchange = (port: number, request: string) =>
  Effect.callback<string, Error>((resume) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port });
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.once("end", () => resume(Effect.succeed(response)));
    socket.once("error", (error) => resume(Effect.fail(error)));
    socket.once("connect", () => socket.end(request));
    return Effect.sync(() => socket.destroy());
  });

const portOf = (endpoint: string) => Number(new URL(endpoint).port);
const pathOf = (endpoint: string) => new URL(endpoint).pathname;
const upgrade = (path: string) => `GET ${path} HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n`;

it.effect("starts one Chrome for concurrent calls, as the agent user's base environment", () =>
  Effect.gen(function* () {
    const { browser, boot, spawned } = yield* setup({ [sandboxA]: "gce", [sandboxB]: "docker" });
    yield* boot(sandboxA);
    yield* boot(sandboxB);

    const [first, second] = yield* Effect.all(
      [browser.endpoint(sandboxA), browser.endpoint(sandboxA)],
      { concurrency: "unbounded" },
    );
    expect(first).toBe(second);
    const chrome = yield* Queue.take(spawned);
    expect(yield* Queue.size(spawned)).toBe(0);
    // The bridge's port on the server, Chrome's own path.
    expect(first).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/guid-a-0$/);
    expect(portOf(first)).not.toBe(9222);
    expect(yield* browser.processId(sandboxA)).toBe(chrome.pid);

    expect(chrome.args).toEqual([
      "--remote-debugging-port=0",
      `--user-data-dir=${SANDBOX_ROOT}/${sandboxA}/browser/profile`,
      ...PREVIEW_BROWSER_ARGS,
    ]);
    expect(chrome.env).toEqual({ PATH: "/usr/bin", HOME: "/home/t3", LANG: "C.UTF-8" });

    // Docker forbids the user namespaces Chrome's sandbox needs.
    yield* browser.endpoint(sandboxB);
    expect((yield* Queue.take(spawned)).args).toContain("--no-sandbox");
  }),
);

it.effect("refuses a machine without a browser, a sleeping one and an old runner", () =>
  Effect.gen(function* () {
    const { browser, boot, spawned } = yield* setup();
    expect(yield* reasonOf(browser.endpoint(sandboxA))).toBe("machine-unavailable");

    yield* boot(sandboxA, { installed: false });
    expect(yield* reasonOf(browser.endpoint(sandboxA))).toBe("not-installed");
    expect(yield* Queue.size(spawned)).toBe(0);

    yield* boot(sandboxB, { unsupported: true });
    expect(yield* reasonOf(browser.endpoint(sandboxB))).toBe("runner-outdated");
    // The Chrome it started is not left running.
    yield* Deferred.await((yield* Queue.take(spawned)).killed);
    expect(yield* browser.processId(sandboxB)).toBeUndefined();
  }),
);

it.effect("fails with Chrome's stderr when it exits early, and starts afresh next time", () =>
  Effect.gen(function* () {
    const { browser, boot, spawned } = yield* setup();
    yield* boot(sandboxA, { auto: false });
    const call = yield* browser.endpoint(sandboxA).pipe(Effect.flip, Effect.forkChild);
    const chrome = yield* Queue.take(spawned);
    yield* Queue.offer(chrome.stderr, "error while loading shared libraries: libnss3.so");
    yield* Queue.end(chrome.stderr);
    yield* Deferred.succeed(chrome.exit, ChildProcessSpawner.ExitCode(127));
    const error = yield* Fiber.join(call);
    expect(error.reason).toBe("launch-failed");
    expect(error.message).toContain("libnss3.so");

    const retry = yield* browser.endpoint(sandboxA).pipe(Effect.forkChild);
    const next = yield* Queue.take(spawned);
    yield* Queue.offer(next.stderr, devtoolsLine(next));
    expect(pathOf(yield* Fiber.join(retry))).toBe(`/devtools/browser/${next.guid}`);
  }),
);

it.effect("gives up after 30 seconds without a DevTools address and stops Chrome", () =>
  Effect.gen(function* () {
    const { browser, boot, spawned } = yield* setup();
    yield* boot(sandboxA, { auto: false });
    const call = yield* browser.endpoint(sandboxA).pipe(Effect.flip, Effect.forkChild);
    const chrome = yield* Queue.take(spawned);
    yield* Queue.offer(chrome.stderr, "still starting");
    yield* TestClock.adjust("30 seconds");
    const error = yield* Fiber.join(call);
    expect(error.reason).toBe("launch-failed");
    expect(error.message).toContain("still starting");
    yield* Deferred.await(chrome.killed);
  }),
);

it.effect("drops a Chrome that exits by itself, so the next call starts another", () =>
  Effect.gen(function* () {
    const { browser, boot, spawned } = yield* setup();
    yield* boot(sandboxA);
    const first = yield* browser.endpoint(sandboxA);
    const chrome = yield* Queue.take(spawned);
    yield* Queue.end(chrome.stderr);
    yield* Deferred.succeed(chrome.exit, ChildProcessSpawner.ExitCode(0));
    yield* Deferred.await(chrome.killed);
    expect(yield* browser.processId(sandboxA)).toBeUndefined();

    const second = yield* browser.endpoint(sandboxA);
    expect(second).not.toBe(first);
    expect((yield* Queue.take(spawned)).pid).not.toBe(chrome.pid);
  }),
);

it.live("bridges only Chrome's own WebSocket path, to its own machine", () =>
  Effect.gen(function* () {
    const { browser, boot } = yield* setup();
    const a = yield* boot(sandboxA);
    const b = yield* boot(sandboxB);
    const endpointA = yield* browser.endpoint(sandboxA);
    const endpointB = yield* browser.endpoint(sandboxB);
    // One dial each to check the runner can carry it.
    expect([a.dials, b.dials]).toEqual([[9222], [9222]]);

    const reply = yield* exchange(portOf(endpointA), upgrade(pathOf(endpointA)));
    expect(reply).toBe(`${sandboxA}|${upgrade(pathOf(endpointA))}`);

    // Chrome's `/json` pages and another machine's path never reach a machine.
    for (const path of ["/json/version", pathOf(endpointB), `${pathOf(endpointA)}x`]) {
      expect(yield* exchange(portOf(endpointA), upgrade(path))).toMatch(/^HTTP\/1\.1 404 /);
    }
    expect([a.dials, b.dials]).toEqual([[9222, 9222], [9222]]);
  }),
);

it.live("a sleep kills Chrome and closes the bridge; the next boot gets a fresh browser", () =>
  Effect.gen(function* () {
    const { browser, boot, spawned } = yield* setup();
    const first = yield* boot(sandboxA);
    const before = yield* browser.endpoint(sandboxA);
    const chrome = yield* Queue.take(spawned);

    yield* first.sleep;
    yield* Deferred.await(chrome.killed);
    const refused = yield* exchange(portOf(before), upgrade(pathOf(before))).pipe(Effect.flip);
    expect(refused.message).toContain("ECONNREFUSED");
    expect(yield* reasonOf(browser.endpoint(sandboxA))).toBe("machine-unavailable");

    yield* boot(sandboxA);
    const after = yield* browser.endpoint(sandboxA);
    expect(after).not.toBe(before);
    expect(yield* exchange(portOf(after), upgrade(pathOf(after)))).toBe(
      `${sandboxA}|${upgrade(pathOf(after))}`,
    );
  }),
);

it.effect("stops every machine's Chrome when the server shuts down", () =>
  Effect.gen(function* () {
    const { browser, boot, spawned, shutdown } = yield* setup();
    yield* boot(sandboxA);
    yield* boot(sandboxB);
    yield* browser.endpoint(sandboxA);
    yield* browser.endpoint(sandboxB);
    const chromes = [yield* Queue.take(spawned), yield* Queue.take(spawned)];
    yield* shutdown;
    yield* Effect.forEach(chromes, (chrome) => Deferred.await(chrome.killed));
  }),
);
