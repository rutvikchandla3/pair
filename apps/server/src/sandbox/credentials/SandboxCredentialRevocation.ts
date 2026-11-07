import type { SandboxId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { McpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import type { RunnerGrantError } from "../runnerHub/RunnerGrants.ts";
import { RunnerHub } from "../runnerHub/RunnerHub.ts";
import { GitHubAppInstallationTokens } from "./GitHubAppInstallationTokens.ts";

/**
 * Ends everything a sandbox was given (06 §7): its runner grant and socket, its threads' MCP
 * tokens and its cached installation tokens. Idempotent, so a replayed stop or destroy is safe.
 * The owner's own GitHub token is theirs and not ours to revoke.
 */
export class SandboxCredentialRevocation extends Context.Service<
  SandboxCredentialRevocation,
  {
    readonly revoke: (input: {
      readonly sandboxId: SandboxId;
      readonly threadIds: ReadonlyArray<ThreadId>;
    }) => Effect.Effect<void, RunnerGrantError>;
  }
>()("t3/sandbox/credentials/SandboxCredentialRevocation") {}

export const layer = Layer.effect(
  SandboxCredentialRevocation,
  Effect.gen(function* () {
    const hub = yield* RunnerHub;
    const mcp = yield* McpSessionRegistry;
    const installationTokens = yield* GitHubAppInstallationTokens;

    const revoke: SandboxCredentialRevocation["Service"]["revoke"] = Effect.fn(
      "SandboxCredentials.revoke",
    )(function* ({ sandboxId, threadIds }) {
      yield* hub.revoke(sandboxId);
      yield* Effect.forEach(threadIds, mcp.revokeThread, { discard: true });
      yield* installationTokens.revoke(sandboxId);
    });

    return SandboxCredentialRevocation.of({ revoke });
  }),
);
