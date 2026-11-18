/**
 * A synchronous, in-memory index of bot home and session threads, so notifiers can ask without
 * resolving a service. `BotService` fills it from the database at startup and updates it on every
 * write.
 */
const homeThreads = new Map<string, string>();
const sessionThreads = new Map<string, string>();

export const BotThreads = {
  isBotThread(threadId: string): boolean {
    return homeThreads.has(threadId) || sessionThreads.has(threadId);
  },
  homeBotId(threadId: string): string | undefined {
    return homeThreads.get(threadId);
  },
  sessionBotId(threadId: string): string | undefined {
    return sessionThreads.get(threadId);
  },
  setHome(threadId: string, botId: string): void {
    homeThreads.set(threadId, botId);
  },
  clearHome(threadId: string): void {
    homeThreads.delete(threadId);
  },
  setSession(threadId: string, botId: string): void {
    sessionThreads.set(threadId, botId);
  },
  clearSession(threadId: string): void {
    sessionThreads.delete(threadId);
  },
  reset(): void {
    homeThreads.clear();
    sessionThreads.clear();
  },
};

/**
 * Session requests the bot has left unanswered long enough (or can't answer while paused) that
 * they go to the owner's Inbox. Synchronous, like the thread index above, so an Inbox read can ask
 * without resolving a service.
 */
const escalations = new Set<string>();
const escalationKey = (threadId: string, requestId: string) => `${threadId}:${requestId}`;

export const BotEscalations = {
  mark(threadId: string, requestId: string): void {
    escalations.add(escalationKey(threadId, requestId));
  },
  clear(threadId: string, requestId: string): void {
    escalations.delete(escalationKey(threadId, requestId));
  },
  isEscalated(threadId: string, requestId: string): boolean {
    return escalations.has(escalationKey(threadId, requestId));
  },
  reset(): void {
    escalations.clear();
  },
};
