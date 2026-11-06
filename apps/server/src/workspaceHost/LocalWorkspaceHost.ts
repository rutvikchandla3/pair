// @effect-diagnostics nodeBuiltinImport:off -- the local host is the one place thread-scoped node:fs is allowed
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  LOCAL_WORKSPACE_HOST_ID,
  type WorkspaceFileKind,
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

/** The server's own machine, assembled from the context's services. No I/O, no state. */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const pty = yield* PtyAdapter.PtyAdapter;
  const agentScope = yield* AgentScope;
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
  } satisfies WorkspaceHost;
});
