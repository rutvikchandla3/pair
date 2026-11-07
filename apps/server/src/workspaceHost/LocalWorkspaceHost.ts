// @effect-diagnostics nodeBuiltinImport:off -- the local host is the one place thread-scoped node:fs is allowed
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";

import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  LOCAL_WORKSPACE_HOST_ID,
  type WorkspaceFileKind,
  type ProcessGroupHooks,
  type ProcessGroupProcess,
  type ProcessGroupSpawnInput,
  type WorkspaceHost,
  WorkspaceHostFileError,
  type WorkspaceHostFiles,
  type WorkspaceHostInfo,
} from "./WorkspaceHost.ts";

const fileError =
  (operation: WorkspaceHostFileError["operation"]) =>
  (cause: unknown): WorkspaceHostFileError =>
    new WorkspaceHostFileError({
      operation,
      code: (cause as NodeJS.ErrnoException | undefined)?.code,
      cause,
    });

const fileKind = (entry: NodeFS.Dirent | NodeFS.Stats): WorkspaceFileKind => {
  if (entry.isFile()) return "File";
  if (entry.isDirectory()) return "Directory";
  return entry.isSymbolicLink() ? "SymbolicLink" : "Other";
};

const files: WorkspaceHostFiles = {
  realPath: (path) =>
    Effect.tryPromise({ try: () => NodeFSP.realpath(path), catch: fileError("realpath") }),
  lstat: (path) =>
    Effect.tryPromise({
      try: async () => ({ kind: fileKind(await NodeFSP.lstat(path)) }),
      catch: fileError("lstat"),
    }),
  readDirectory: (path) =>
    Effect.tryPromise({
      try: async () =>
        (await NodeFSP.readdir(path, { withFileTypes: true })).map((dirent) => ({
          name: dirent.name,
          kind: fileKind(dirent),
        })),
      catch: fileError("readdir"),
    }),
  readFile: (path, maxBytes) =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        // Non-blocking opens prevent FIFO hangs before stat rejects them; Windows lacks the flag.
        try: () =>
          NodeFSP.open(path, NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0)),
        catch: fileError("open"),
      }),
      (handle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: fileError("stat"),
          });
          if (!stat.isFile()) return { kind: "not-file" } as const;
          const bytesToRead = Math.min(stat.size, maxBytes);
          const buffer = Buffer.alloc(bytesToRead);
          let offset = 0;
          while (offset < bytesToRead) {
            const { bytesRead } = yield* Effect.tryPromise({
              try: () => handle.read(buffer, offset, bytesToRead - offset, offset),
              catch: fileError("read"),
            });
            if (bytesRead <= 0) break;
            offset += bytesRead;
          }
          return { kind: "file", size: stat.size, bytes: buffer.subarray(0, offset) } as const;
        }),
      (handle) => Effect.tryPromise({ try: () => handle.close(), catch: fileError("close") }),
    ),
  writeNoFollow: (path, contents) =>
    Effect.tryPromise({
      // Windows lacks O_NOFOLLOW.
      try: () =>
        NodeFSP.writeFile(path, contents, {
          flag:
            NodeFS.constants.O_WRONLY |
            NodeFS.constants.O_CREAT |
            NodeFS.constants.O_TRUNC |
            (NodeFS.constants.O_NOFOLLOW ?? 0),
        }),
      catch: fileError("write"),
    }),
};

const CLAUDE_GROUP_WATCH_SCRIPT = [
  "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &",
  'exec "$@" 3<&-',
].join("\n");

/**
 * Kill the CLI's group on exit to stop MCP grandchildren; `onExit` stops its agent scope for
 * setsid daemons. The CLI keeps working after its pipes close, so a watcher stops the group on
 * EOF from a pipe only this server holds, including when the server crashes.
 */
export function spawnProcessGroup(
  options: ProcessGroupSpawnInput,
  onExit?: () => void,
  onStderr: (text: string) => void = () => {},
  onStderrClose: () => void = () => {},
): ProcessGroupProcess {
  const child = NodeChildProcess.spawn(
    "/bin/sh",
    ["-c", CLAUDE_GROUP_WATCH_SCRIPT, "t3-claude", options.command, ...options.args],
    {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      detached: true,
    },
  );
  // Always drained, so a chatty CLI never blocks on a full stderr pipe.
  child.stderr?.setEncoding("utf8").on("data", onStderr).once("close", onStderrClose);
  child.once("exit", () => {
    try {
      signalProcessGroup(child.pid ?? 0, "SIGKILL");
    } catch {}
    onExit?.();
  });
  // Node's typings make stdin and stdout nullable once stdio has a fourth entry; both are pipes.
  return child as ProcessGroupProcess;
}

// Windows has no process groups to watch.
const spawnWindowsProcess = (
  options: ProcessGroupSpawnInput,
  hooks: ProcessGroupHooks,
): ProcessGroupProcess => {
  const child = NodeChildProcess.spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8").on("data", hooks.onStderr).once("close", hooks.onStderrClose);
  return child;
};

/** The server's own machine, assembled from the context's services. No I/O, no state. */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const pty = yield* PtyAdapter.PtyAdapter;
  const agentScope = yield* AgentScope;
  // The server's own platform, which is this host's by definition.
  const platform = yield* HostProcess.Platform;
  // Reads the references when `info` runs, so a per-call override still applies.
  const info: Effect.Effect<WorkspaceHostInfo> = Effect.gen(function* () {
    return {
      platform: yield* HostProcess.Platform,
      architecture: yield* HostProcess.Architecture,
      homeDirectory: yield* HostProcess.HomeDirectory,
      environment: yield* HostProcess.Environment,
      userId: yield* HostProcess.UserId,
      executablePath: yield* HostProcess.ExecutablePath,
    };
  });
  return {
    id: LOCAL_WORKSPACE_HOST_ID,
    kind: "local",
    info,
    spawner,
    fileSystem,
    pty,
    agentScope,
    files,
    spawnProcessGroup: (input, hooks) =>
      platform === "win32"
        ? spawnWindowsProcess(input, hooks)
        : spawnProcessGroup(input, hooks.onExit, hooks.onStderr, hooks.onStderrClose),
    exposeServerEndpoint: (endpoint) => Effect.succeed(endpoint.address),
  } satisfies WorkspaceHost;
});
