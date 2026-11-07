import type * as ChildProcess from "effect/process/ChildProcess";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import {
  CheckpointRef,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestrationV2CheckpointFileSummary } from "./orchestrationV2.ts";
import { DiscoveredLocalServer } from "./preview.ts";
import {
  ProjectEntriesFailure,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "./project.ts";
import { ResourceMonitorProcessTableEntry } from "./resourceTelemetry.ts";

// The wire between the team server and `t3 runner` in a sandbox. The server is the RPC client
// and the runner serves this group. Payloads carry cwds, handles and opaque owner keys, never
// thread ids: the server maps handles to threads.

export const RUNNER_PROTOCOL_VERSION = 1 as const;

export const RUNNER_METHODS = {
  hello: "runner.hello",
  events: "runner.events",
  drain: "runner.drain",
  processSpawn: "process.spawn",
  processOutput: "process.output",
  processWrite: "process.write",
  processCloseInput: "process.closeInput",
  processSignal: "process.signal",
  processWait: "process.wait",
  processRelease: "process.release",
  processRun: "process.run",
  processRunStream: "process.runStream",
  ptyOpen: "pty.open",
  ptyOutput: "pty.output",
  ptyInput: "pty.input",
  ptyResize: "pty.resize",
  ptySignal: "pty.signal",
  ptyWait: "pty.wait",
  ptyRelease: "pty.release",
  fsStat: "fs.stat",
  fsReadDirectory: "fs.readDirectory",
  fsReadFile: "fs.readFile",
  fsWriteFile: "fs.writeFile",
  fsMakeDirectory: "fs.makeDirectory",
  fsRemove: "fs.remove",
  fsRename: "fs.rename",
  fsCopy: "fs.copy",
  fsRealPath: "fs.realPath",
  fsReadLink: "fs.readLink",
  fsSymlink: "fs.symlink",
  fsChmod: "fs.chmod",
  fsMakeTempDirectory: "fs.makeTempDirectory",
  fsReadStream: "fs.readStream",
  fsWriteStreamOpen: "fs.writeStream.open",
  fsWriteStreamChunk: "fs.writeStream.chunk",
  fsWriteStreamClose: "fs.writeStream.close",
  fsWatch: "fs.watch",
  forwardOpen: "forward.open",
  forwardClose: "forward.close",
  tcpRead: "tcp.read",
  tcpWrite: "tcp.write",
  tcpClose: "tcp.close",
  opsSearchEntries: "ops.search.entries",
  opsSearchContents: "ops.search.contents",
  opsSearchRefresh: "ops.search.refresh",
  opsEntriesBrowse: "ops.entries.browse",
  opsProcessesTable: "ops.processes.table",
  opsPortsListeners: "ops.ports.listeners",
  opsCheckpointCapture: "ops.checkpoint.capture",
} as const;

export const RunnerHandleId = TrimmedNonEmptyString.pipe(Schema.brand("RunnerHandleId"));
export type RunnerHandleId = typeof RunnerHandleId.Type;
export const RunnerForwardId = TrimmedNonEmptyString.pipe(Schema.brand("RunnerForwardId"));
export type RunnerForwardId = typeof RunnerForwardId.Type;

/**
 * Output: the offset of a chunk's first unit, in bytes for fds, files and TCP and in UTF-16 units
 * for PTY text. Input: a per-input call counter; the runner applies each seq once, in order.
 */
export const StreamSeq = NonNegativeInt;
export type StreamSeq = typeof StreamSeq.Type;

const RUNNER_SIGNALS = [
  "SIGABRT",
  "SIGALRM",
  "SIGBUS",
  "SIGCHLD",
  "SIGCONT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGIO",
  "SIGIOT",
  "SIGKILL",
  "SIGPIPE",
  "SIGPOLL",
  "SIGPROF",
  "SIGPWR",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSTKFLT",
  "SIGSTOP",
  "SIGSYS",
  "SIGTERM",
  "SIGTRAP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGUNUSED",
  "SIGURG",
  "SIGUSR1",
  "SIGUSR2",
  "SIGVTALRM",
  "SIGWINCH",
  "SIGXCPU",
  "SIGXFSZ",
] as const satisfies ReadonlyArray<ChildProcess.Signal>;
export const RunnerSignal = Schema.Literals(RUNNER_SIGNALS);
export type RunnerSignal = typeof RunnerSignal.Type;

/** Kept byte for byte: a trimming schema would change a path. */
const RunnerPath = Schema.String.check(Schema.isNonEmpty());
/** A child's whole environment: it inherits nothing from the runner. */
const RunnerEnv = Schema.Record(Schema.String, Schema.String);
const RunnerUserId = NonNegativeInt;

export class RunnerLostError extends Schema.TaggedError<RunnerLostError>()("RunnerLostError", {
  reason: Schema.Literals([
    "lease-expired",
    "runner-restarted",
    "server-restarted",
    "drained",
    "resume-behind-buffer",
  ]),
  handle: Schema.optionalKey(RunnerHandleId),
}) {}

/** Effect's `PlatformError` field by field, so the host rebuilds an equal one. */
export class RunnerSystemError extends Schema.TaggedError<RunnerSystemError>()(
  "RunnerSystemError",
  {
    /** `BadArgument`, or the `SystemError` tag. */
    reason: Schema.Literals([
      "BadArgument",
      "AlreadyExists",
      "BadResource",
      "Busy",
      "InvalidData",
      "NotFound",
      "PermissionDenied",
      "TimedOut",
      "UnexpectedEof",
      "Unknown",
      "WouldBlock",
      "WriteZero",
    ]),
    module: Schema.String,
    method: Schema.String,
    description: Schema.optionalKey(Schema.String),
    syscall: Schema.optionalKey(Schema.String),
    pathOrDescriptor: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  },
) {}

export const RunnerCallError = Schema.Union([RunnerLostError, RunnerSystemError]);
export type RunnerCallError = typeof RunnerCallError.Type;

export const RunnerLimits = Schema.Struct({
  windowBytes: NonNegativeInt,
  windowChunks: NonNegativeInt,
  handleBufferBytes: NonNegativeInt,
  ptyBufferBytes: NonNegativeInt,
  sandboxBufferBytes: NonNegativeInt,
});
export type RunnerLimits = typeof RunnerLimits.Type;

export const RunnerHelloInput = Schema.Struct({
  protocolVersion: Schema.Literal(RUNNER_PROTOCOL_VERSION),
  serverBootId: TrimmedNonEmptyString,
  leaseMs: NonNegativeInt,
  limits: RunnerLimits,
  /** Sent only on the enrollment connect. */
  sandboxToken: Schema.optionalKey(Schema.Redacted(Schema.String)),
});
export type RunnerHelloInput = typeof RunnerHelloInput.Type;

export const RunnerHandleState = Schema.Struct({
  handle: RunnerHandleId,
  /**
   * Outputs ("fd:<n>", "pty", "tcp"): the next seq. Inputs ("in:<fd>", "in:pty", "in:tcp"): the
   * last applied seq.
   */
  next: Schema.Record(Schema.String, StreamSeq),
});
export type RunnerHandleState = typeof RunnerHandleState.Type;

export const RunnerInfo = Schema.Struct({
  runnerBootId: TrimmedNonEmptyString,
  runnerBuildId: TrimmedNonEmptyString,
  protocolVersion: Schema.Literal(RUNNER_PROTOCOL_VERSION),
  arch: Schema.Literals(["x64", "arm64"]),
  cpus: NonNegativeInt,
  memoryBytes: NonNegativeInt,
  /** Handles alive from this `serverBootId`; empty after a runner or server restart. */
  handles: Schema.Array(RunnerHandleState),
});
export type RunnerInfo = typeof RunnerInfo.Type;

export const RunnerEvent = Schema.Union([
  Schema.TaggedStruct("forward.accepted", {
    forwardId: RunnerForwardId,
    connectionId: RunnerHandleId,
  }),
  Schema.TaggedStruct("ports.changed", {}),
  Schema.TaggedStruct("resource.pressure", {
    bufferedBytes: NonNegativeInt,
    pausedHandles: NonNegativeInt,
  }),
  Schema.TaggedStruct("handle.exited", { handle: RunnerHandleId }),
]);
export type RunnerEvent = typeof RunnerEvent.Type;

const RunnerHelloRpc = Rpc.make(RUNNER_METHODS.hello, {
  payload: RunnerHelloInput,
  success: RunnerInfo,
  error: RunnerCallError,
});

const RunnerEventsRpc = Rpc.make(RUNNER_METHODS.events, {
  payload: Schema.Struct({}),
  success: RunnerEvent,
  error: RunnerCallError,
  stream: true,
});

const RunnerDrainRpc = Rpc.make(RUNNER_METHODS.drain, {
  payload: Schema.Struct({ graceMs: NonNegativeInt }),
  error: RunnerCallError,
});

// The runner puts every spawn in its own group behind a watcher on fd 3, so a group
// dies with its handle's release or with the runner, and extra fds start at 4.

const RunnerStdio = Schema.Literals(["pipe", "ignore"]);

export const RunnerProcessSpawnInput = Schema.Struct({
  command: RunnerPath,
  args: Schema.Array(Schema.String),
  cwd: RunnerPath,
  env: RunnerEnv,
  uid: Schema.optionalKey(RunnerUserId),
  gid: Schema.optionalKey(RunnerUserId),
  stdin: RunnerStdio,
  stdout: RunnerStdio,
  stderr: RunnerStdio,
  extraFds: Schema.Array(
    Schema.Struct({
      fd: Schema.Int.check(Schema.isGreaterThanOrEqualTo(4)),
      direction: Schema.Literals(["input", "output"]),
    }),
  ),
  killSignal: Schema.optionalKey(RunnerSignal),
  forceKillAfterMs: Schema.optionalKey(NonNegativeInt),
});
export type RunnerProcessSpawnInput = typeof RunnerProcessSpawnInput.Type;

const RunnerSpawned = Schema.Struct({ handle: RunnerHandleId, pid: PositiveInt });

const RunnerHandleInput = Schema.Struct({ handle: RunnerHandleId });

/** One output chunk; `seq` is its first byte's offset in the stream. */
export const RunnerByteChunk = Schema.Struct({ seq: StreamSeq, data: Schema.Uint8Array });
export type RunnerByteChunk = typeof RunnerByteChunk.Type;

const RunnerApplied = Schema.Struct({ appliedThrough: StreamSeq });

export const RunnerProcessExit = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
});
export type RunnerProcessExit = typeof RunnerProcessExit.Type;

const RunnerProcessSpawnRpc = Rpc.make(RUNNER_METHODS.processSpawn, {
  payload: RunnerProcessSpawnInput,
  success: RunnerSpawned,
  error: RunnerCallError,
});

const RunnerProcessOutputRpc = Rpc.make(RUNNER_METHODS.processOutput, {
  payload: Schema.Struct({ handle: RunnerHandleId, fd: NonNegativeInt, fromSeq: StreamSeq }),
  success: RunnerByteChunk,
  error: RunnerCallError,
  stream: true,
});

const RunnerProcessWriteRpc = Rpc.make(RUNNER_METHODS.processWrite, {
  payload: Schema.Struct({
    handle: RunnerHandleId,
    fd: NonNegativeInt,
    seq: StreamSeq,
    data: Schema.Uint8Array,
  }),
  success: RunnerApplied,
  error: RunnerCallError,
});

const RunnerProcessCloseInputRpc = Rpc.make(RUNNER_METHODS.processCloseInput, {
  payload: Schema.Struct({ handle: RunnerHandleId, fd: NonNegativeInt, seq: StreamSeq }),
  error: RunnerCallError,
});

const RunnerProcessSignalRpc = Rpc.make(RUNNER_METHODS.processSignal, {
  payload: Schema.Struct({ handle: RunnerHandleId, signal: RunnerSignal, group: Schema.Boolean }),
  error: RunnerCallError,
});

/** Resolves only after every output stream of the handle delivered its last byte. */
const RunnerProcessWaitRpc = Rpc.make(RUNNER_METHODS.processWait, {
  payload: RunnerHandleInput,
  success: RunnerProcessExit,
  error: RunnerCallError,
});

/** Kills the handle's group and frees its buffers. Idempotent. */
const RunnerProcessReleaseRpc = Rpc.make(RUNNER_METHODS.processRelease, {
  payload: RunnerHandleInput,
  error: RunnerCallError,
});

/** Command, stdin and close in one request: one round trip per git call. */
export const RunnerProcessRunInput = Schema.Struct({
  command: RunnerPath,
  args: Schema.Array(Schema.String),
  cwd: RunnerPath,
  env: RunnerEnv,
  uid: Schema.optionalKey(RunnerUserId),
  gid: Schema.optionalKey(RunnerUserId),
  stdin: Schema.optionalKey(Schema.Uint8Array),
  timeoutMs: Schema.optionalKey(NonNegativeInt),
  maxOutputBytes: Schema.optionalKey(NonNegativeInt),
  outputMode: Schema.optionalKey(Schema.Literals(["error", "truncate"])),
});
export type RunnerProcessRunInput = typeof RunnerProcessRunInput.Type;

/** Raw bytes: the server decodes text and sets the `InvalidUtf8` flags. */
export const RunnerProcessRunResult = Schema.Struct({
  stdout: Schema.Uint8Array,
  stderr: Schema.Uint8Array,
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
});
export type RunnerProcessRunResult = typeof RunnerProcessRunResult.Type;

export const RunnerProcessRunStreamEvent = Schema.Union([
  Schema.TaggedStruct("output", { fd: Schema.Literals([1, 2]), data: Schema.Uint8Array }),
  Schema.TaggedStruct("exit", {
    exitCode: Schema.NullOr(Schema.Int),
    signal: Schema.NullOr(Schema.String),
    timedOut: Schema.Boolean,
  }),
]);
export type RunnerProcessRunStreamEvent = typeof RunnerProcessRunStreamEvent.Type;

const RunnerProcessRunRpc = Rpc.make(RUNNER_METHODS.processRun, {
  payload: RunnerProcessRunInput,
  success: RunnerProcessRunResult,
  error: RunnerCallError,
});

const RunnerProcessRunStreamRpc = Rpc.make(RUNNER_METHODS.processRunStream, {
  payload: RunnerProcessRunInput,
  success: RunnerProcessRunStreamEvent,
  error: RunnerCallError,
  stream: true,
});

// PTY output is text decoded on the runner, so a chunk never splits a code point.

export const RunnerPtyOpenInput = Schema.Struct({
  shell: RunnerPath,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  cwd: RunnerPath,
  cols: PositiveInt,
  rows: PositiveInt,
  env: RunnerEnv,
  uid: Schema.optionalKey(RunnerUserId),
  gid: Schema.optionalKey(RunnerUserId),
});
export type RunnerPtyOpenInput = typeof RunnerPtyOpenInput.Type;

/** `seq` is the offset of the chunk's first UTF-16 unit. */
export const RunnerTextChunk = Schema.Struct({ seq: StreamSeq, data: Schema.String });
export type RunnerTextChunk = typeof RunnerTextChunk.Type;

/** `PtyExitEvent`. */
export const RunnerPtyExit = Schema.Struct({
  exitCode: Schema.Int,
  signal: Schema.NullOr(Schema.Int),
});
export type RunnerPtyExit = typeof RunnerPtyExit.Type;

const RunnerPtyOpenRpc = Rpc.make(RUNNER_METHODS.ptyOpen, {
  payload: RunnerPtyOpenInput,
  success: RunnerSpawned,
  error: RunnerCallError,
});

const RunnerPtyOutputRpc = Rpc.make(RUNNER_METHODS.ptyOutput, {
  payload: Schema.Struct({ handle: RunnerHandleId, fromSeq: StreamSeq }),
  success: RunnerTextChunk,
  error: RunnerCallError,
  stream: true,
});

// Input, resize and signal share one seq per handle, so they apply in the order sent.
const RunnerPtyInputRpc = Rpc.make(RUNNER_METHODS.ptyInput, {
  payload: Schema.Struct({ handle: RunnerHandleId, seq: StreamSeq, data: Schema.String }),
  success: RunnerApplied,
  error: RunnerCallError,
});

const RunnerPtyResizeRpc = Rpc.make(RUNNER_METHODS.ptyResize, {
  payload: Schema.Struct({
    handle: RunnerHandleId,
    seq: StreamSeq,
    cols: PositiveInt,
    rows: PositiveInt,
  }),
  success: RunnerApplied,
  error: RunnerCallError,
});

const RunnerPtySignalRpc = Rpc.make(RUNNER_METHODS.ptySignal, {
  payload: Schema.Struct({ handle: RunnerHandleId, seq: StreamSeq, signal: RunnerSignal }),
  success: RunnerApplied,
  error: RunnerCallError,
});

const RunnerPtyWaitRpc = Rpc.make(RUNNER_METHODS.ptyWait, {
  payload: RunnerHandleInput,
  success: RunnerPtyExit,
  error: RunnerCallError,
});

const RunnerPtyReleaseRpc = Rpc.make(RUNNER_METHODS.ptyRelease, {
  payload: RunnerHandleInput,
  error: RunnerCallError,
});

// Files: the subset of Effect's `FileSystem` the workspace host needs, one struct per method.

const RunnerPathInput = Schema.Struct({ path: RunnerPath });
const RunnerFileMode = NonNegativeInt;

/** `File.Info` with `Option` as null and dates as epoch milliseconds. */
export const RunnerFileInfo = Schema.Struct({
  type: Schema.Literals([
    "File",
    "Directory",
    "SymbolicLink",
    "BlockDevice",
    "CharacterDevice",
    "FIFO",
    "Socket",
    "Unknown",
  ]),
  mtime: Schema.NullOr(Schema.Number),
  atime: Schema.NullOr(Schema.Number),
  birthtime: Schema.NullOr(Schema.Number),
  dev: Schema.BigInt,
  ino: Schema.NullOr(Schema.BigInt),
  mode: RunnerFileMode,
  nlink: Schema.NullOr(Schema.BigInt),
  uid: Schema.NullOr(NonNegativeInt),
  gid: Schema.NullOr(NonNegativeInt),
  rdev: Schema.NullOr(Schema.BigInt),
  size: Schema.BigInt,
  blksize: Schema.NullOr(Schema.BigInt),
  blocks: Schema.NullOr(Schema.BigInt),
});
export type RunnerFileInfo = typeof RunnerFileInfo.Type;

export const RunnerWatchEvent = Schema.Struct({
  _tag: Schema.Literals(["Create", "Update", "Remove"]),
  path: RunnerPath,
});
export type RunnerWatchEvent = typeof RunnerWatchEvent.Type;

const RunnerFsStatRpc = Rpc.make(RUNNER_METHODS.fsStat, {
  payload: RunnerPathInput,
  success: RunnerFileInfo,
  error: RunnerCallError,
});

const RunnerFsReadDirectoryRpc = Rpc.make(RUNNER_METHODS.fsReadDirectory, {
  payload: Schema.Struct({ path: RunnerPath, recursive: Schema.optionalKey(Schema.Boolean) }),
  success: Schema.Array(Schema.String),
  error: RunnerCallError,
});

/** At most `maxBytes` from `offset`; fewer means the end of the file. */
const RunnerFsReadFileRpc = Rpc.make(RUNNER_METHODS.fsReadFile, {
  payload: Schema.Struct({
    path: RunnerPath,
    offset: Schema.optionalKey(NonNegativeInt),
    maxBytes: NonNegativeInt,
  }),
  success: Schema.Uint8Array,
  error: RunnerCallError,
});

const RunnerFsWriteFileRpc = Rpc.make(RUNNER_METHODS.fsWriteFile, {
  payload: Schema.Struct({
    path: RunnerPath,
    data: Schema.Uint8Array,
    flag: Schema.optionalKey(
      Schema.Literals(["r", "r+", "w", "wx", "w+", "wx+", "a", "ax", "a+", "ax+"]),
    ),
    mode: Schema.optionalKey(RunnerFileMode),
    /** Write a temp file beside `path`, then rename it over `path`. */
    atomic: Schema.optionalKey(Schema.Boolean),
  }),
  error: RunnerCallError,
});

const RunnerFsMakeDirectoryRpc = Rpc.make(RUNNER_METHODS.fsMakeDirectory, {
  payload: Schema.Struct({
    path: RunnerPath,
    recursive: Schema.optionalKey(Schema.Boolean),
    mode: Schema.optionalKey(RunnerFileMode),
  }),
  error: RunnerCallError,
});

const RunnerFsRemoveRpc = Rpc.make(RUNNER_METHODS.fsRemove, {
  payload: Schema.Struct({
    path: RunnerPath,
    recursive: Schema.optionalKey(Schema.Boolean),
    force: Schema.optionalKey(Schema.Boolean),
  }),
  error: RunnerCallError,
});

const RunnerFsRenameRpc = Rpc.make(RUNNER_METHODS.fsRename, {
  payload: Schema.Struct({ oldPath: RunnerPath, newPath: RunnerPath }),
  error: RunnerCallError,
});

const RunnerFsCopyRpc = Rpc.make(RUNNER_METHODS.fsCopy, {
  payload: Schema.Struct({
    fromPath: RunnerPath,
    toPath: RunnerPath,
    overwrite: Schema.optionalKey(Schema.Boolean),
    preserveTimestamps: Schema.optionalKey(Schema.Boolean),
  }),
  error: RunnerCallError,
});

const RunnerFsRealPathRpc = Rpc.make(RUNNER_METHODS.fsRealPath, {
  payload: RunnerPathInput,
  success: Schema.String,
  error: RunnerCallError,
});

const RunnerFsReadLinkRpc = Rpc.make(RUNNER_METHODS.fsReadLink, {
  payload: RunnerPathInput,
  success: Schema.String,
  error: RunnerCallError,
});

const RunnerFsSymlinkRpc = Rpc.make(RUNNER_METHODS.fsSymlink, {
  payload: Schema.Struct({ fromPath: RunnerPath, toPath: RunnerPath }),
  error: RunnerCallError,
});

const RunnerFsChmodRpc = Rpc.make(RUNNER_METHODS.fsChmod, {
  payload: Schema.Struct({ path: RunnerPath, mode: RunnerFileMode }),
  error: RunnerCallError,
});

const RunnerFsMakeTempDirectoryRpc = Rpc.make(RUNNER_METHODS.fsMakeTempDirectory, {
  payload: Schema.Struct({
    directory: Schema.optionalKey(RunnerPath),
    prefix: Schema.optionalKey(Schema.String),
  }),
  success: Schema.String,
  error: RunnerCallError,
});

const RunnerFsReadStreamRpc = Rpc.make(RUNNER_METHODS.fsReadStream, {
  payload: Schema.Struct({
    path: RunnerPath,
    offset: Schema.optionalKey(NonNegativeInt),
    chunkBytes: Schema.optionalKey(PositiveInt),
  }),
  success: RunnerByteChunk,
  error: RunnerCallError,
  stream: true,
});

const RunnerFsWriteStreamOpenRpc = Rpc.make(RUNNER_METHODS.fsWriteStreamOpen, {
  payload: Schema.Struct({ path: RunnerPath, atomic: Schema.optionalKey(Schema.Boolean) }),
  success: Schema.Struct({ handle: RunnerHandleId }),
  error: RunnerCallError,
});

const RunnerFsWriteStreamChunkRpc = Rpc.make(RUNNER_METHODS.fsWriteStreamChunk, {
  payload: Schema.Struct({ handle: RunnerHandleId, seq: StreamSeq, data: Schema.Uint8Array }),
  success: RunnerApplied,
  error: RunnerCallError,
});

const RunnerFsWriteStreamCloseRpc = Rpc.make(RUNNER_METHODS.fsWriteStreamClose, {
  payload: RunnerHandleInput,
  error: RunnerCallError,
});

/** Events coalesced on the runner. */
const RunnerFsWatchRpc = Rpc.make(RUNNER_METHODS.fsWatch, {
  payload: Schema.Struct({ path: RunnerPath, recursive: Schema.Boolean }),
  success: Schema.Array(RunnerWatchEvent),
  error: RunnerCallError,
  stream: true,
});

// A forward is a listener in the sandbox whose target the server fixes by name. Accepts arrive on
// `runner.events`; the server closes the forward when its own scope closes. An accepted
// connection is a handle, so its streams resume as a process's do.

export const RunnerForwardName = Schema.Literals(["mcp", "codex-token", "git-credential"]);
export type RunnerForwardName = typeof RunnerForwardName.Type;

const RunnerForwardOpenRpc = Rpc.make(RUNNER_METHODS.forwardOpen, {
  payload: Schema.Struct({ name: RunnerForwardName, ownerKey: TrimmedNonEmptyString }),
  success: Schema.Struct({ forwardId: RunnerForwardId, address: TrimmedNonEmptyString }),
  error: RunnerCallError,
});

const RunnerForwardCloseRpc = Rpc.make(RUNNER_METHODS.forwardClose, {
  payload: Schema.Struct({ forwardId: RunnerForwardId }),
  error: RunnerCallError,
});

const RunnerTcpReadRpc = Rpc.make(RUNNER_METHODS.tcpRead, {
  payload: Schema.Struct({ connectionId: RunnerHandleId, fromSeq: StreamSeq }),
  success: RunnerByteChunk,
  error: RunnerCallError,
  stream: true,
});

const RunnerTcpWriteRpc = Rpc.make(RUNNER_METHODS.tcpWrite, {
  payload: Schema.Struct({
    connectionId: RunnerHandleId,
    seq: StreamSeq,
    data: Schema.Uint8Array,
  }),
  success: RunnerApplied,
  error: RunnerCallError,
});

const RunnerTcpCloseRpc = Rpc.make(RUNNER_METHODS.tcpClose, {
  payload: Schema.Struct({ connectionId: RunnerHandleId }),
  error: RunnerCallError,
});

// Coarse operations run existing server services inside the runner, with the payloads and
// results of the client RPCs they back.

/**
 * A list result streams in pages of about this many bytes of entries, so every frame stays
 * under the 256 KiB cap. Concatenated, the pages are the client RPC's result.
 */
export const RUNNER_OPS_PAGE_BYTES = 192 * 1024;

export const RunnerOpsCheckpointCaptureInput = Schema.Union([
  Schema.TaggedStruct("baseline", { cwd: RunnerPath, checkpointRef: CheckpointRef }),
  Schema.TaggedStruct("turn", {
    cwd: RunnerPath,
    checkpointRef: CheckpointRef,
    previousCheckpointRef: CheckpointRef,
  }),
]);
export type RunnerOpsCheckpointCaptureInput = typeof RunnerOpsCheckpointCaptureInput.Type;

export const RunnerOpsCheckpointCaptureResult = Schema.Struct({
  status: Schema.Literals(["ready", "missing", "error"]),
  /** The captured commit, a bundle prerequisite for the checkpoint mirror. */
  commitOid: Schema.NullOr(TrimmedNonEmptyString),
  files: Schema.Array(OrchestrationV2CheckpointFileSummary),
  warnings: Schema.Array(
    Schema.Literals([
      "capture-failed",
      "previous-ref-lookup-failed",
      "authored-paths-failed",
      "diff-summary-failed",
    ]),
  ),
});
export type RunnerOpsCheckpointCaptureResult = typeof RunnerOpsCheckpointCaptureResult.Type;

export class RunnerOpsError extends Schema.TaggedError<RunnerOpsError>()("RunnerOpsError", {
  operation: Schema.Literals([
    "search.entries",
    "search.contents",
    "search.refresh",
    "entries.browse",
    "processes.table",
    "ports.listeners",
    "checkpoint.capture",
  ]),
  failure: Schema.Union([ProjectEntriesFailure, Schema.Literal("failed")]),
}) {}

const RunnerOpsCallError = Schema.Union([RunnerLostError, RunnerSystemError, RunnerOpsError]);

/** Pages of `RUNNER_OPS_PAGE_BYTES`, as are contents and browse. */
const RunnerOpsSearchEntriesRpc = Rpc.make(RUNNER_METHODS.opsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: RunnerOpsCallError,
  stream: true,
});

const RunnerOpsSearchContentsRpc = Rpc.make(RUNNER_METHODS.opsSearchContents, {
  payload: ProjectSearchContentsInput,
  success: ProjectSearchContentsResult,
  error: RunnerOpsCallError,
  stream: true,
});

const RunnerOpsSearchRefreshRpc = Rpc.make(RUNNER_METHODS.opsSearchRefresh, {
  payload: Schema.Struct({ cwd: TrimmedNonEmptyString }),
  error: RunnerOpsCallError,
});

const RunnerOpsEntriesBrowseRpc = Rpc.make(RUNNER_METHODS.opsEntriesBrowse, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: RunnerOpsCallError,
  stream: true,
});

/** A snapshot first, then one on each change. */
const RunnerOpsProcessesTableRpc = Rpc.make(RUNNER_METHODS.opsProcessesTable, {
  payload: Schema.Struct({}),
  success: Schema.Array(ResourceMonitorProcessTableEntry),
  error: RunnerOpsCallError,
  stream: true,
});

/**
 * A snapshot first, then one on each change. Every listener is listed with a null terminal, which
 * the server fills; an agent's server carries the thread its process inherited.
 */
const RunnerOpsPortsListenersRpc = Rpc.make(RUNNER_METHODS.opsPortsListeners, {
  payload: Schema.Struct({ configuredUrls: Schema.Array(Schema.String) }),
  success: Schema.Array(DiscoveredLocalServer),
  error: RunnerOpsCallError,
  stream: true,
});

/** A `turn` capture also looks up the previous ref and summarizes the files, in one call. */
const RunnerOpsCheckpointCaptureRpc = Rpc.make(RUNNER_METHODS.opsCheckpointCapture, {
  payload: RunnerOpsCheckpointCaptureInput,
  success: RunnerOpsCheckpointCaptureResult,
  error: RunnerOpsCallError,
});

// The runner serves the core and the ops halves from separate layers.
export const RunnerCoreRpcGroup = RpcGroup.make(
  RunnerHelloRpc,
  RunnerEventsRpc,
  RunnerDrainRpc,
  RunnerProcessSpawnRpc,
  RunnerProcessOutputRpc,
  RunnerProcessWriteRpc,
  RunnerProcessCloseInputRpc,
  RunnerProcessSignalRpc,
  RunnerProcessWaitRpc,
  RunnerProcessReleaseRpc,
  RunnerProcessRunRpc,
  RunnerProcessRunStreamRpc,
  RunnerPtyOpenRpc,
  RunnerPtyOutputRpc,
  RunnerPtyInputRpc,
  RunnerPtyResizeRpc,
  RunnerPtySignalRpc,
  RunnerPtyWaitRpc,
  RunnerPtyReleaseRpc,
  RunnerFsStatRpc,
  RunnerFsReadDirectoryRpc,
  RunnerFsReadFileRpc,
  RunnerFsWriteFileRpc,
  RunnerFsMakeDirectoryRpc,
  RunnerFsRemoveRpc,
  RunnerFsRenameRpc,
  RunnerFsCopyRpc,
  RunnerFsRealPathRpc,
  RunnerFsReadLinkRpc,
  RunnerFsSymlinkRpc,
  RunnerFsChmodRpc,
  RunnerFsMakeTempDirectoryRpc,
  RunnerFsReadStreamRpc,
  RunnerFsWriteStreamOpenRpc,
  RunnerFsWriteStreamChunkRpc,
  RunnerFsWriteStreamCloseRpc,
  RunnerFsWatchRpc,
  RunnerForwardOpenRpc,
  RunnerForwardCloseRpc,
  RunnerTcpReadRpc,
  RunnerTcpWriteRpc,
  RunnerTcpCloseRpc,
);

export const RunnerOpsRpcGroup = RpcGroup.make(
  RunnerOpsSearchEntriesRpc,
  RunnerOpsSearchContentsRpc,
  RunnerOpsSearchRefreshRpc,
  RunnerOpsEntriesBrowseRpc,
  RunnerOpsProcessesTableRpc,
  RunnerOpsPortsListenersRpc,
  RunnerOpsCheckpointCaptureRpc,
);

export const RunnerRpcGroup = RunnerCoreRpcGroup.merge(RunnerOpsRpcGroup);
