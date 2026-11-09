import * as Effect from "effect/Effect";

import { type ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import type * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

import {
  ensureSandboxProviderHome,
  sandboxProviderSessionEnvironmentFor,
} from "../sandbox/providers/SandboxProviderHome.ts";
import type { WorkspaceHost } from "../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../workspaceHost/WorkspaceHosts.ts";

export interface MachineInvestigation {
  readonly host: WorkspaceHost;
  /** The instance's session env and its own home there (README P1), never this server's. */
  readonly environment: Record<string, string>;
}

/**
 * An investigation reads its checkout, so it runs in the machine that holds it. Undefined for
 * every other request and for a checkout on this server: those run here.
 */
export const makeMachineInvestigationFor = Effect.gen(function* () {
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  const sessionEnvironment = yield* sandboxProviderSessionEnvironmentFor;
  return Effect.fn("TextGeneration.machineInvestigationFor")(function* (input: {
    readonly operation: TextGenerationOperations.Operation;
    readonly cwd: string;
    readonly instanceId: ProviderInstanceId;
    readonly homeVariable: "CLAUDE_CONFIG_DIR" | "CODEX_HOME";
  }) {
    const failed = (cause: { readonly _tag: string; readonly message: string }) =>
      new TextGenerationError({
        operation: input.operation,
        detail:
          cause._tag === "ProviderCloudLocalOnlyError"
            ? `Local only. ${cause.message}`
            : cause.message,
        cause,
      });
    const host = yield* hosts.forPath(input.cwd).pipe(Effect.mapError(failed));
    if (host.kind !== "sandbox") return undefined;
    const environment = yield* sessionEnvironment({
      host,
      instanceId: input.instanceId,
      threadId: undefined,
    }).pipe(Effect.mapError(failed));
    const home = yield* ensureSandboxProviderHome(host, input.instanceId).pipe(
      Effect.mapError(failed),
    );
    return {
      host,
      environment: { ...environment, [input.homeVariable]: home },
    } satisfies MachineInvestigation;
  });
});
