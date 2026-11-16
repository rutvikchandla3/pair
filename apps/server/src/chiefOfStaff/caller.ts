import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

/** The MCP client label the voice relay's credential carries (`McpSessionRegistry.issueClient`). */
export const CHIEF_OF_STAFF_MCP_LABEL = "Chief of staff";

export interface ChiefOfStaffCall {
  readonly via: "voice" | "home-thread";
  readonly memberId?: string;
  readonly threadId?: string;
}

/**
 * The single test for a Chief of staff caller: the voice relay's MCP client
 * label, or a thread whose id is one of this server's `home:*` home threads.
 */
export const chiefOfStaffCaller = (
  scope: McpInvocationScope,
  homeThreads: ReadonlyMap<string, string>,
): ChiefOfStaffCall | undefined => {
  const client = scope.client;
  if (client !== undefined && client.label === CHIEF_OF_STAFF_MCP_LABEL) {
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
