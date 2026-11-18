import { workEntryDisplayIndicatesToolFailure, type TimelineEntry } from "../../session-logic";

// Providers prefix MCP tools differently (`mcp__server__bot_ask`, `server/bot_ask`); match the suffix.
const BOT_TOOL_NAME = /(?:^|[^a-z0-9])(bot_[a-z_]+)$/i;

function botToolCall(entry: TimelineEntry): { name: string; input: unknown } | null {
  if (entry.kind !== "work") return null;
  const item = entry.entry.projectedItem?.item ?? entry.entry.structuredPayload;
  if (item?.type !== "dynamic_tool" || item.toolName === null) return null;
  const name = BOT_TOOL_NAME.exec(item.toolName)?.[1];
  return name === undefined ? null : { name: name.toLowerCase(), input: item.input };
}

function inputField(input: unknown, key: string): unknown {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

const DECISIVE_BOT_TOOLS = new Set(["bot_ask", "bot_learn", "bot_forget"]);

export interface BotTurnSummary {
  /** `bot_session_respond` calls: sessions answered from memory without asking the user. */
  readonly memoryAnswers: number;
  /** The turn called `bot_ask`, so the question it wrote must stay visible. */
  readonly asked: boolean;
  /** The bot wrote to the user or asked, finished, learned or forgot something. */
  readonly decisive: boolean;
}

export function summarizeBotTurn(entries: ReadonlyArray<TimelineEntry>): BotTurnSummary {
  let memoryAnswers = 0;
  let asked = false;
  let decisive = false;
  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.role === "assistant") {
      decisive = true;
      continue;
    }
    const call = botToolCall(entry);
    if (call === null) continue;
    if (call.name === "bot_ask") asked = true;
    if (
      DECISIVE_BOT_TOOLS.has(call.name) ||
      (call.name === "bot_job_update" && inputField(call.input, "status") != null)
    ) {
      decisive = true;
    }
    if (
      call.name === "bot_session_respond" &&
      entry.kind === "work" &&
      !workEntryDisplayIndicatesToolFailure(entry.entry)
    ) {
      memoryAnswers += 1;
    }
  }
  return { memoryAnswers, asked, decisive };
}

export function botMemoryNote(memoryAnswers: number, merged: boolean): string | undefined {
  if (memoryAnswers === 0) return undefined;
  return memoryAnswers === 1 && !merged
    ? "answered from memory"
    : `answered ${memoryAnswers} from memory`;
}
