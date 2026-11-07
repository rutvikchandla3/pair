import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";
import * as TestClock from "effect/testing/TestClock";
import {
  RUNNER_PROTOCOL_VERSION,
  RunnerHandleId,
  RunnerRpcGroup,
  type RunnerProcessSpawnInput,
} from "@t3tools/contracts/runner";

import { coalesceWatchEvents } from "./handlers.ts";
import * as RunnerTesting from "./runnerTesting.ts";
import { RunnerCredential } from "./RunnerSocketServer.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const env = { PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "xterm-256color" };
const bytes = (text: string) => encoder.encode(text);

const shell = (script: string, extra: Partial<RunnerProcessSpawnInput> = {}) =>
  ({
    command: "/bin/sh",
    args: ["-c", script],
    cwd: "/",
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    extraFds: [],
    ...extra,
  }) satisfies RunnerProcessSpawnInput;

const makeClient = RpcTest.makeClient(RunnerRpcGroup);
type Client = Effect.Success<typeof makeClient>;

const readText = (client: Client, handle: RunnerHandleId, fd: number, fromSeq = 0) =>
  client["process.output"]({ handle, fd, fromSeq }).pipe(
    Stream.runCollect,
    Effect.map((chunks) => ({
      text: chunks.map((chunk) => decoder.decode(chunk.data)).join(""),
      seqs: chunks.map((chunk) => chunk.seq),
    })),
  );

const withRunner = <A, E, R>(body: (client: Client) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    return yield* body(yield* makeClient);
  }).pipe(Effect.scoped, Effect.provide(RunnerTesting.layer));

describe("runner process handles", () => {
  it.effect("serves output from any seq it still holds, stamped with byte offsets", () =>
    withRunner((client) =>
      Effect.gen(function* () {
        const { handle } = yield* client["process.spawn"](shell("printf 'hello world'"));
        const all = yield* readText(client, handle, 1);
        expect(all.text).toBe("hello world");
        expect(all.seqs[0]).toBe(0);
        const tail = yield* readText(client, handle, 1, 6);
        expect(tail).toEqual({ text: "world", seqs: [6] });
        expect(yield* client["process.wait"]({ handle })).toEqual({ exitCode: 0, signal: null });
      }),
    ),
  );

  it.effect("applies each input seq once, in order, and reports it in hello", () =>
    withRunner((client) =>
      Effect.gen(function* () {
        const { handle } = yield* client["process.spawn"](shell("exec cat"));
        const write = (seq: number, text: string) =>
          client["process.write"]({ handle, fd: 0, seq, data: bytes(text) });
        expect(yield* write(1, "ping ")).toEqual({ appliedThrough: 1 });
        expect(yield* write(1, "ping ")).toEqual({ appliedThrough: 1 });
        expect(yield* write(2, "pong")).toEqual({ appliedThrough: 2 });
        expect(
          (yield* client["process.write"]({ handle, fd: 0, seq: 4, data: bytes("x") }).pipe(
            Effect.flip,
          ))._tag,
        ).toBe("RunnerSystemError");

        const info = yield* client["runner.hello"]({
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          serverBootId: "server-boot",
          leaseMs: 120_000,
          limits: {
            windowBytes: 262_144,
            windowChunks: 16,
            handleBufferBytes: 4_194_304,
            ptyBufferBytes: 1_048_576,
            sandboxBufferBytes: 67_108_864,
          },
          sandboxToken: Redacted.make("sandbox-token"),
        });
        expect(info).toMatchObject({
          runnerBuildId: RunnerTesting.TEST_RUNNER_BUILD_ID,
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          handles: [{ handle, next: { "in:0": 2 } }],
        });
        const credential = yield* RunnerCredential;
        expect(Redacted.value(yield* credential.authorization)).toBe("Bearer sandbox-token");

        yield* client["process.closeInput"]({ handle, fd: 0, seq: 3 });
        expect((yield* readText(client, handle, 1)).text).toBe("ping pong");
      }),
    ),
  );

  it.effect("resolves wait only after the output stream delivered its last byte", () =>
    withRunner((client) =>
      Effect.gen(function* () {
        // The leader exits at once; a background child holds stdout until fd 4 says go.
        const { handle } = yield* client["process.spawn"](
          shell("printf early; (read go <&4; printf late) & exit 0", {
            extraFds: [{ fd: 4, direction: "input" }],
          }),
        );
        const log: Array<string> = [];
        const waiter = yield* client["process.wait"]({ handle }).pipe(
          Effect.tap(() => Effect.sync(() => log.push("wait"))),
          Effect.forkChild,
        );
        yield* client["process.output"]({ handle, fd: 1, fromSeq: 0 }).pipe(
          Stream.runForEach((chunk) => {
            const text = decoder.decode(chunk.data);
            log.push(text);
            return text === "early"
              ? client["process.write"]({ handle, fd: 4, seq: 1, data: bytes("go\n") })
              : Effect.void;
          }),
        );
        expect(yield* Fiber.join(waiter)).toEqual({ exitCode: 0, signal: null });
        expect(log).toEqual(["early", "late", "wait"]);
      }),
    ),
  );

  it.effect("reads extra output fds", () =>
    withRunner((client) =>
      Effect.gen(function* () {
        const { handle } = yield* client["process.spawn"](
          shell("printf four >&4", { extraFds: [{ fd: 4, direction: "output" }] }),
        );
        expect((yield* readText(client, handle, 4)).text).toBe("four");
      }),
    ),
  );

  it.effect("kills the whole group on release", () =>
    withRunner((client) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-test-" });
        const fifo = path.join(dir, "held");
        const made = yield* client["process.run"]({
          command: "mkfifo",
          args: [fifo],
          cwd: dir,
          env,
        });
        expect(made.exitCode).toBe(0);
        // A second handle reads the FIFO; its cat exits once no writer holds the FIFO open.
        const reader = yield* client["process.spawn"](
          shell('exec cat "$FIFO"', { env: { ...env, FIFO: fifo } }),
        );
        // The background sleep opens the FIFO before it says ready and holds it until killed.
        const { handle } = yield* client["process.spawn"](
          shell('(exec 5>"$FIFO"; printf ready; exec sleep 1000) & wait', {
            env: { ...env, FIFO: fifo },
          }),
        );
        yield* client["process.output"]({ handle, fd: 1, fromSeq: 0 }).pipe(
          Stream.take(1),
          Stream.runDrain,
        );
        yield* client["process.release"]({ handle });
        expect(yield* client["process.wait"]({ handle: reader.handle })).toEqual({
          exitCode: 0,
          signal: null,
        });
        yield* client["process.release"]({ handle });
      }),
    ),
  );

  it.effect("fails an id from another runner boot as runner-restarted", () =>
    withRunner((client) =>
      Effect.gen(function* () {
        const handle = RunnerHandleId.make("another-boot:1");
        expect(yield* client["process.wait"]({ handle }).pipe(Effect.flip)).toMatchObject({
          _tag: "RunnerLostError",
          reason: "runner-restarted",
          handle,
        });
      }),
    ),
  );
});

describe("runner PTYs", () => {
  it.effect("echoes input and applies a resize before later input", () =>
    withRunner((client) =>
      Effect.gen(function* () {
        const { handle } = yield* client["pty.open"]({
          shell: "/bin/sh",
          args: ["-c", 'stty size; read line; stty size; printf "<%s>" "$line"'],
          cwd: "/",
          cols: 80,
          rows: 24,
          env,
        });
        let text = "";
        let sent = false;
        yield* client["pty.output"]({ handle, fromSeq: 0 }).pipe(
          Stream.runForEach((chunk) => {
            expect(chunk.seq).toBe(text.length);
            text += chunk.data;
            if (sent || !text.includes("24 80")) return Effect.void;
            sent = true;
            return client["pty.resize"]({ handle, seq: 1, cols: 100, rows: 30 }).pipe(
              Effect.andThen(client["pty.input"]({ handle, seq: 2, data: "hello\r" })),
            );
          }),
        );
        expect(text).toMatch(/24 80[\s\S]*hello[\s\S]*30 100[\s\S]*<hello>/);
        expect(yield* client["pty.wait"]({ handle })).toEqual({ exitCode: 0, signal: 0 });
      }),
    ),
  );
});

describe("runner files", () => {
  it.effect("maps the FileSystem calls and their errors", () =>
    withRunner((client) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-fs-" });
        const file = path.join(dir, "a.txt");

        yield* client["fs.writeFile"]({ path: file, data: bytes("0123456789"), atomic: true });
        expect(yield* client["fs.readDirectory"]({ path: dir })).toEqual(["a.txt"]);
        expect(
          decoder.decode(yield* client["fs.readFile"]({ path: file, offset: 2, maxBytes: 3 })),
        ).toBe("234");
        expect(
          decoder.decode(yield* client["fs.readFile"]({ path: file, offset: 8, maxBytes: 64 })),
        ).toBe("89");
        expect(yield* client["fs.stat"]({ path: file })).toMatchObject({
          type: "File",
          size: 10n,
        });

        yield* client["fs.makeDirectory"]({ path: path.join(dir, "x/y"), recursive: true });
        yield* client["fs.copy"]({ fromPath: file, toPath: path.join(dir, "x/y/b.txt") });
        yield* client["fs.rename"]({
          oldPath: path.join(dir, "x/y/b.txt"),
          newPath: path.join(dir, "x/c.txt"),
        });
        yield* client["fs.symlink"]({ fromPath: file, toPath: path.join(dir, "link") });
        expect(yield* client["fs.readLink"]({ path: path.join(dir, "link") })).toBe(file);
        expect(yield* client["fs.realPath"]({ path: path.join(dir, "link") })).toBe(
          yield* fs.realPath(file),
        );
        yield* client["fs.chmod"]({ path: file, mode: 0o600 });
        expect(((yield* client["fs.stat"]({ path: file })).mode & 0o777).toString(8)).toBe("600");
        expect(
          (yield* client["fs.makeTempDirectory"]({ directory: dir, prefix: "tmp-" })).startsWith(
            path.join(dir, "tmp-"),
          ),
        ).toBe(true);
        yield* client["fs.remove"]({ path: path.join(dir, "x"), recursive: true });
        expect(
          (yield* client["fs.readDirectory"]({ path: dir })).filter((name) => name === "x"),
        ).toEqual([]);

        expect(
          yield* client["fs.stat"]({ path: path.join(dir, "missing") }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "RunnerSystemError",
          reason: "NotFound",
          module: "FileSystem",
          method: "stat",
          pathOrDescriptor: path.join(dir, "missing"),
        });
      }),
    ),
  );

  it.effect("streams files in and out with seqs, writing atomically", () =>
    withRunner((client) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-fs-" });
        const file = path.join(dir, "stream.txt");

        const { handle } = yield* client["fs.writeStream.open"]({ path: file, atomic: true });
        const chunk = (seq: number, text: string) =>
          client["fs.writeStream.chunk"]({ handle, seq, data: bytes(text) });
        yield* chunk(1, "abc");
        yield* chunk(1, "abc");
        yield* chunk(2, "defgh");
        expect(yield* fs.exists(file)).toBe(false);
        yield* client["fs.writeStream.close"]({ handle });
        expect(yield* fs.readDirectory(dir)).toEqual(["stream.txt"]);

        const read = yield* client["fs.readStream"]({ path: file, offset: 1, chunkBytes: 3 }).pipe(
          Stream.runCollect,
        );
        expect(read.map(({ seq, data }) => [seq, decoder.decode(data)])).toEqual([
          [1, "bcd"],
          [4, "efg"],
          [7, "h"],
        ]);
      }),
    ),
  );

  // Live: the batch window is a real timer behind real inotify events, with no clock to drive.
  it.live("signals a ready watch, then reports events in batches", () =>
    withRunner((client) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-watch-" });
        const file = path.join(dir, "one");
        const batches = yield* Queue.unbounded<ReadonlyArray<{ readonly path: string }>>();
        yield* client["fs.watch"]({ path: dir, recursive: false }).pipe(
          Stream.runForEach((batch) => Queue.offer(batches, batch)),
          Effect.forkScoped,
        );
        expect(yield* Queue.take(batches)).toEqual([]);
        yield* fs.writeFileString(file, "1");
        const batch = yield* Queue.take(batches);
        expect(batch.map((event) => event.path)).toEqual(["one"]);
      }),
    ),
  );

  it.effect("coalesces a window's events into one batch, latest per path", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<FileSystem.WatchEvent>();
      const batches = yield* Queue.unbounded<ReadonlyArray<FileSystem.WatchEvent>>();
      yield* coalesceWatchEvents(Stream.fromQueue(events)).pipe(
        Stream.runForEach((batch) => Queue.offer(batches, batch)),
        Effect.forkScoped,
      );
      yield* Queue.offerAll(events, [
        { _tag: "Create", path: "/w/a" },
        { _tag: "Create", path: "/w/b" },
        { _tag: "Update", path: "/w/a" },
      ]);
      yield* TestClock.adjust("50 millis");
      expect(yield* Queue.take(batches)).toEqual([
        { _tag: "Create", path: "/w/b" },
        { _tag: "Update", path: "/w/a" },
      ]);
    }).pipe(Effect.scoped),
  );
});
