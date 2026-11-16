import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

/** The MCP client label the voice relay's credential carries (`McpSessionRegistry.issueClient`). */
export const CHIEF_OF_STAFF_MCP_LABEL = "Chief of staff";

/**
 * The MCP client sessions `ChiefOfStaffVoice` issued. Any OAuth client can call itself
 * "Chief of staff", so detection is by the session id this server minted, not the label.
 * In-memory on purpose: a restarted server issues fresh client sessions.
 */
const issuedSessions = new Set<string>();

export const ChiefOfStaffClients = {
  add: (sessionId: string): void => {
    issuedSessions.add(sessionId);
  },
  remove: (sessionId: string): void => {
    issuedSessions.delete(sessionId);
  },
  has: (sessionId: string): boolean => issuedSessions.has(sessionId),
} as const;

export interface ChiefOfStaffCall {
  readonly via: "voice" | "home-thread";
  readonly memberId?: string;
  readonly threadId?: string;
}

/**
 * The single test for a Chief of staff caller: a session id `ChiefOfStaffVoice` issued
 * (`ChiefOfStaffClients`), or a thread whose id is one of this server's `home:*` home threads.
 */
export const chiefOfStaffCaller = (
  scope: McpInvocationScope,
  homeThreads: ReadonlyMap<string, string>,
): ChiefOfStaffCall | undefined => {
  const client = scope.client;
  if (client !== undefined && ChiefOfStaffClients.has(client.sessionId)) {
    return {
      via: "voice",
      ...(client.memberId === undefined ? {} : { memberId: client.memberId }),
    };
  }
  const threadId = scope.thread?.threadId;
  if (threadId === undefined) return undefined;
  const memberId = homeThreads.get(threadId);
  return memberId === undefined ? undefined : { via: "home-thread", memberId, threadId };
};
