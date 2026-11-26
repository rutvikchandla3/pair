import * as Schema from "effect/Schema";

/** A tool call a check looks for. Tool names are bare; `a|b` lists alternatives. */
export const ToolCallCheck = Schema.Struct({
  tool: Schema.String,
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type ToolCallCheck = typeof ToolCallCheck.Type;
/** `argsAnyOf`: the call must also match one of these. */
export const ToolCallCheckWithAlternatives = Schema.Struct({
  ...ToolCallCheck.fields,
  argsAnyOf: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
});
/** `success`: only a call that did not fail counts. */
export const ExpectedToolCall = Schema.Struct({
  ...ToolCallCheckWithAlternatives.fields,
  success: Schema.optional(Schema.Literal(true)),
});
export type ExpectedToolCall = typeof ExpectedToolCall.Type;

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const valueText = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");

const BOUND = /^([<>]=)(-?\d+(?:\.\d+)?)$/;
/**
 * Partial match: `~text` is a case-insensitive substring, `re:pattern` a regular expression,
 * `<=N` / `>=N` bound a number, and `null` matches a missing or null value.
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
  if (typeof expected === "string" && expected.startsWith("re:")) {
    return new RegExp(expected.slice(3)).test(valueText(actual));
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
  return Object.entries(expected).every(([path, value]) =>
    // Each expected field needs its own field, so one field cannot hold every value.
    path === "fields" && Array.isArray(value)
      ? matchesEach(value, at(path))
      : matches(value, at(path)),
  );
};

const matchesEach = (
  expected: ReadonlyArray<unknown>,
  actual: unknown,
  taken: ReadonlySet<number> = new Set(),
): boolean => {
  if (expected.length === 0) return true;
  const [first, ...rest] = expected;
  return (
    Array.isArray(actual) &&
    actual.some(
      (item, i) =>
        !taken.has(i) && matches(first, item) && matchesEach(rest, actual, new Set([...taken, i])),
    )
  );
};

/** Whether some call matches the check. */
export const foundCall = (
  calls: ReadonlyArray<{
    readonly tool: string;
    readonly input: unknown;
    readonly failed?: boolean | undefined;
  }>,
  { tool, args = {}, argsAnyOf, success }: ExpectedToolCall,
) =>
  calls.some(
    (call) =>
      tool.split("|").includes(call.tool) &&
      (success === undefined || call.failed === false) &&
      matches(args, call.input) &&
      (argsAnyOf === undefined ||
        argsAnyOf.some((alternative) => matches(alternative, call.input))),
  );

export const callLabel = ({ tool, args }: ToolCallCheck) =>
  args ? `${tool} ${valueText(args)}` : tool;
