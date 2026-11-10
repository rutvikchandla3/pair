import { expect, it } from "@effect/vitest";
import {
  type DiscoveredLocalServer,
  type DiscoveredLocalServerList,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import { RUNNER_PROTOCOL_VERSION, type RunnerInfo } from "@t3tools/contracts/runner";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../../processRunner.ts";
import {
  type CoarseOperations,
  SANDBOX_ROOT,
  type WorkspaceHost,
  type WorkspaceHostId,
} from "../../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";
import * as WorkspaceHostTesting from "../../workspaceHost/WorkspaceHostTesting.ts";
import { RunnerHub, type RunnerConnectionStatus } from "../runnerHub/RunnerHub.ts";
import { MachineBrowser } from "./MachineBrowser.ts";
import * as MachinePorts from "./MachinePorts.ts";

const sandboxId = SandboxId.make("sbx_aaaaaaaaaaaaaaaaaaaa");
const threadId = ThreadId.make("thread-cloud");
const forkId = ThreadId.make("thread-fork");
const checkout = `${SANDBOX_ROOT}/${sandboxId}/repo`;

const RUNNER_PID = 50;
// The runner's children lead their own groups: a terminal shell (100) whose job (200) has its
// own group, and an agent (300) whose tool server (301) shares the agent's.
const PROCESS_TABLE = [
  "1 0 1",
  `${RUNNER_PID} 1 ${RUNNER_PID}`,
  `100 ${RUNNER_PID} 100`,
  "200 100 200",
  `300 ${RUNNER_PID} 300`,
  "301 300 300",
].join("\n");

const server = (port: number, pid: number, owner: Partial<DiscoveredLocalServer> = {}) =>
  ({
    host: "localhost",
    port,
    url: `http://localhost:${port}`,
    processName: "node",
    pid,
    terminal: null,
    ...owner,
  }) satisfies DiscoveredLocalServer;

const terminalServer = server(3000, 200);
const agentServer = server(3001, 301);
const forkServer = server(5173, 400, { agent: { threadId: forkId } });
const runnerForward = server(41000, RUNNER_PID);
const CHROME_PID = 700;
const chromeDebugging = server(40123, CHROME_PID, { processName: "chrome-headless-shell" });

const unused = () => Effect.die("unused");

const setup = Effect.fnUntraced(function* () {
  const status = yield* SubscriptionRef.make<RunnerConnectionStatus>({ _tag: "absent" });
  const signals: Array<readonly [number, NodeJS.Signals]> = [];
  const layer = Layer.mergeAll(
    Layer.mock(RunnerHub)({ status: () => SubscriptionRef.changes(status) }),
    Layer.mock(MachineBrowser)({
      processId: (id) => Effect.succeed(id === sandboxId ? CHROME_PID : undefined),
    }),
    Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({
        run: () =>
          Effect.succeed({
            stdout: `${RUNNER_PID}\n${PROCESS_TABLE}\n`,
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
      }),
    ),
  ).pipe(Layer.provideMerge(WorkspaceHostTesting.layerFromContext));
  const { ports, hosts } = yield* Effect.gen(function* () {
    return {
      ports: yield* MachinePorts.make((id) =>
        Effect.succeed(id === threadId ? checkout : "/home/ada/repo"),
      ),
      hosts: yield* WorkspaceHosts.WorkspaceHosts,
    };
  }).pipe(Effect.provide(layer));

  /** One runner boot: registers its host, then reports it connected, as the hub does. */
  const boot = Effect.fnUntraced(function* (
    runnerBootId: string,
    initial: ReadonlyArray<DiscoveredLocalServer>,
  ) {
    const listing = yield* SubscriptionRef.make(initial);
    const invoke: CoarseOperations = {
      searchEntries: unused,
      searchContents: unused,
      listEntries: unused,
      refreshSearch: unused,
      processTable: unused(),
      portListeners: () => SubscriptionRef.changes(listing),
      checkpointCapture: unused,
    };
    const host: WorkspaceHost = {
      ...hosts.local,
      id: sandboxId as string as WorkspaceHostId,
      kind: "sandbox",
      invoke,
      processes: {
        signalGroup: (pid, signal) => Effect.sync(() => void signals.push([pid, signal])),
      },
    };
    const scope = yield* Scope.make();
    yield* hosts.register(`${SANDBOX_ROOT}/${sandboxId}`, host).pipe(Scope.provide(scope));
    yield* SubscriptionRef.set(status, {
      _tag: "connected",
      generation: 1,
      runnerBootId,
      info: { ...runnerInfo, runnerBootId },
    });
    const sleep = Scope.close(scope, Exit.void).pipe(
      Effect.andThen(SubscriptionRef.set(status, { _tag: "lost", runnerBootId })),
    );
    return { listing, sleep };
  });

  return { ports, boot, signals };
});

const runnerInfo: RunnerInfo = {
  runnerBootId: "boot",
  runnerBuildId: "build",
  protocolVersion: RUNNER_PROTOCOL_VERSION,
  arch: "x64",
  cpus: 2,
  memoryBytes: 1024,
  agent: { uid: 1000, homeDirectory: "/home/t3", shell: "/bin/bash" },
  tmpDirectory: "/tmp",
  bundleDirectory: "/opt/pair-runner/build",
  imageEnvironment: {},
  handles: [],
};

const ports = (list: DiscoveredLocalServerList) => list.servers.map((entry) => entry.port);

it.effect("lists a machine's servers in order, empty across a sleep, then the new boot's", () =>
  Effect.gen(function* () {
    const { ports: machinePorts, boot } = yield* setup();
    const lists = yield* Queue.unbounded<DiscoveredLocalServerList>();
    yield* machinePorts.listen({ threadId, configuredUrls: [] }).pipe(
      Stream.runForEach((list) => Queue.offer(lists, list)),
      Effect.forkChild,
    );

    // No runner yet: an empty list, not an error.
    expect((yield* Queue.take(lists)).servers).toEqual([]);

    const first = yield* boot("boot-1", [
      terminalServer,
      forkServer,
      runnerForward,
      chromeDebugging,
    ]);
    const snapshot = yield* Queue.take(lists);
    // The runner's own forward and the machine's browser are dropped; an unclaimed listener
    // becomes the thread's.
    expect(snapshot.servers).toEqual([{ ...terminalServer, agent: { threadId } }, forkServer]);
    yield* SubscriptionRef.set(first.listing, [terminalServer, agentServer]);
    expect(ports(yield* Queue.take(lists))).toEqual([3000, 3001]);

    yield* first.sleep;
    expect((yield* Queue.take(lists)).servers).toEqual([]);

    yield* boot("boot-2", [agentServer]);
    expect(ports(yield* Queue.take(lists))).toEqual([3001]);
  }),
);

it.effect("gives a thread with no machine one empty list", () =>
  Effect.gen(function* () {
    const { ports: machinePorts } = yield* setup();
    const lists = yield* Stream.runCollect(
      machinePorts.listen({ threadId: forkId, configuredUrls: [] }),
    );
    expect(lists.map((list) => list.servers)).toEqual([[]]);
  }),
);

it.effect("stops only a listed server, by its own group, never the runner or an agent", () =>
  Effect.gen(function* () {
    const { ports: machinePorts, boot, signals } = yield* setup();
    const reason = (pid: number, port: number) =>
      machinePorts.stop({ threadId, pid, port }).pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      );

    // Asleep, nothing is listed.
    expect(yield* reason(200, 3000)).toBe("not-found");

    yield* boot("boot-1", [terminalServer, agentServer, runnerForward, chromeDebugging]);
    // The machine's browser is not a member's server, though the scan lists it.
    expect(yield* reason(CHROME_PID, 40123)).toBe("not-found");
    // A pid or a port the machine's scan does not list.
    expect(yield* reason(100, 3000)).toBe("not-found");
    expect(yield* reason(200, 3001)).toBe("not-found");
    // Listed, but its group holds the runner, or an agent the runner started.
    expect(yield* reason(RUNNER_PID, 41000)).toBe("shared-group");
    expect(yield* reason(301, 3001)).toBe("shared-group");
    // A thread with no machine stops nothing.
    expect(
      yield* machinePorts.stop({ threadId: forkId, pid: 200, port: 3000 }).pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      ),
    ).toBe("not-found");
    expect(signals).toEqual([]);

    yield* machinePorts.stop({ threadId, pid: 200, port: 3000 });
    expect(signals).toEqual([[200, "SIGTERM"]]);
  }),
);
