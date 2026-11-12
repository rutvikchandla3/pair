import {
  type AuthMcpClientAccess,
  type MemberId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  /** False omits the preview capability wherever the token is honored. Defaults to full access. */
  readonly browserToolsAvailable?: boolean;
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
  readonly subagent?: boolean;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

/** A client caller held in memory, for a process this server runs on a member's behalf. */
export interface McpClientCredentialRequest {
  readonly label: string;
  readonly access: AuthMcpClientAccess;
  readonly memberId: MemberId;
}

export interface McpIssuedClientCredential {
  readonly sessionId: string;
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

export interface McpSessionRegistryShape {
  /** The `/mcp` URL issued configs carry; sandbox forwards proxy to it. */
  readonly endpoint: string;
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly issueClient: (
    request: McpClientCredentialRequest,
  ) => Effect.Effect<McpIssuedClientCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpThreadInvocationScope | undefined>;
  readonly resolveClient: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeClient: (sessionId: string) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly lastAliveAt: number;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  readonly now?: () => number;
}

/**
 * `/mcp` is outside environment auth, so idle tokens stop authenticating.
 * Keep expired records until explicit revocation: a trusted provider turn can
 * refresh the token its subprocess still holds; MCP requests cannot.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const getHttpMcpEndpointHost = (address: NetAddress.IpAddress): string =>
  NetAddress.isUnspecified(address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address));

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const endpoint = NetAddress.isInetAddress(httpServer.address)
    ? `http://${getHttpMcpEndpointHost(httpServer.address.address)}:${httpServer.address.port}/mcp`
    : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const store = (tokenHash: string, scope: McpInvocationContext.McpInvocationScope) =>
    SynchronizedRef.update(state, ({ records }) => {
      const next = new Map(records);
      next.set(tokenHash, { tokenHash, scope, lastAliveAt: scope.issuedAt });
      return { records: next };
    });

  const newToken = random.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      const providerSessionId = yield* random.uuidV4();
      const rawToken = yield* newToken;
      const tokenHash = yield* hashToken(rawToken);
      const browserToolsAvailable = request.browserToolsAvailable ?? true;
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId,
        requestNamespace: providerSessionId,
        thread: {
          threadId: ThreadId.make(request.threadId),
          providerSessionId,
          providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
          subagent: request.subagent === true,
        },
        client: undefined,
        capabilities: new Set<McpInvocationContext.McpCapability>([
          "orchestration",
          "worktree",
          "pull-requests",
          ...(request.capabilities ?? (browserToolsAvailable ? (["preview"] as const) : [])),
        ]),
        issuedAt,
      };
      yield* store(tokenHash, scope);
      return {
        config: {
          environmentId,
          threadId: scope.thread.threadId,
          providerSessionId,
          providerInstanceId: scope.thread.providerInstanceId,
          endpoint,
          authorizationHeader: `Bearer ${rawToken}`,
          browserToolsAvailable: scope.capabilities.has("preview"),
          capabilities: scope.capabilities,
        },
      };
    },
  );

  const issueClient: McpSessionRegistryShape["issueClient"] = Effect.fn(
    "McpSessionRegistry.issueClient",
  )(function* (request) {
    const issuedAt = yield* currentTimeMillis;
    const sessionId = yield* random.uuidV4();
    const rawToken = yield* newToken;
    yield* store(yield* hashToken(rawToken), {
      environmentId,
      requestNamespace: `client:${sessionId}`,
      thread: undefined,
      client: {
        sessionId,
        memberId: request.memberId,
        label: request.label,
        access: request.access,
      },
      capabilities: new Set<McpInvocationContext.McpCapability>([
        "orchestration",
        "worktree",
        "pull-requests",
      ]),
      issuedAt,
    });
    return { sessionId, endpoint, authorizationHeader: `Bearer ${rawToken}` };
  });

  // Untraced: `resolve` and `resolveClient` are the spans.
  const lookup = Effect.fnUntraced(function* (rawToken: string) {
    if (rawToken.length === 0) return undefined;
    const tokenHash = yield* hashToken(rawToken);
    const timestamp = yield* currentTimeMillis;
    return yield* SynchronizedRef.modify(state, ({ records }) => {
      const record = records.get(tokenHash);
      if (!record || timestamp - record.lastAliveAt > livenessWindowMs) {
        return [undefined, { records }] as const;
      }
      const next = new Map(records);
      next.set(tokenHash, { ...record, lastAliveAt: timestamp });
      return [record.scope, { records: next }] as const;
    });
  });

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      const scope = yield* lookup(rawToken);
      return scope?.thread === undefined
        ? undefined
        : (scope as McpInvocationContext.McpThreadInvocationScope);
    },
  );

  const resolveClient: McpSessionRegistryShape["resolveClient"] = Effect.fn(
    "McpSessionRegistry.resolveClient",
  )(function* (rawToken) {
    const scope = yield* lookup(rawToken);
    return scope?.client === undefined ? undefined : scope;
  });

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const timestamp = yield* currentTimeMillis;
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(records);
        for (const [tokenHash, record] of records) {
          if (record.scope.thread?.threadId === threadId) {
            next.set(tokenHash, { ...record, lastAliveAt: timestamp });
          }
        }
        return { records: next };
      });
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.update(state, ({ records }) => ({
      records: new Map(Array.from(records).filter(([, record]) => !predicate(record))),
    }));

  return McpSessionRegistry.of({
    endpoint,
    issue,
    issueClient,
    resolve,
    resolveClient,
    touch,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere(
          (record) => record.scope.thread?.providerSessionId === providerSessionId,
        );
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.thread?.threadId === threadId);
    }),
    revokeClient: Effect.fn("McpSessionRegistry.revokeClient")(function* (sessionId) {
      yield* revokeWhere((record) => record.scope.client?.sessionId === sessionId);
    }),
    revokeAll: SynchronizedRef.set(state, { records: new Map() }),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

export const __testing = {
  make: makeWithOptions,
};
