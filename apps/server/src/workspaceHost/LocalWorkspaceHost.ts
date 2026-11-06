import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  LOCAL_WORKSPACE_HOST_ID,
  type WorkspaceHost,
  type WorkspaceHostInfo,
} from "./WorkspaceHost.ts";

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
  } satisfies WorkspaceHost;
});
