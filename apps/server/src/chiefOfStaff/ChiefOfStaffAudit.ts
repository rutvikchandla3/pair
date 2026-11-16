import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ARGS_CHARS = 1_000;
const MAX_AUDIT_ENTRIES = 200;
const DEFAULT_AUDIT_ENTRIES = 20;
const REDACTED = "[redacted]";

export type AuditVia = "voice" | "home-thread";
export type AuditOutcome = "ok" | "error";

export const AuditEntrySchema = Schema.Struct({
  at: Schema.String,
  memberId: Schema.optionalKey(Schema.String),
  via: Schema.Literals(["voice", "home-thread"]),
  threadId: Schema.optionalKey(Schema.String),
  tool: Schema.String,
  args: Schema.String,
  outcome: Schema.Literals(["ok", "error"]),
  errorCode: Schema.optionalKey(Schema.String),
  durationMs: Schema.Finite,
});
export type AuditEntry = typeof AuditEntrySchema.Type;

/** A call's parameters with secrets redacted, serialized and cut to 1000 characters. */
export interface AuditRecordInput {
  readonly memberId?: string;
  readonly via: AuditVia;
  readonly threadId?: string;
  readonly tool: string;
  readonly args: unknown;
  readonly outcome: AuditOutcome;
  readonly errorCode?: string;
  readonly durationMs: number;
}

export interface AuditReadOptions {
  readonly limit?: number;
  readonly tool?: string;
}

export class ChiefOfStaffAudit extends Context.Service<
  ChiefOfStaffAudit,
  {
    /** Appends one entry. Serialized and error-ignoring; callers fork it and return. */
    readonly record: (entry: AuditRecordInput) => Effect.Effect<void>;
    /** The newest entries first, from the current file and then the rotated one. */
    readonly recent: (options?: AuditReadOptions) => Effect.Effect<ReadonlyArray<AuditEntry>>;
  }
>()("t3/chiefOfStaff/ChiefOfStaffAudit") {}

const SECRET_KEY = /token|secret|password|authorization|api[_-]?key|cookie/i;
const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(AuditEntrySchema));
const encodeEntry = Schema.encodeSync(Schema.fromJsonString(AuditEntrySchema));

/** Replaces, at any depth, the value under a secret-looking key. */
const redactArgs = (value: unknown): unknown => {
  const seen = new WeakSet<object>();
  const walk = (current: unknown): unknown => {
    if (Array.isArray(current)) {
      if (seen.has(current)) return "[circular]";
      seen.add(current);
      const result = current.map(walk);
      seen.delete(current);
      return result;
    }
    if (typeof current === "object" && current !== null) {
      if (seen.has(current)) return "[circular]";
      seen.add(current);
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current)) {
        result[key] = SECRET_KEY.test(key) ? REDACTED : walk(item);
      }
      seen.delete(current);
      return result;
    }
    return current;
  };
  return walk(value);
};

/** JSON of `args` with secrets removed, cut to 1000 characters. */
const serializeArgs = (args: unknown): string => {
  let text: string;
  try {
    text = JSON.stringify(redactArgs(args)) ?? "null";
  } catch {
    return "[unserializable]";
  }
  return text.length > MAX_ARGS_CHARS ? text.slice(0, MAX_ARGS_CHARS) : text;
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(config.stateDir, "chief-of-staff");
  const file = path.join(directory, "audit.jsonl");
  const rotated = path.join(directory, "audit.1.jsonl");
  const writes = yield* Semaphore.make(1);

  const readEntries = (target: string): Effect.Effect<ReadonlyArray<AuditEntry>> =>
    fileSystem.readFileString(target).pipe(
      Effect.map((text) =>
        text.split("\n").flatMap((line) => {
          if (line.length === 0) return [];
          const entry = decodeEntry(line);
          return Option.isNone(entry) ? [] : [entry.value];
        }),
      ),
      Effect.orElseSucceed((): ReadonlyArray<AuditEntry> => []),
    );

  const append = Effect.fn("ChiefOfStaffAudit.append")(function* (entry: AuditEntry) {
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    const size = yield* fileSystem.stat(file).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );
    if (size > MAX_FILE_BYTES) {
      yield* fileSystem.rename(file, rotated).pipe(Effect.ignore);
    }
    const line = `${encodeEntry(entry)}\n`;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fileSystem.open(file, { flag: "a" });
        yield* handle.writeAll(new TextEncoder().encode(line));
      }),
    );
  });

  const newest = (
    entries: ReadonlyArray<AuditEntry>,
    collected: Array<AuditEntry>,
    limit: number,
    tool: string | undefined,
  ) => {
    for (let index = entries.length - 1; index >= 0 && collected.length < limit; index -= 1) {
      const entry = entries[index];
      if (entry !== undefined && (tool === undefined || entry.tool === tool)) collected.push(entry);
    }
  };

  const record = Effect.fn("ChiefOfStaffAudit.record")(
    function* (input: AuditRecordInput) {
      yield* append({
        at: DateTime.formatIso(yield* DateTime.now),
        ...(input.memberId === undefined ? {} : { memberId: input.memberId }),
        via: input.via,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        tool: input.tool,
        args: serializeArgs(input.args),
        outcome: input.outcome,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        durationMs: input.durationMs,
      });
    },
    (effect) =>
      effect.pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("Chief of staff audit write failed.", { cause }),
        ),
        Effect.ignore,
        writes.withPermits(1),
      ),
  );

  const recent = Effect.fn("ChiefOfStaffAudit.recent")(function* (options: AuditReadOptions = {}) {
    const limit = Math.max(0, Math.min(MAX_AUDIT_ENTRIES, options.limit ?? DEFAULT_AUDIT_ENTRIES));
    if (limit === 0) return [];
    const entries: Array<AuditEntry> = [];
    newest(yield* readEntries(file), entries, limit, options.tool);
    if (entries.length < limit) {
      newest(yield* readEntries(rotated), entries, limit, options.tool);
    }
    return entries;
  });

  return ChiefOfStaffAudit.of({ record, recent });
});

export const layer = Layer.effect(ChiefOfStaffAudit, make);
