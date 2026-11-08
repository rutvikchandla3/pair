#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - a plain HTTP server, the digest check and the agent user.
/**
 * Proves a release's runner tree boots a machine: the real route and hub serve it, it is fetched
 * and unpacked the way `pair-bootstrap.sh` does, and the unpacked runner enrolls and runs a
 * command. Runs in release CI after the archive exists; not a test, since it needs the built tree.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";

import * as NodeEffectCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SandboxId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpRouter, HttpServer } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../src/config.ts";
import * as SqlitePersistence from "../src/persistence/Sqlite.ts";
import * as RunnerBundle from "../src/sandbox/runnerHub/RunnerBundle.ts";
import * as RunnerGrants from "../src/sandbox/runnerHub/RunnerGrants.ts";
import * as RunnerHub from "../src/sandbox/runnerHub/RunnerHub.ts";
import * as RunnerRoute from "../src/sandbox/runnerHub/RunnerRoute.ts";
import * as NodePtyAdapter from "../src/terminal/NodePtyAdapter.ts";
import * as WorkspaceHosts from "../src/workspaceHost/WorkspaceHosts.ts";

const CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";
// Covers a cold Node start and the hello; a runner that cannot enroll never gets there.
const ATTACH_TIMEOUT = Duration.seconds(60);

class RunnerReleaseSmokeError extends Schema.TaggedError<RunnerReleaseSmokeError>()(
  "RunnerReleaseSmokeError",
  { step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Runner release smoke failed while ${this.step}: ${this.detail}`;
  }
}

const fetchBundleFile = Effect.fn("fetchBundleFile")(function* (
  baseUrl: string,
  file: string,
  secret: string,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* httpClient.get(`${baseUrl}/runner/v1/bundle/${file}`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  if (response.status !== 200) {
    return yield* new RunnerReleaseSmokeError({
      step: `downloading ${file}`,
      detail: `HTTP ${response.status}`,
    });
  }
  return new Uint8Array(yield* response.arrayBuffer);
});

const smoke = Effect.fn("runnerReleaseSmoke")(
  function* (input: { readonly runnerDir: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runnerDir = path.resolve(input.runnerDir);
    const services = yield* Layer.build(
      HttpRouter.serve(RunnerRoute.layer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(NodeHttp.createServer, { port: 0, host: "127.0.0.1" }),
        ),
        Layer.provideMerge(
          Layer.mergeAll(
            RunnerHub.layer.pipe(
              // The smoke registers nothing anywhere a server would route to.
              Layer.provide(WorkspaceHosts.layer.pipe(Layer.provide(NodePtyAdapter.layer))),
              Layer.provideMerge(RunnerGrants.layer),
              Layer.provide(SqlitePersistence.layerMemory),
              Layer.provide(NodeEffectCrypto.layer),
            ),
            RunnerBundle.layerFromTree(runnerDir).pipe(
              Layer.provide(
                ServerConfig.layerTest(process.cwd(), { prefix: "t3-runner-release-smoke-" }),
              ),
              Layer.provide(NodeServices.layer),
            ),
          ),
        ),
      ),
    );
    const address = Context.get(services, HttpServer.HttpServer).address;
    if (address._tag === "UnixPathAddress") return yield* Effect.die(new Error("no TCP address"));
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const hub = Context.get(services, RunnerHub.RunnerHub);
    const bundle = yield* Context.get(services, RunnerBundle.RunnerBundle).current;
    const { runnerBuildId } = bundle;
    yield* Console.log(`[runner-smoke] serving runner ${runnerBuildId} from ${runnerDir}`);

    const sandboxId = SandboxId.make(`sbx_${"0".repeat(20)}`);
    const secret = Redacted.value(yield* hub.mintEnrollment(sandboxId, 1));

    // pair-bootstrap.sh: the digest first, then the tarball checked against it, then unpack.
    const digestLine = new TextDecoder().decode(
      yield* fetchBundleFile(baseUrl, `${runnerBuildId}.sha256`, secret),
    );
    const expected = digestLine.split(" ")[0];
    const tarball = yield* fetchBundleFile(baseUrl, `${runnerBuildId}.tar.gz`, secret);
    const actual = NodeCrypto.createHash("sha256").update(tarball).digest("hex");
    if (actual !== expected) {
      return yield* new RunnerReleaseSmokeError({
        step: "checking the bundle digest",
        detail: `${actual} is not the served ${expected}`,
      });
    }
    const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runner-release-smoke-" });
    const tree = path.join(scratch, "tree");
    const stateDir = path.join(scratch, "state");
    yield* fs.makeDirectory(tree);
    yield* fs.makeDirectory(stateDir);
    yield* fs.writeFile(path.join(scratch, "bundle.tar.gz"), tarball);
    const untar = yield* spawner.exitCode(
      ChildProcess.make("tar", ["-xzf", path.join(scratch, "bundle.tar.gz"), "-C", tree]),
    );
    if (untar !== 0) {
      return yield* new RunnerReleaseSmokeError({
        step: "unpacking the bundle",
        detail: `tar exited ${untar}`,
      });
    }
    yield* fs.writeFileString(path.join(stateDir, "enroll"), secret, { mode: 0o600 });

    // Before the spawn, so the hub's answer to the runner's hello is never missed.
    const attached = yield* hub.connection(sandboxId).pipe(Effect.forkScoped);
    yield* spawner.spawn(
      ChildProcess.make(process.execPath, [path.join(tree, "runner.mjs"), "runner"], {
        env: {
          PATH: CHILD_PATH,
          PAIR_RUNNER_URL: baseUrl,
          PAIR_SANDBOX_ID: sandboxId,
          PAIR_RUNNER_BUILD: runnerBuildId,
          PAIR_RUNNER_DIR: stateDir,
          PAIR_AGENT_USER: NodeOS.userInfo().username,
        },
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    const connection = yield* Fiber.join(attached).pipe(
      Effect.timeoutOrElse({
        duration: ATTACH_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new RunnerReleaseSmokeError({
              step: "attaching the unpacked runner",
              detail: `no runner.hello within ${Duration.format(ATTACH_TIMEOUT)}`,
            }),
          ),
      }),
    );

    const client = yield* connection.client;
    const result = yield* client["process.run"]({
      command: "/bin/sh",
      args: ["-c", "echo ok"],
      cwd: "/",
      env: { PATH: CHILD_PATH },
    });
    const stdout = new TextDecoder().decode(result.stdout);
    if (result.exitCode !== 0 || stdout !== "ok\n") {
      return yield* new RunnerReleaseSmokeError({
        step: "running echo ok through the runner",
        detail: `exit ${result.exitCode}, stdout: ${stdout}`,
      });
    }
    yield* Console.log(
      `[runner-smoke] runner ${runnerBuildId} downloaded, enrolled and ran \`echo ok\`.`,
    );
  },
  Effect.scoped,
  // Migrations and the runner connect log at info.
  Effect.provideService(References.MinimumLogLevel, "Warn"),
);

const command = Command.make(
  "runner-release-smoke",
  {
    runnerDir: Flag.String("runner-dir").pipe(
      Flag.withDescription("The runner/ tree of an unpacked Pair Cloud release archive."),
    ),
  },
  smoke,
).pipe(Command.withDescription("Serve a release's runner tree and attach a runner from it."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    NodeRuntime.runMain,
  );
}
