import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CloudOnlyRefusedError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as WorkspaceHosts from "../workspaceHost/WorkspaceHosts.ts";

// Defined in contracts so wire errors share them.
export { CLOUD_ONLY_MESSAGE, CloudOnlyRefusedError } from "@t3tools/contracts";

/**
 * On a cloud-only server, fails unless `path` belongs to a sandbox host; a null path is the
 * server's own. A sandbox path whose machine is not connected passes: its routing fails closed.
 */
export const refuseLocalHost = Effect.fn("CloudOnly.refuseLocalHost")(function* (
  operation: string,
  path: string | null | undefined,
) {
  const { cloudOnly } = yield* ServerConfig.ServerConfig;
  if (!cloudOnly) return;
  if (path === null || path === undefined) {
    return yield* new CloudOnlyRefusedError({ operation });
  }
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  const host = yield* hosts.forPath(path).pipe(Effect.option);
  if (Option.isSome(host) && host.value.kind !== "sandbox") {
    return yield* new CloudOnlyRefusedError({ operation });
  }
});

/** `refuseLocalHost` with its services read once, for a service whose methods require none. */
export const localHostGuard = Effect.gen(function* () {
  const context = yield* Effect.context<
    ServerConfig.ServerConfig | WorkspaceHosts.WorkspaceHosts
  >();
  return (operation: string, path: string | null | undefined) =>
    refuseLocalHost(operation, path).pipe(Effect.provide(context));
});
