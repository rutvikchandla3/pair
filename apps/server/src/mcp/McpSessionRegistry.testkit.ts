import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpSessionRegistry from "./McpSessionRegistry.ts";

export const layer = Layer.succeed(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.McpSessionRegistry.of({
    endpoint: "http://127.0.0.1/mcp",
    issue: ({ threadId, providerInstanceId }) =>
      Effect.succeed({
        config: {
          environmentId: EnvironmentId.make("environment:mcp-test"),
          threadId,
          providerSessionId: `mcp-test:${threadId}`,
          providerInstanceId,
          endpoint: "http://127.0.0.1/mcp",
          authorizationHeader: `Bearer mcp-test:${threadId}`,
          browserToolsAvailable: true,
        },
      }),
    issueClient: () =>
      Effect.succeed({
        sessionId: "mcp-test:client",
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer mcp-test:client",
      }),
    resolve: () => Effect.undefined,
    resolveClient: () => Effect.undefined,
    touch: () => Effect.void,
    revokeProviderSession: () => Effect.void,
    revokeThread: () => Effect.void,
    revokeClient: () => Effect.void,
    revokeAll: Effect.void,
  }),
);
