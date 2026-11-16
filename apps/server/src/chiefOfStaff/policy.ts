import { DEFAULT_CONFIRM_TOOLS } from "@t3tools/contracts";

/**
 * Tools whose arguments alone make a call risky: archiving or deleting a thread. The
 * tool is otherwise harmless, so these are not in `DEFAULT_CONFIRM_TOOLS`.
 */
const RISKY_ARGUMENTS: Readonly<Record<string, (args: Record<string, unknown>) => boolean>> = {
  t3_thread_organize: (args) => args["action"] === "archive",
  // No archive/delete action exists today; kept so a later one cannot slip past the gate.
  t3_thread_update: (args) => args["action"] === "archive" || args["action"] === "delete",
};

/**
 * Whether `tool` is one Chief of staff must get a person's approval for. `confirmTools` is
 * the member's list, `DEFAULT_CONFIRM_TOOLS` by default; the argument checks above add to it.
 */
export const isRiskyCall = (
  tool: string,
  args: unknown,
  confirmTools: ReadonlyArray<string> = DEFAULT_CONFIRM_TOOLS,
): boolean => {
  if (confirmTools.includes(tool)) return true;
  const risky = RISKY_ARGUMENTS[tool];
  if (risky === undefined) return false;
  return typeof args === "object" && args !== null && risky(args as Record<string, unknown>);
};

const SECRET_KEY = /token|secret|password|authorization|api[_-]?key|cookie/i;

/** A one-line, secret-free summary of a call's arguments for the approval card. */
export const summarizeCallArgs = (args: unknown, max = 200): string => {
  if (typeof args !== "object" || args === null) return "";
  const parts: Array<string> = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === undefined) continue;
    const shown = SECRET_KEY.test(key)
      ? "[redacted]"
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
    parts.push(`${key}=${shown}`);
  }
  const text = parts.join(", ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
