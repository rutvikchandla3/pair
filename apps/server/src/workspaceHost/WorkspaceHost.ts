import type { AgentScopeShape } from "@t3tools/shared/AgentScope";
import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import type * as Brand from "effect/Brand";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the Claude Agent SDK's process type uses Node streams.
import type * as NodeStream from "node:stream";
import * as Schema from "effect/Schema";

/** "local" or a sandbox id. */
export type WorkspaceHostId = string & Brand.Brand<"WorkspaceHostId">;

export const LOCAL_WORKSPACE_HOST_ID = "local" as WorkspaceHostId;

/** Sandbox files live here at the same absolute path on the server's side and in the sandbox. */
export const SANDBOX_ROOT = "/t3-sandbox";

export interface WorkspaceHostInfo {
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly homeDirectory: string;
  /** Base env of every process this host starts. Local: the same `process.env` object, not a copy. */
  readonly environment: NodeJS.ProcessEnv;
  readonly userId: number | undefined;
  readonly executablePath: string;
}

export interface ProcessGroupSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface ProcessGroupHooks {
  readonly onExit?: (() => void) | undefined;
  readonly onStderr: (text: string) => void;
  readonly onStderrClose: () => void;
}

type ProcessExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

/** The members the Claude Agent SDK's `spawnClaudeCodeProcess` hook reads, plus stderr and pid. */
export interface ProcessGroupProcess {
  readonly stdin: NodeStream.Writable;
  readonly stdout: NodeStream.Readable;
  readonly stderr: NodeStream.Readable | null;
  readonly pid?: number | undefined;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: "exit", listener: ProcessExitListener): void;
  on(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: ProcessExitListener): void;
  once(event: "error", listener: (error: Error) => void): void;
  off(event: "exit", listener: ProcessExitListener): void;
  off(event: "error", listener: (error: Error) => void): void;
}

/** The machine a thread's workspace lives on. A value, not a layer. */
export interface WorkspaceHost {
  readonly id: WorkspaceHostId;
  readonly kind: "local" | "sandbox";
  /** Read per use, never captured: local code and tests override HostProcess per call. */
  readonly info: Effect.Effect<WorkspaceHostInfo>;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly pty: PtyAdapter.PtyAdapter["Service"];
  readonly agentScope: AgentScopeShape;
  /** The calls whose flags and errno codes workspace file safety depends on. */
  readonly files: WorkspaceHostFiles;
  /**
   * Spawns detached with a watcher that kills the whole group when the server's pipe closes.
   * Synchronous, unlike every other member: the Claude Agent SDK's spawn hook is synchronous.
   */
  readonly spawnProcessGroup: (
    input: ProcessGroupSpawnInput,
    hooks: ProcessGroupHooks,
  ) => ProcessGroupProcess;
}

export type WorkspaceFileKind = "File" | "Directory" | "SymbolicLink" | "Other";

export interface WorkspaceHostFiles {
  /** Native realpath: Windows `\\?\` paths and POSIX `link/..` resolve as the OS does. */
  readonly realPath: (path: string) => Effect.Effect<string, WorkspaceHostFileError>;
  readonly lstat: (
    path: string,
  ) => Effect.Effect<{ readonly kind: WorkspaceFileKind }, WorkspaceHostFileError>;
  readonly readDirectory: (
    path: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly name: string; readonly kind: WorkspaceFileKind }>,
    WorkspaceHostFileError
  >;
  /** Opens O_RDONLY|O_NONBLOCK (no FIFO hang), checks it is a file, reads at most `maxBytes`. */
  readonly readFile: (
    path: string,
    maxBytes: number,
  ) => Effect.Effect<
    | { readonly kind: "file"; readonly size: number; readonly bytes: Uint8Array }
    | { readonly kind: "not-file" },
    WorkspaceHostFileError
  >;
  /** O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW: a symlink swapped in after the check is not followed. */
  readonly writeNoFollow: (
    path: string,
    contents: Uint8Array | string,
  ) => Effect.Effect<void, WorkspaceHostFileError>;
}

export class WorkspaceHostFileError extends Schema.TaggedError<WorkspaceHostFileError>()(
  "WorkspaceHostFileError",
  {
    operation: Schema.Literals([
      "realpath",
      "lstat",
      "open",
      "stat",
      "read",
      "close",
      "write",
      "readdir",
    ]),
    /** The errno code, such as "ENOENT"; callers branch on it. */
    code: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file ${this.operation} failed.`;
  }
}

export class WorkspaceHostUnavailableError extends Schema.TaggedError<WorkspaceHostUnavailableError>()(
  "WorkspaceHostUnavailableError",
  { sandboxId: Schema.String },
) {
  override get message(): string {
    return "This thread's machine is not connected.";
  }
}
