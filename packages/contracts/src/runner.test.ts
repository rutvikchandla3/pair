import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { SchemaBinary } from "effect/encoding";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

import { CheckpointRef } from "./baseSchemas.ts";
import type { ProjectEntry } from "./project.ts";
import {
  RUNNER_METHODS,
  RUNNER_OPS_PAGE_BYTES,
  RUNNER_PROTOCOL_VERSION,
  RunnerCoreRpcGroup,
  RunnerFileError,
  RunnerHandleId,
  RunnerHelloInput,
  RunnerLostError,
  RunnerOpsError,
  RunnerOpsRpcGroup,
  RunnerRpcGroup,
  RunnerSystemError,
} from "./runner.ts";

const handle = RunnerHandleId.make("boot-1:7");
const allBytes = Uint8Array.from({ length: 256 }, (_, index) => index);
const ptyText = "prompt $ 🙂 ok\r\n";
const lost = new RunnerLostError({ reason: "lease-expired", handle });

interface Fixture {
  readonly payload: unknown;
  readonly success: unknown;
  readonly error: unknown;
}

// One representative call per RPC; a new RPC without a row fails the table.
const fixtures: Record<string, Fixture> = {
  [RUNNER_METHODS.hello]: {
    payload: {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      serverBootId: "server-boot",
      leaseMs: 120_000,
      limits: {
        windowBytes: 256 * 1024,
        windowChunks: 16,
        handleBufferBytes: 4 * 1024 * 1024,
        ptyBufferBytes: 1024 * 1024,
        sandboxBufferBytes: 64 * 1024 * 1024,
      },
    },
    success: {
      runnerBootId: "runner-boot",
      runnerBuildId: "build",
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      arch: "arm64",
      cpus: 4,
      memoryBytes: 8 * 1024 * 1024 * 1024,
      agent: { uid: 1000, homeDirectory: "/home/t3", shell: "/bin/bash" },
      tmpDirectory: "/tmp",
      bundleDirectory: "/opt/pair-runner/build",
      imageEnvironment: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
      handles: [{ handle, next: { "fd:1": 12, "in:0": 3 } }],
    },
    error: lost,
  },
  [RUNNER_METHODS.events]: {
    payload: {},
    success: { _tag: "forward.accepted", forwardId: "forward-1", connectionId: handle },
    error: new RunnerLostError({ reason: "server-restarted" }),
  },
  [RUNNER_METHODS.drain]: {
    payload: { graceMs: 10_000 },
    success: undefined,
    error: lost,
  },
  [RUNNER_METHODS.processSpawn]: {
    payload: {
      command: "codex",
      args: ["app-server"],
      cwd: "/t3-sandbox/sbx/worktrees/a",
      env: { PATH: "/usr/bin", T3CODE_THREAD_ID: "thread-1" },
      uid: 1000,
      gid: 1000,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      extraFds: [{ fd: 4, direction: "output" }],
      killSignal: "SIGTERM",
      forceKillAfterMs: 2_000,
    },
    success: { handle, pid: 4242 },
    error: new RunnerSystemError({
      reason: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      syscall: "spawn codex",
      pathOrDescriptor: "codex",
    }),
  },
  [RUNNER_METHODS.processOutput]: {
    payload: { handle, fd: 1, fromSeq: 512 },
    success: { seq: 512, data: allBytes },
    error: new RunnerLostError({ reason: "resume-behind-buffer", handle }),
  },
  [RUNNER_METHODS.processWrite]: {
    payload: { handle, fd: 0, seq: 3, data: allBytes },
    success: { appliedThrough: 3 },
    error: lost,
  },
  [RUNNER_METHODS.processCloseInput]: {
    payload: { handle, fd: 0, seq: 4 },
    success: undefined,
    error: lost,
  },
  [RUNNER_METHODS.processSignal]: {
    payload: { handle, signal: "SIGINT", group: true },
    success: undefined,
    error: lost,
  },
  [RUNNER_METHODS.processWait]: {
    payload: { handle },
    success: { exitCode: null, signal: "SIGKILL" },
    error: new RunnerLostError({ reason: "drained", handle }),
  },
  [RUNNER_METHODS.processRelease]: {
    payload: { handle },
    success: undefined,
    error: lost,
  },
  [RUNNER_METHODS.processRun]: {
    payload: {
      command: "git",
      args: ["hash-object", "--stdin"],
      cwd: "/t3-sandbox/sbx/repos/github.com/acme/app",
      env: { GIT_TERMINAL_PROMPT: "0" },
      stdin: allBytes,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
      outputMode: "truncate",
    },
    success: {
      stdout: allBytes,
      stderr: new Uint8Array(),
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    },
    error: lost,
  },
  [RUNNER_METHODS.processRunStream]: {
    payload: { command: "git", args: ["bundle", "create", "-"], cwd: "/w", env: {} },
    success: { _tag: "output", fd: 1, data: allBytes },
    error: lost,
  },
  [RUNNER_METHODS.ptyOpen]: {
    payload: { shell: "/bin/bash", args: ["-l"], cwd: "/w", cols: 120, rows: 40, env: {} },
    success: { handle, pid: 77 },
    error: lost,
  },
  [RUNNER_METHODS.ptyOutput]: {
    payload: { handle, fromSeq: 0 },
    success: { seq: 0, data: ptyText },
    error: lost,
  },
  [RUNNER_METHODS.ptyInput]: {
    payload: { handle, seq: 1, data: ptyText },
    success: { appliedThrough: 1 },
    error: lost,
  },
  [RUNNER_METHODS.ptyResize]: {
    payload: { handle, seq: 2, cols: 80, rows: 24 },
    success: { appliedThrough: 2 },
    error: lost,
  },
  [RUNNER_METHODS.ptySignal]: {
    payload: { handle, seq: 3, signal: "SIGHUP" },
    success: { appliedThrough: 3 },
    error: lost,
  },
  [RUNNER_METHODS.ptyWait]: {
    payload: { handle },
    success: { exitCode: 0, signal: 15 },
    error: lost,
  },
  [RUNNER_METHODS.ptyRelease]: {
    payload: { handle },
    success: undefined,
    error: lost,
  },
  [RUNNER_METHODS.fsStat]: {
    payload: { path: "/w/a.txt", noFollow: true },
    success: {
      type: "File",
      mtime: 1_762_400_000_123,
      atime: null,
      birthtime: null,
      dev: 2049n,
      ino: 9_007_199_254_740_993n,
      mode: 0o100644,
      nlink: 1n,
      uid: 1000,
      gid: 1000,
      rdev: null,
      size: 12n,
      blksize: 4096n,
      blocks: 8n,
    },
    error: new RunnerSystemError({
      reason: "PermissionDenied",
      module: "FileSystem",
      method: "stat",
      description: "EACCES",
      pathOrDescriptor: "/w/a.txt",
    }),
  },
  [RUNNER_METHODS.fsUtimes]: {
    payload: { path: "/w/.git/index.t3", atime: 1_762_400_000_123, mtime: 1_762_400_000_123 },
    success: undefined,
    error: lost,
  },
  [RUNNER_METHODS.filesLstat]: {
    payload: { path: "/w/link" },
    success: { kind: "SymbolicLink" },
    error: new RunnerFileError({ operation: "lstat", code: "ENOENT" }),
  },
  [RUNNER_METHODS.filesReadDirectory]: {
    payload: { path: "/w" },
    success: [
      { name: "src", kind: "Directory" },
      { name: "fifo", kind: "Other" },
    ],
    error: new RunnerFileError({ operation: "readdir", code: "EACCES" }),
  },
  [RUNNER_METHODS.filesReadFile]: {
    payload: { path: "/w/a.bin", maxBytes: 1024 * 1024 },
    success: { _tag: "chunk", data: allBytes },
    error: new RunnerFileError({ operation: "open" }),
  },
  [RUNNER_METHODS.filesWriteNoFollow]: {
    payload: { path: "/w/a.bin", data: allBytes, append: false },
    success: undefined,
    error: new RunnerFileError({ operation: "write", code: "ELOOP" }),
  },
  [RUNNER_METHODS.filesRealPath]: {
    payload: { path: "/w/link" },
    success: "/w/target",
    error: lost,
  },
  [RUNNER_METHODS.filesRemoveEmptyDirectory]: {
    payload: { path: "/w/empty" },
    success: false,
    error: new RunnerFileError({ operation: "rmdir", code: "EACCES" }),
  },
  [RUNNER_METHODS.fsReadDirectory]: {
    payload: { path: "/w", recursive: true },
    success: ["a.txt", "src/b.ts"],
    error: lost,
  },
  [RUNNER_METHODS.fsReadFile]: {
    payload: { path: "/w/a.bin", offset: 64, maxBytes: 128 * 1024 },
    success: allBytes,
    error: new RunnerSystemError({
      reason: "BadArgument",
      module: "FileSystem",
      method: "readFile",
    }),
  },
  [RUNNER_METHODS.fsWriteFile]: {
    payload: { path: "/w/a.bin", data: allBytes, flag: "w", mode: 0o600, atomic: true },
    success: undefined,
    error: lost,
  },
  [RUNNER_METHODS.fsMakeDirectory]: {
    payload: { path: "/w/new", recursive: true, mode: 0o755 },
    success: undefined,
    error: lost,
  },
  [RUNNER_METHODS.fsRemove]: {
    payload: { path: "/w/old", recursive: true, force: true },
    success: undefined,
    error: lost,
  },
  [RUNNER_METHODS.fsRename]: {
    payload: { oldPath: "/w/a", newPath: "/w/b" },
    success: undefined,
    error: lost,
  },
  [RUNNER_METHODS.fsCopy]: {
    payload: { fromPath: "/w/a", toPath: "/w/b", overwrite: true, preserveTimestamps: false },
    success: undefined,
    error: lost,
  },
  [RUNNER_METHODS.fsRealPath]: {
    payload: { path: "/w/./link" },
    success: "/w/target",
    error: lost,
  },
  [RUNNER_METHODS.fsReadLink]: {
    payload: { path: "/w/link" },
    success: "target",
    error: lost,
  },
  [RUNNER_METHODS.fsSymlink]: {
    payload: { fromPath: "target", toPath: "/w/link" },
    success: undefined,
    error: lost,
  },
  [RUNNER_METHODS.fsChmod]: {
    payload: { path: "/w/run.sh", mode: 0o755 },
    success: undefined,
    error: lost,
  },
  [RUNNER_METHODS.fsMakeTempDirectory]: {
    payload: { directory: "/tmp", prefix: "t3-" },
    success: "/tmp/t3-abc",
    error: lost,
  },
  [RUNNER_METHODS.fsReadStream]: {
    payload: { path: "/w/big.bin", offset: 0, chunkBytes: 64 * 1024 },
    success: { seq: 65_536, data: allBytes },
    error: lost,
  },
  [RUNNER_METHODS.fsWriteStreamOpen]: {
    payload: { path: "/w/big.bin", atomic: true },
    success: { handle },
    error: lost,
  },
  [RUNNER_METHODS.fsWriteStreamChunk]: {
    payload: { handle, seq: 1, data: allBytes },
    success: { appliedThrough: 1 },
    error: lost,
  },
  [RUNNER_METHODS.fsWriteStreamClose]: {
    payload: { handle },
    success: undefined,
    error: lost,
  },
  [RUNNER_METHODS.fsWatch]: {
    payload: { path: "/w", recursive: true },
    success: [
      { _tag: "Create", path: "/w/a" },
      { _tag: "Remove", path: "/w/b" },
    ],
    error: lost,
  },
  [RUNNER_METHODS.forwardOpen]: {
    payload: { name: "mcp", ownerKey: "provider-session-1" },
    success: { forwardId: "forward-1", address: "http://127.0.0.1:41234/mcp" },
    error: lost,
  },
  [RUNNER_METHODS.forwardClose]: {
    payload: { forwardId: "forward-1" },
    success: undefined,
    error: lost,
  },
  [RUNNER_METHODS.tcpRead]: {
    payload: { connectionId: handle, fromSeq: 0 },
    success: { seq: 0, data: allBytes },
    error: lost,
  },
  [RUNNER_METHODS.tcpWrite]: {
    payload: { connectionId: handle, seq: 1, data: allBytes },
    success: { appliedThrough: 1 },
    error: lost,
  },
  [RUNNER_METHODS.tcpClose]: {
    payload: { connectionId: handle },
    success: undefined,
    error: lost,
  },
  [RUNNER_METHODS.opsSearchEntries]: {
    payload: { cwd: "/w", query: "app", limit: 50, kind: "file" },
    success: { entries: [{ path: "src/app.ts", kind: "file" }], truncated: false },
    error: new RunnerOpsError({
      operation: "search.entries",
      failure: "search_index_scan_timed_out",
    }),
  },
  [RUNNER_METHODS.opsSearchContents]: {
    payload: {
      cwd: "/w",
      query: " needle ",
      limit: 20,
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    },
    success: {
      matches: [
        {
          path: "a.ts",
          lineNumber: 3,
          lineContent: "a needle b",
          matchRanges: [{ start: 1, end: 9 }],
        },
      ],
      truncated: false,
    },
    error: new RunnerOpsError({ operation: "search.contents", failure: "failed" }),
  },
  [RUNNER_METHODS.opsSearchRefresh]: {
    payload: { cwd: "/w" },
    success: undefined,
    error: lost,
  },
  [RUNNER_METHODS.opsEntriesBrowse]: {
    payload: { cwd: "/w", directoryPath: "src" },
    success: { entries: [{ path: "src/lib", kind: "directory" }], truncated: false },
    error: new RunnerOpsError({ operation: "entries.browse", failure: "directory_list_failed" }),
  },
  [RUNNER_METHODS.opsProcessesTable]: {
    payload: {},
    success: [{ pid: 12, ppid: 1, name: "node" }],
    error: lost,
  },
  [RUNNER_METHODS.opsPortsListeners]: {
    payload: { configuredUrls: ["http://localhost:3000"] },
    success: [
      {
        host: "127.0.0.1",
        port: 3000,
        url: "http://127.0.0.1:3000",
        processName: "vite",
        pid: 99,
        terminal: null,
      },
    ],
    error: lost,
  },
  [RUNNER_METHODS.opsCheckpointCapture]: {
    payload: {
      _tag: "turn",
      cwd: "/w",
      checkpointRef: CheckpointRef.make("refs/t3/checkpoints/2"),
      previousCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/1"),
    },
    success: {
      status: "ready",
      commitOid: "0123456789abcdef0123456789abcdef01234567",
      files: [{ path: "a.ts", kind: "modified", additions: 2, deletions: 1 }],
      warnings: ["authored-paths-failed"],
    },
    error: new RunnerOpsError({ operation: "checkpoint.capture", failure: "failed" }),
  },
};

const roundTrip = (schema: Schema.Top, value: unknown) => {
  const codec = SchemaBinary.toCodec(schema as Schema.Codec<unknown, unknown>);
  return Schema.decodeSync(codec)(Schema.encodeUnknownSync(codec)(value));
};

const rpcSchemas = (
  rpc: (typeof RunnerRpcGroup)["requests"] extends ReadonlyMap<string, infer R> ? R : never,
) =>
  RpcSchema.isStreamSchema(rpc.successSchema)
    ? { success: rpc.successSchema.success, error: rpc.successSchema.error }
    : { success: rpc.successSchema, error: rpc.errorSchema };

describe("runner protocol codec", () => {
  it("has one method per RUNNER_METHODS name, split between the core and ops groups", () => {
    expect([...RunnerRpcGroup.requests.keys()].toSorted()).toEqual(
      Object.values(RUNNER_METHODS).toSorted(),
    );
    expect([...RunnerOpsRpcGroup.requests.keys()].every((tag) => tag.startsWith("ops."))).toBe(
      true,
    );
    expect(RunnerCoreRpcGroup.requests.size + RunnerOpsRpcGroup.requests.size).toBe(
      RunnerRpcGroup.requests.size,
    );
  });

  it("round-trips every payload, success and error through SchemaBinary", () => {
    for (const [tag, rpc] of RunnerRpcGroup.requests) {
      const fixture = fixtures[tag];
      expect(fixture, tag).toBeDefined();
      if (fixture === undefined) continue;
      const { success, error } = rpcSchemas(rpc);
      expect(roundTrip(rpc.payloadSchema, fixture.payload), tag).toEqual(fixture.payload);
      expect(roundTrip(success, fixture.success), tag).toEqual(fixture.success);
      expect(roundTrip(error, fixture.error), tag).toEqual(fixture.error);
    }
  });

  it("keeps bytes and PTY text exact", () => {
    const output = rpcSchemas(RunnerRpcGroup.requests.get(RUNNER_METHODS.processOutput)!);
    const chunk = roundTrip(output.success, { seq: 0, data: allBytes }) as { data: Uint8Array };
    expect(chunk.data).toBeInstanceOf(Uint8Array);
    expect([...chunk.data]).toEqual([...allBytes]);
    expect(chunk.data[0]).toBe(0x00);
    expect(chunk.data[255]).toBe(0xff);

    const pty = rpcSchemas(RunnerRpcGroup.requests.get(RUNNER_METHODS.ptyOutput)!);
    const text = roundTrip(pty.success, { seq: 0, data: ptyText }) as { data: string };
    expect(text.data).toBe(ptyText);
    expect(text.data.codePointAt(ptyText.indexOf("🙂"))).toBe(0x1f642);
  });

  it("decodes the enrollment token as Redacted", () => {
    const hello = fixtures[RUNNER_METHODS.hello]!.payload as object;
    const decoded = roundTrip(RunnerHelloInput, {
      ...hello,
      sandboxToken: Redacted.make("sandbox-token"),
    }) as { sandboxToken: unknown };
    expect(Redacted.isRedacted(decoded.sandboxToken)).toBe(true);
    expect(Redacted.value(decoded.sandboxToken as Redacted.Redacted<string>)).toBe("sandbox-token");
  });

  it.effect("fits a page of a 25,000-entry listing in one frame", () =>
    Effect.gen(function* () {
      const serialization = yield* RpcSerialization.RpcSerialization;
      const browse = rpcSchemas(RunnerRpcGroup.requests.get(RUNNER_METHODS.opsEntriesBrowse)!);
      const frame = Effect.fn(function* (entries: ReadonlyArray<ProjectEntry>) {
        const values = yield* Schema.encodeUnknownEffect(
          serialization.codecFor(Schema.NonEmptyArray(browse.success)),
        )([{ entries, truncated: false }]);
        return serialization.makeUnsafe().encode({ _tag: "Chunk", requestId: "1", values });
      });
      const entries = Array.from({ length: 25_000 }, (_, index) => ({
        path: `packages/feature-${Math.floor(index / 50)}/src/module-${index}.ts`,
        kind: "file" as const,
      }));
      // The runner pages by each entry's JSON size, which is never below its binary size.
      let bytes = 0;
      const page = entries.filter(
        (entry) => (bytes += JSON.stringify(entry).length) <= RUNNER_OPS_PAGE_BYTES,
      );

      const whole = yield* frame(entries);
      const first = yield* frame(page);

      expect(() => serialization.makeUnsafe().decode(whole!)).toThrow(/maxFrameSize/);
      expect(serialization.makeUnsafe().decode(first!)).toHaveLength(1);
    }).pipe(
      Effect.provide(RpcSerialization.layerSchemaBinary({ maxFrameSize: 256 * 1024 + 1024 })),
    ),
  );

  it.effect("fits a 256 KiB output chunk in the frame cap and rejects one twice that size", () =>
    Effect.gen(function* () {
      const serialization = yield* RpcSerialization.RpcSerialization;
      const output = rpcSchemas(RunnerRpcGroup.requests.get(RUNNER_METHODS.processOutput)!);
      const encodeValues = Schema.encodeUnknownEffect(
        serialization.codecFor(Schema.NonEmptyArray(output.success)),
      );
      const frame = Effect.fn(function* (bytes: number) {
        const values = yield* encodeValues([{ seq: 0, data: new Uint8Array(bytes).fill(0xff) }]);
        return serialization.makeUnsafe().encode({ _tag: "Chunk", requestId: "1", values });
      });
      const fits = yield* frame(256 * 1024);
      const tooLarge = yield* frame(2 * 256 * 1024);

      expect(serialization.makeUnsafe().decode(fits!)).toHaveLength(1);
      expect(() => serialization.makeUnsafe().decode(tooLarge!)).toThrow(/maxFrameSize/);
    }).pipe(
      Effect.provide(RpcSerialization.layerSchemaBinary({ maxFrameSize: 256 * 1024 + 1024 })),
    ),
  );
});
