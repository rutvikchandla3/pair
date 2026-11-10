import {
  type DiscoveredLocalServer,
  type DiscoveredLocalServerList,
  PreviewStopLocalServerError,
  type PreviewStopLocalServerInput,
  type SandboxId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { parseProcessTable, stoppableProcessGroup } from "../../preview/PortScanner.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { threadWorkspaceRoot } from "../../project/threadWorkspaceRoot.ts";
import type { WorkspaceHost } from "../../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";
import { RunnerHub } from "../runnerHub/RunnerHub.ts";
import { MachineBrowser } from "./MachineBrowser.ts";

/**
 * The servers listening in a thread's machine, from the runner's own scan (07 §5, 7.5). Only a
 * cloud-only server routes here; every other server scans its own ports.
 */
export class MachinePorts extends Context.Service<
  MachinePorts,
  {
    /**
     * A snapshot, then one on each change. Empty while the machine sleeps or has no runner, and
     * resumed from the new runner's scan on each wake, so one subscription outlives a sleep.
     */
    readonly listen: (input: {
      readonly threadId: ThreadId;
      readonly configuredUrls: ReadonlyArray<string>;
    }) => Stream.Stream<DiscoveredLocalServerList>;
    /** Stops a server that the machine's scan lists now; never the runner, an agent or a shell. */
    readonly stop: (
      input: PreviewStopLocalServerInput & { readonly threadId: ThreadId },
    ) => Effect.Effect<void, PreviewStopLocalServerError>;
  }
>()("t3/sandbox/browser/MachinePorts") {}

// `$PPID` of a shell the runner spawns is the runner: its own spawns exec in place (setpriv).
const PROCESS_TABLE_SCRIPT = 'echo "$PPID"; exec ps -A -o pid=,ppid=,pgid=';
const PROCESS_TABLE_TIMEOUT = Duration.seconds(5);

const notFound = () => new PreviewStopLocalServerError({ reason: "not-found" });
const signalFailed = (cause: unknown) =>
  new PreviewStopLocalServerError({ reason: "signal-failed", cause });

const isNoSuchProcess = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ESRCH";

export const make = Effect.fn("MachinePorts.make")(function* (
  workspaceRoot: (threadId: ThreadId) => Effect.Effect<string | undefined>,
) {
  const hub = yield* RunnerHub;
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  // Only a cloud-only server runs machine browsers.
  const browser = yield* Effect.serviceOption(MachineBrowser);
  // The machine's Chrome is not a member's server: never listed, never stopped from here.
  const browserPid = (sandboxId: SandboxId) =>
    Option.isSome(browser) ? browser.value.processId(sandboxId) : Effect.undefined;

  const machineOf = Effect.fn("MachinePorts.machineOf")(function* (threadId: ThreadId) {
    const root = yield* workspaceRoot(threadId);
    const sandboxId = root === undefined ? undefined : WorkspaceHosts.sandboxOfPath(root);
    return root === undefined || sandboxId === undefined || sandboxId === "local"
      ? undefined
      : { root, sandboxId };
  });

  const processTable = Effect.fn("MachinePorts.processTable")(function* (host: WorkspaceHost) {
    const result = yield* processRunner.run({
      command: "/bin/sh",
      args: ["-c", PROCESS_TABLE_SCRIPT],
      timeout: PROCESS_TABLE_TIMEOUT,
      host,
    });
    const [first = "", ...rows] = result.stdout.split("\n");
    const runnerPid = Number(first.trim());
    // A failed `ps` must not read as every process having exited.
    if (result.code !== 0 || !Number.isInteger(runnerPid) || runnerPid < 1) {
      return yield* signalFailed(result.stderr);
    }
    return { runnerPid, table: parseProcessTable(rows.join("\n")) };
  });

  const emptyList = Effect.map(DateTime.now, (now): DiscoveredLocalServerList => ({
    servers: [],
    scannedAt: DateTime.formatIso(now),
  }));

  const listenOnBoot = (
    machine: { readonly root: string; readonly sandboxId: SandboxId },
    threadId: ThreadId,
    configuredUrls: ReadonlyArray<string>,
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const host = yield* hosts.forPath(machine.root);
        if (host.invoke === undefined) return Stream.fromEffect(emptyList);
        const { runnerPid } = yield* processTable(host);
        // The runner leaves thread fields empty; a listener nobody claimed is the thread's.
        const own = (server: DiscoveredLocalServer): DiscoveredLocalServer =>
          server.terminal === null && (server.agent ?? null) === null
            ? { ...server, agent: { threadId } }
            : server;
        return host.invoke.portListeners(configuredUrls).pipe(
          Stream.mapEffect((servers) =>
            Effect.gen(function* () {
              const chromePid = yield* browserPid(machine.sandboxId);
              return {
                // The runner's own listeners (its MCP forward) are not the agent's servers.
                servers: servers
                  .filter((server) => server.pid !== runnerPid && server.pid !== chromePid)
                  .map(own),
                scannedAt: DateTime.formatIso(yield* DateTime.now),
                configuredUrlProbing: true as const,
              };
            }),
          ),
        );
      }),
    ).pipe(
      // A lost runner reads as a sleeping machine until the next boot's status arrives.
      Stream.catch((cause) =>
        Stream.fromEffect(
          Effect.logDebug("machine port listing ended", { cause }).pipe(Effect.andThen(emptyList)),
        ),
      ),
    );

  const listen: MachinePorts["Service"]["listen"] = ({ threadId, configuredUrls }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const machine = yield* machineOf(threadId);
        if (machine === undefined) return Stream.fromEffect(emptyList);
        return hub.status(machine.sandboxId).pipe(
          // A reconnect keeps its boot; the listing resumes with the socket or restarts below.
          Stream.filter((status) => status._tag !== "reconnecting"),
          Stream.switchMap((status) =>
            status._tag === "connected"
              ? listenOnBoot(machine, threadId, configuredUrls)
              : Stream.fromEffect(emptyList),
          ),
        );
      }),
    );

  const stop: MachinePorts["Service"]["stop"] = Effect.fn("MachinePorts.stop")(function* (input) {
    const machine = yield* machineOf(input.threadId);
    if (machine === undefined) return yield* notFound();
    const host = yield* hosts.forPath(machine.root).pipe(Effect.mapError(notFound));
    if (host.invoke === undefined) return yield* notFound();
    if (input.pid === (yield* browserPid(machine.sandboxId))) return yield* notFound();
    // The pid comes from a client: only a server the machine's own scan lists now is signaled.
    const listing = yield* Stream.runHead(host.invoke.portListeners([])).pipe(
      Effect.mapError(signalFailed),
    );
    const listed = Option.getOrElse(listing, () => []).some(
      (server) => server.pid === input.pid && server.port === input.port,
    );
    if (!listed) return yield* notFound();
    const { runnerPid, table } = yield* processTable(host).pipe(
      Effect.mapError((error) =>
        error._tag === "PreviewStopLocalServerError" ? error : signalFailed(error),
      ),
    );
    // It exited after the scan, so there is nothing left to stop.
    if (!table.has(input.pid)) return;
    const group = stoppableProcessGroup(table, input.pid, runnerPid);
    if (group === null) return yield* new PreviewStopLocalServerError({ reason: "shared-group" });
    yield* host.processes
      .signalGroup(group, "SIGTERM")
      .pipe(
        Effect.catch((error) =>
          isNoSuchProcess(error.cause) ? Effect.void : Effect.fail(signalFailed(error.cause)),
        ),
      );
  });

  return MachinePorts.of({ listen, stop });
});

export const layer = Layer.effect(
  MachinePorts,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      ThreadManagementService.ThreadManagementService | ProjectService.ProjectService
    >();
    return yield* make((threadId) => threadWorkspaceRoot(threadId).pipe(Effect.provide(context)));
  }),
);
