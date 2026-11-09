import {
  TeamImageBuildLogChunk,
  TeamImageBuildPhase,
  type TeamImageBuildPhase as Phase,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerConfig } from "../../config.ts";
import { secretFragments, TEAM_IMAGE_PHASE_MARKER } from "./teamImageBuildProgram.ts";

const FILE_LIMIT_BYTES = 1024 * 1024;
const RING_LIMIT_BYTES = 4 * 1024 * 1024;
const TAIL_LINES = 30;

export interface TeamImageBuildLogWriter {
  /** Writes one line; a phase marker is kept out of the log and returned instead. */
  readonly write: (line: string) => Effect.Effect<Phase | null, PlatformError.PlatformError>;
  /** The last 30 lines, for a failure's `logTail`. */
  readonly tail: Effect.Effect<ReadonlyArray<string>>;
}

/**
 * One file per build under `<stateDir>/team-image/builds/<number>.log`. Lines stream to readers
 * only while the build's writer is open; after that a read is the file.
 */
export class TeamImageBuildLog extends Context.Service<
  TeamImageBuildLog,
  {
    /**
     * Every line has the `redact` values replaced with `***` before the file, the ring and live
     * readers see it. The writer closes with the scope: the ring is appended and live readers end.
     */
    readonly open: (
      number: number,
      redact: ReadonlyArray<string>,
    ) => Effect.Effect<TeamImageBuildLogWriter, PlatformError.PlatformError, Scope.Scope>;
    /** Waits until the build's writer is open; returns at once if it is. */
    readonly whenOpen: (number: number) => Effect.Effect<void>;
    /** What is written so far, then live lines while the writer is open, then `done`. */
    readonly read: (
      number: number,
    ) => Stream.Stream<TeamImageBuildLogChunk, PlatformError.PlatformError>;
    /** Removes a finished build's file; a missing one is already gone. */
    readonly delete: (number: number) => Effect.Effect<void, PlatformError.PlatformError>;
  }
>()("t3/sandbox/image/TeamImageBuildLog") {}

interface OpenLog {
  readonly lock: Semaphore.Semaphore;
  readonly lines: PubSub.PubSub<string | null>;
  fileBytes: number;
  ring: Array<string>;
  ringBytes: number;
  leftOutBytes: number;
  tail: Array<string>;
}

const isPhase = Schema.is(TeamImageBuildPhase);
const encoder = new TextEncoder();

/** Replaces every secret value with `***`; matching is per line, so a split value is not one. */
const redactor = (values: ReadonlyArray<string>) => {
  const fragments = [...new Set(values.flatMap(secretFragments))].toSorted(
    (a, b) => b.length - a.length,
  );
  return (line: string) =>
    fragments.reduce((text, fragment) => text.replaceAll(fragment, "***"), line);
};

const leftOutLine = (bytes: number) => `… ${bytes} bytes left out …\n`;

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const directory = path.join(config.stateDir, "team-image", "builds");
  const logs = new Map<number, OpenLog>();
  const openNumbers = yield* SubscriptionRef.make<ReadonlySet<number>>(new Set());
  const setOpen = (number: number, open: boolean) =>
    SubscriptionRef.update(openNumbers, (current) => {
      const next = new Set(current);
      if (open) next.add(number);
      else next.delete(number);
      return next;
    });
  const fileOf = (number: number) => path.join(directory, `${number}.log`);

  // The ring, with the left-out line before it when the ring dropped lines.
  const ringText = (log: OpenLog) =>
    (log.leftOutBytes > 0 ? leftOutLine(log.leftOutBytes) : "") + log.ring.join("");

  const open = Effect.fn("TeamImageBuildLog.open")(function* (
    number: number,
    redact: ReadonlyArray<string>,
  ) {
    const redactLine = redactor(redact);
    yield* fs.makeDirectory(directory, { recursive: true });
    const file = yield* fs.open(fileOf(number), { flag: "w" });
    const log: OpenLog = {
      lock: yield* Semaphore.make(1),
      lines: yield* PubSub.unbounded<string | null>(),
      fileBytes: 0,
      ring: [],
      ringBytes: 0,
      leftOutBytes: 0,
      tail: [],
    };
    logs.set(number, log);
    yield* setOpen(number, true);
    yield* Effect.addFinalizer(() =>
      log.lock.withPermits(1)(
        Effect.gen(function* () {
          logs.delete(number);
          yield* setOpen(number, false);
          const rest = ringText(log);
          if (rest !== "") yield* file.writeAll(encoder.encode(rest)).pipe(Effect.ignore);
          yield* PubSub.publish(log.lines, null);
        }),
      ),
    );

    const write = Effect.fn("TeamImageBuildLog.write")(function* (raw: string) {
      if (raw.startsWith(TEAM_IMAGE_PHASE_MARKER)) {
        const phase = raw.slice(TEAM_IMAGE_PHASE_MARKER.length).trim();
        return isPhase(phase) ? phase : null;
      }
      const line = redactLine(raw);
      const text = `${line}\n`;
      const bytes = encoder.encode(text);
      yield* log.lock.withPermits(1)(
        Effect.gen(function* () {
          log.tail.push(line);
          if (log.tail.length > TAIL_LINES) log.tail.shift();
          if (log.ring.length === 0 && log.fileBytes + bytes.length <= FILE_LIMIT_BYTES) {
            yield* file.writeAll(bytes);
            log.fileBytes += bytes.length;
          } else {
            log.ring.push(text);
            log.ringBytes += bytes.length;
            while (log.ringBytes > RING_LIMIT_BYTES) {
              const dropped = encoder.encode(log.ring.shift()!).length;
              log.ringBytes -= dropped;
              log.leftOutBytes += dropped;
            }
          }
          yield* PubSub.publish(log.lines, text);
        }),
      );
      return null;
    });

    return {
      write,
      tail: Effect.sync(() => [...log.tail]),
    } satisfies TeamImageBuildLogWriter;
  });

  const readFile = (number: number) =>
    fs
      .readFileString(fileOf(number))
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")));

  const read = (number: number) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const log = logs.get(number);
        if (log === undefined) {
          return Stream.make({ text: yield* readFile(number), done: true });
        }
        // Under the writer's lock, so no line lands between the copy and the subscription.
        const { text, lines } = yield* log.lock.withPermits(1)(
          Effect.all({
            lines: PubSub.subscribe(log.lines),
            text: readFile(number).pipe(Effect.map((file) => file + ringText(log))),
          }),
        );
        const live = Stream.fromSubscription(lines).pipe(
          Stream.takeWhile((line): line is string => line !== null),
          Stream.chunks,
          Stream.map((batch): TeamImageBuildLogChunk => ({ text: batch.join(""), done: false })),
        );
        return Stream.make({ text, done: false }).pipe(
          Stream.concat(live),
          Stream.concat(Stream.make({ text: "", done: true })),
        );
      }),
    ).pipe(Stream.withSpan("TeamImageBuildLog.read"));

  return TeamImageBuildLog.of({
    open,
    whenOpen: Effect.fn("TeamImageBuildLog.whenOpen")((number: number) =>
      SubscriptionRef.changes(openNumbers).pipe(
        Stream.filter((open) => open.has(number)),
        Stream.runHead,
        Effect.asVoid,
      ),
    ),
    read,
    delete: Effect.fn("TeamImageBuildLog.delete")((number: number) =>
      fs.remove(fileOf(number), { force: true }),
    ),
  });
});

export const layer = Layer.effect(TeamImageBuildLog, make);
