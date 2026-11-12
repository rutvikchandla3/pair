import * as Schema from "effect/Schema";

/** A tool call a check looks for. Tool names are bare; `a|b` lists alternatives. */
export const ToolCallCheck = Schema.Struct({
  tool: Schema.String,
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type ToolCallCheck = typeof ToolCallCheck.Type;

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const valueText = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");

const BOUND = /^([<>]=)(-?\d+(?:\.\d+)?)$/;
/**
 * Partial match: `~text` is a case-insensitive substring, `<=N` / `>=N` bound a number, and `null`
 * matches a missing or null value.
 */
export const matches = (expected: unknown, actual: unknown): boolean => {
  if (expected === null) return actual === undefined || actual === null;
  const bound = typeof expected === "string" ? BOUND.exec(expected) : null;
  if (bound !== null) {
    const limit = Number(bound[2]);
    return typeof actual === "number" && (bound[1] === "<=" ? actual <= limit : actual >= limit);
  }
  if (typeof expected === "string" && expected.startsWith("~")) {
    return valueText(actual).toLowerCase().includes(expected.slice(1).toLowerCase());
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) && expected.every((item) => actual.some((at) => matches(item, at)))
    );
  }
  if (!isRecord(expected)) return expected === actual;
  const at = (path: string) =>
    path
      .split(".")
      .reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), actual);
  return Object.entries(expected).every(([path, value]) => matches(value, at(path)));
};

/** Whether some call matches the check. */
export const foundCall = (
  calls: ReadonlyArray<{ readonly tool: string; readonly input: unknown }>,
  { tool, args = {} }: ToolCallCheck,
) => calls.some((call) => tool.split("|").includes(call.tool) && matches(args, call.input));

export const callLabel = ({ tool, args }: ToolCallCheck) =>
  args ? `${tool} ${valueText(args)}` : tool;
