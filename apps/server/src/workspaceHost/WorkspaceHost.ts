import type { AgentScopeShape } from "@t3tools/shared/AgentScope";
import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import type * as Brand from "effect/Brand";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
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
}

export class WorkspaceHostUnavailableError extends Schema.TaggedError<WorkspaceHostUnavailableError>()(
  "WorkspaceHostUnavailableError",
  { sandboxId: Schema.String },
) {
  override get message(): string {
    return "This thread's machine is not connected.";
  }
}
