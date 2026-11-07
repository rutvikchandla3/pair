import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";

/**
 * The server services coarse operations run, against the sandbox's own disk. Every path is local
 * here, the sandbox root included. No server config, settings or database.
 */
export const layer = Layer.mergeAll(
  CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer)),
  WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer)),
  PortScanner.layerAllListeners.pipe(Layer.provide(FetchHttpClient.layer)),
).pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(WorkspaceHosts.layerLocalOnly),
  Layer.provide(NodeCrypto.layer),
);
