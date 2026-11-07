// @effect-diagnostics nodeBuiltinImport:off -- fixtures: a FIFO and the test's own temp root.
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import { RunnerHub } from "../sandbox/runnerHub/RunnerHub.ts";
import { isRunnerLost, SANDBOX_ROOT, WorkspaceHostUnavailableError } from "./WorkspaceHost.ts";
import * as WorkspaceHostLoopback from "./WorkspaceHostLoopback.ts";
import * as WorkspaceHosts from "./WorkspaceHosts.ts";

const tmpRoot = NodeOS.tmpdir();
const layerTest = WorkspaceHostLoopback.layerLoopback(tmpRoot).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-host-" });
});

const hostFor = (path: string) =>
  Effect.flatMap(WorkspaceHosts.WorkspaceHosts, (hosts) => hosts.forPath(path));

/** A FIFO the child writes `started` to once it runs; reading it waits for that. */
const startSignal = Effect.gen(function* () {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fifo = path.join(yield* tempDir, "started");
  yield* spawner.exitCode(ChildProcess.make("mkfifo", [fifo]));
  const started = FileSystem.FileSystem.use((fs) => fs.readFileString(fifo));
  return { fifo, started };
});

/** The runner's next `handle.exited`, listened for from now on. */
const nextExit = Effect.gen(function* () {
  const { runner } = yield* WorkspaceHostLoopback.LoopbackRunner;
  return yield* runner.table.events.pipe(
    Stream.filter((event) => event._tag === "handle.exited"),
    Stream.runHead,
    Effect.forkChild({ startImmediately: true }),
  );
});

it.layer(layerTest)("SandboxWorkspaceHost on the loopback runner", (it) => {
  it.effect("routes the registered root and the hub's sandbox root to the sandbox host", () =>
    Effect.gen(function* () {
      const hosts = yield* WorkspaceHosts.WorkspaceHosts;
      const { sandboxId } = yield* WorkspaceHostLoopback.LoopbackRunner;
      const host = yield* hosts.forPath(`${tmpRoot}/a/b`);
      assert.equal(host.kind, "sandbox");
      assert.equal(host.id, sandboxId as string);
      assert.strictEqual(yield* hosts.forPath(`${SANDBOX_ROOT}/${sandboxId}/worktrees/x`), host);
      assert.strictEqual(yield* hosts.forPath("/somewhere/else"), hosts.local);
      assert.isUndefined(hosts.local.invoke);
      assert.isDefined(host.invoke);
      const info = yield* host.info;
      assert.equal(info.platform, "linux");
      assert.isTrue(info.environment.PATH?.startsWith(`/opt/pair-runner/`));
    }),
  );

  it.effect("runs a process with the host's base environment and stdin", () =>
    Effect.gen(function* () {
      const cwd = yield* tempDir;
      const host = yield* hostFor(cwd);
      const output = yield* host.spawner.string(
        ChildProcess.make("/bin/sh", ["-c", 'read line; printf "%s %s %s" "$line" "$PWD" "$X"'], {
          cwd,
          env: { X: "extended" },
          extendEnv: true,
          stdin: Stream.make(new TextEncoder().encode("hello\n")),
        }),
      );
      assert.equal(output, `hello ${cwd} extended`);
      const lines = yield* host.spawner.lines(
        ChildProcess.make("/bin/sh", ["-c", 'echo "$HOME"; echo "${SERVER_ONLY:-none}"'], { cwd }),
      );
      assert.deepEqual(lines, [(yield* host.info).homeDirectory, "none"]);
    }),
  );

  it.effect("kills the process when a running spawner.string is interrupted", () =>
    Effect.gen(function* () {
      const host = yield* hostFor(tmpRoot);
      const { fifo, started } = yield* startSignal;
      const exited = yield* nextExit;
      const running = yield* host.spawner
        .string(
          ChildProcess.make("/bin/sh", ["-c", 'echo started > "$1"; exec sleep 300', "sh", fifo]),
        )
        .pipe(Effect.forkChild);
      assert.equal(yield* started, "started\n");
      yield* Fiber.interrupt(running);
      assert.isTrue(Option.isSome(yield* Fiber.join(exited)));
    }),
  );

  it.effect("closing a spawn scope signals with killSignal and escalates on the runner", () =>
    Effect.gen(function* () {
      const host = yield* hostFor(tmpRoot);
      const { runner } = yield* WorkspaceHostLoopback.LoopbackRunner;
      for (const { script, killSignal, expected } of [
        // The frame's killSignal reaches the group: the trap answers it. `wait` runs the trap at
        // once, where a foreground `sleep` loop can swallow the signal between its fork and exec.
        {
          script: "trap 'exit 7' USR1",
          killSignal: "SIGUSR1" as const,
          expected: { exitCode: 7, signal: null },
        },
        // TERM is ignored by the whole group, so only forceKillAfter's SIGKILL ends it.
        {
          script: "trap '' TERM",
          killSignal: "SIGTERM" as const,
          expected: { exitCode: null, signal: "SIGKILL" },
        },
      ]) {
        const { fifo, started } = yield* startSignal;
        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* host.spawner.spawn(
              ChildProcess.make(
                "/bin/sh",
                ["-c", `${script}; echo started > "$1"; sleep 300 & wait`, "sh", fifo],
                { killSignal, forceKillAfter: "100 millis", stdout: "ignore", stderr: "ignore" },
              ),
            );
            assert.equal(yield* started, "started\n");
            const [handle] = yield* runner.table.live;
            // Started now: the scope's release removes the handle from the table.
            return yield* runner.table
              .wait(handle!.handle)
              .pipe(Effect.forkChild({ startImmediately: true }));
          }),
        );
        assert.deepInclude(yield* Fiber.join(exit), { _tag: "process", exit: expected });
      }
    }),
  );

  it.effect("signals a process group by its in-sandbox pid", () =>
    Effect.gen(function* () {
      const host = yield* hostFor(tmpRoot);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* host.spawner.spawn(
            ChildProcess.make("sleep", ["300"], { stdout: "ignore", stderr: "ignore" }),
          );
          yield* host.processes.signalGroup(handle.pid, "SIGTERM");
          const failure = yield* Effect.flip(handle.exitCode);
          assert.include(failure.message, "SIGTERM");
          assert.isFalse(isRunnerLost(failure));
        }),
      );
    }),
  );

  it.effect("reads, writes and lists files with the local host's flags and errno codes", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const cwd = yield* tempDir;
      const host = yield* hostFor(cwd);
      const file = path.join(cwd, "a.txt");
      const large = new Uint8Array(300 * 1024).map((_, index) => index % 251);
      yield* host.files.writeNoFollow(file, large);
      const read = yield* host.files.readFile(file, 1024 * 1024);
      assert.equal(read.kind, "file");
      if (read.kind === "file") assert.deepEqual(read.bytes, large);
      const capped = yield* host.files.readFile(file, 10);
      assert.deepInclude(capped, { kind: "file", size: large.length });

      yield* host.fileSystem.symlink(file, path.join(cwd, "link"));
      const refused = yield* Effect.flip(host.files.writeNoFollow(path.join(cwd, "link"), "x"));
      assert.deepInclude(refused, { operation: "write", code: "ELOOP" });
      assert.deepEqual(yield* host.files.lstat(path.join(cwd, "link")), { kind: "SymbolicLink" });
      assert.equal(yield* host.files.realPath(path.join(cwd, "link")), file);
      const missing = yield* Effect.flip(host.files.realPath(path.join(cwd, "nope")));
      assert.deepInclude(missing, { operation: "realpath", code: "ENOENT" });

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      yield* spawner.exitCode(ChildProcess.make("mkfifo", [path.join(cwd, "fifo")]));
      assert.deepEqual(yield* host.files.readFile(path.join(cwd, "fifo"), 16), {
        kind: "not-file",
      });

      yield* host.fileSystem.makeDirectory(path.join(cwd, "dir", "inner"), { recursive: true });
      assert.deepEqual(
        (yield* host.files.readDirectory(cwd)).toSorted((l, r) => l.name.localeCompare(r.name)),
        [
          { name: "a.txt", kind: "File" },
          { name: "dir", kind: "Directory" },
          { name: "fifo", kind: "Other" },
          { name: "link", kind: "SymbolicLink" },
        ],
      );
      assert.isFalse(yield* host.files.removeEmptyDirectory(path.join(cwd, "dir")));
      assert.isTrue(yield* host.files.removeEmptyDirectory(path.join(cwd, "dir", "inner")));

      // The derived FileSystem helpers ride the same calls.
      assert.isTrue(yield* host.fileSystem.exists(file));
      assert.isFalse(yield* host.fileSystem.exists(path.join(cwd, "nope")));
      assert.deepEqual(yield* host.fileSystem.readFile(file), large);
      const ranged = yield* host.fileSystem
        .stream(file, { offset: 5, bytesToRead: 3 })
        .pipe(Stream.runCollect);
      assert.deepEqual(
        ranged.flatMap((chunk) => [...chunk]),
        [5, 6, 7],
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const opened = yield* host.fileSystem.open(file);
          yield* opened.seek(250n, "start");
          assert.deepEqual(Option.getOrThrow(yield* opened.readAlloc(3)), large.subarray(250, 253));
        }),
      );
    }),
  );

  it.effect("round-trips a PTY and reports its exit", () =>
    Effect.gen(function* () {
      const cwd = yield* tempDir;
      const host = yield* hostFor(cwd);
      const pty = yield* host.pty.spawn({
        shell: "/bin/sh",
        args: ["-c", 'read line; echo "got:$line"'],
        cwd,
        cols: 80,
        rows: 24,
        env: { PATH: "/usr/bin:/bin", TERM: "xterm" },
      });
      const exited = yield* Deferred.make<number>();
      const got = yield* Deferred.make<void>();
      let output = "";
      pty.onData((data) => {
        output += data;
        if (output.includes("got:hello")) Deferred.doneUnsafe(got, Effect.void);
      });
      pty.onExit((event) => Deferred.doneUnsafe(exited, Effect.succeed(event.exitCode)));
      pty.write("hello\n");
      yield* Deferred.await(got);
      assert.equal(yield* Deferred.await(exited), 0);
    }),
  );
});

// Live: the runner coalesces watch events on its clock.
it.live("watches through the runner and reports ready first", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const cwd = yield* tempDir;
    const host = yield* hostFor(cwd);
    const ready = yield* Deferred.make<void>();
    const first = yield* host.fileSystem
      .watch(cwd, { onReady: () => Deferred.doneUnsafe(ready, Effect.void) })
      .pipe(Stream.runHead, Effect.forkChild);
    yield* Deferred.await(ready);
    yield* host.fileSystem.writeFileString(path.join(cwd, "new.txt"), "x");
    const event = Option.getOrThrow(yield* Fiber.join(first));
    assert.include(event.path, "new.txt");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

describe("SandboxWorkspaceHost after its runner boot is gone", () => {
  it.effect("fails a running process's exitCode with isRunnerLost and closes the root", () =>
    Effect.gen(function* () {
      const hosts = yield* WorkspaceHosts.WorkspaceHosts;
      const hub = yield* RunnerHub;
      const { sandboxId, socket } = yield* WorkspaceHostLoopback.LoopbackRunner;
      const sandboxPath = `${SANDBOX_ROOT}/${sandboxId}/worktrees/a`;
      const host = yield* hosts.forPath(sandboxPath);
      const handle = yield* host.spawner.spawn(
        ChildProcess.make("sleep", ["300"], { stdout: "ignore", stderr: "ignore" }),
      );
      const exitCode = yield* Effect.flip(handle.exitCode).pipe(Effect.forkChild);

      // A blip inside the lease keeps the registration.
      yield* socket.drop;
      yield* socket.runnerEnded;
      yield* hub.status(sandboxId).pipe(
        Stream.filter((status) => status._tag === "reconnecting"),
        Stream.runHead,
      );
      assert.strictEqual(yield* hosts.forPath(sandboxPath), host);

      yield* TestClock.adjust("120 seconds");
      const lost = yield* Fiber.join(exitCode);
      assert.isTrue(isRunnerLost(lost));
      const unavailable = yield* Effect.flip(hosts.forPath(sandboxPath));
      assert.instanceOf(unavailable, WorkspaceHostUnavailableError);
      assert.equal(unavailable.sandboxId, sandboxId);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
