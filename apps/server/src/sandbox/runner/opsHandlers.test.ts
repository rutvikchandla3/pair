import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CheckpointRef } from "@t3tools/contracts";
import {
  RUNNER_OPS_PAGE_BYTES,
  RunnerOpsRpcGroup,
  RunnerRpcGroup,
} from "@t3tools/contracts/runner";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as RpcTest from "effect/rpc/RpcTest";
import * as TestClock from "effect/testing/TestClock";

import * as ProcessRunner from "../../processRunner.ts";
import * as NodePtyAdapter from "../../terminal/NodePtyAdapter.ts";
import * as OpsHandlers from "./opsHandlers.ts";
import * as OpsLayer from "./opsLayer.ts";
import * as RunnerTesting from "./runnerTesting.ts";

const makeClient = RpcTest.makeClient(RunnerRpcGroup);
type Client = Effect.Success<typeof makeClient>;

const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp" };
const decoder = new TextDecoder();

const git = (client: Client, cwd: string, args: ReadonlyArray<string>) =>
  client["process.run"]({ command: "git", args, cwd, env }).pipe(
    Effect.tap((result) =>
      result.exitCode === 0
        ? Effect.void
        : Effect.die(new Error(`git ${args.join(" ")}: ${decoder.decode(result.stderr)}`)),
    ),
    Effect.map((result) => decoder.decode(result.stdout).trim()),
  );

/** A repo with one commit, created through the runner's own `process.run`. */
const makeRepo = (client: Client) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-runner-ops-" });
    yield* git(client, cwd, ["init", "-q"]);
    yield* git(client, cwd, ["config", "user.email", "test@test.com"]);
    yield* git(client, cwd, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(cwd, "a.txt"), "one\n");
    yield* git(client, cwd, ["add", "."]);
    yield* git(client, cwd, ["commit", "-q", "-m", "initial"]);
    return cwd;
  });

const withRunner = <A, E, R>(body: (client: Client) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    return yield* body(yield* makeClient);
  }).pipe(Effect.scoped, Effect.provide(RunnerTesting.layer));

describe("runner coarse operations", () => {
  it.live("captures a turn with its commit and files, and leaves an existing baseline alone", () =>
    withRunner((client) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeRepo(client);
        const baselineRef = CheckpointRef.make("refs/t3/checkpoints/test/0");
        const turnRef = CheckpointRef.make("refs/t3/checkpoints/test/1");
        const baseline = { _tag: "baseline", cwd, checkpointRef: baselineRef } as const;

        const first = yield* client["ops.checkpoint.capture"](baseline);
        expect(first.commitOid).toBe(yield* git(client, cwd, ["rev-parse", baselineRef]));
        expect(yield* client["ops.checkpoint.capture"](baseline)).toEqual({
          status: "ready",
          commitOid: null,
          files: [],
          warnings: [],
        });

        yield* fileSystem.writeFileString(path.join(cwd, "a.txt"), "two\n");
        const turn = yield* client["ops.checkpoint.capture"]({
          _tag: "turn",
          cwd,
          checkpointRef: turnRef,
          previousCheckpointRef: baselineRef,
        });
        expect(turn).toEqual({
          status: "ready",
          commitOid: yield* git(client, cwd, ["rev-parse", turnRef]),
          files: [{ path: "a.txt", kind: "modified", additions: 1, deletions: 1 }],
          warnings: [],
        });
      }),
    ),
  );

  it.live("finds a new file after search.refresh and maps entries errors to their category", () =>
    withRunner((client) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeRepo(client);
        const search = client["ops.search.entries"]({ cwd, query: "fresh", limit: 10 }).pipe(
          Stream.runCollect,
          Effect.map((pages) => pages.flatMap((page) => page.entries)),
        );
        expect(yield* search).toEqual([]);

        yield* fileSystem.writeFileString(path.join(cwd, "fresh-file.ts"), "export {};\n");
        yield* client["ops.search.refresh"]({ cwd });
        expect((yield* search).map((entry) => entry.path)).toEqual(["fresh-file.ts"]);

        const notDirectory = yield* client["ops.entries.browse"]({
          cwd: path.join(cwd, "a.txt"),
        }).pipe(Stream.runDrain, Effect.flip);
        expect(notDirectory).toMatchObject({
          _tag: "RunnerOpsError",
          operation: "entries.browse",
          failure: "workspace_root_not_directory",
        });
      }),
    ),
  );

  it.live("sends a long listing in pages that each fit a frame", () =>
    withRunner((client) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-runner-ops-pages-" });
        const names = Array.from(
          { length: 2_000 },
          (_, index) => `${String(index).padStart(4, "0")}-${"x".repeat(120)}.ts`,
        );
        yield* Effect.forEach(
          names,
          (name) => fileSystem.writeFileString(path.join(cwd, name), ""),
          { concurrency: 32, discard: true },
        );

        const pages = yield* client["ops.entries.browse"]({ cwd }).pipe(Stream.runCollect);

        expect(pages.length).toBeGreaterThan(1);
        for (const page of pages) {
          const bytes = page.entries.reduce(
            (total, entry) => total + Buffer.byteLength(JSON.stringify(entry)),
            0,
          );
          expect(bytes).toBeLessThanOrEqual(RUNNER_OPS_PAGE_BYTES);
        }
        expect(pages.flatMap((page) => page.entries.map((entry) => entry.path)).toSorted()).toEqual(
          names,
        );
      }),
    ),
  );

  it.effect("reads the process table each second while subscribed and sends only changes", () => {
    const table = (names: ReadonlyArray<string>) =>
      names.map((name, index) => `${index + 2} 1 ${name}`).join("\n");
    return Effect.gen(function* () {
      const reads = yield* Queue.unbounded<void>();
      const outputs = [table(["sh", "node"]), table(["sh", "node"]), table(["sh", "vite"])];
      const runner = ProcessRunner.ProcessRunner.of({
        run: () =>
          Queue.offer(reads, undefined).pipe(
            Effect.as({
              stdout: outputs.shift() ?? table(["sh", "vite"]),
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
          ),
      });
      const client = yield* RpcTest.makeClient(RunnerOpsRpcGroup).pipe(
        Effect.provide(
          OpsHandlers.layer.pipe(
            Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
            Layer.provide(OpsLayer.layer),
            Layer.provide(NodePtyAdapter.layer),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      const tables = yield* client["ops.processes.table"]({}).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* Queue.take(reads);
      yield* TestClock.adjust("1 second");
      yield* Queue.take(reads);
      yield* TestClock.adjust("1 second");
      yield* Queue.take(reads);

      expect(yield* Fiber.join(tables)).toEqual([
        [
          { pid: 2, ppid: 1, name: "sh" },
          { pid: 3, ppid: 1, name: "node" },
        ],
        [
          { pid: 2, ppid: 1, name: "sh" },
          { pid: 3, ppid: 1, name: "vite" },
        ],
      ]);
    }).pipe(Effect.scoped);
  });
});
