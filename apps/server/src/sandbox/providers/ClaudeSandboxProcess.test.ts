import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as WorkspaceHostLoopback from "../../workspaceHost/WorkspaceHostLoopback.ts";
import * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";
import { makeSandboxClaudeProcess } from "./ClaudeSandboxProcess.ts";

const STDOUT_BYTES = 8 * 1024 * 1024;

// Subprocess fixture: the runner runs a fake `claude` from the sandbox PATH.
it.live("streams a sandbox CLI's stdout as the SDK reads it and exits after stderr", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // The bundle directory leads the sandbox PATH, so its `claude` is the image's.
    const bundle = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-bridge-" });
    yield* fileSystem.writeFileString(
      path.join(bundle, "claude"),
      `#!/bin/sh\nprintf '%s' "$*" >&2\nhead -c ${STDOUT_BYTES} /dev/zero\n`,
    );
    yield* fileSystem.chmod(path.join(bundle, "claude"), 0o755);
    yield* Effect.gen(function* () {
      const host = yield* (yield* WorkspaceHosts.WorkspaceHosts).forPath(bundle);
      const { runner } = yield* WorkspaceHostLoopback.LoopbackRunner;
      let stderr = "";
      const spawnClaude = yield* makeSandboxClaudeProcess({
        host,
        onStderr: (text) => {
          stderr += text;
        },
      });
      const child = spawnClaude({
        // The SDK's script entry on the server: dropped for the sandbox's own `claude`.
        command: "/server/node",
        args: ["/server/claude-code/cli.js", "--print"],
        cwd: bundle,
        env: (yield* host.info).environment,
        // @effect-diagnostics-next-line abortControllerInEffect:off - the SDK's spawn options carry one.
        signal: new AbortController().signal,
      });
      const exited = new Promise<{ code: number | null; stderr: string }>((resolve) =>
        child.once("exit", (code) => resolve({ code, stderr })),
      );

      // Nothing reads stdout yet: the runner pauses the CLI's pipe instead of buffering it.
      yield* runner.table.pressure.pipe(
        Stream.filter((pressure) => pressure.pausedHandles === 1),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      const received = yield* Effect.promise(async () => {
        let bytes = 0;
        for await (const chunk of child.stdout) bytes += (chunk as Buffer).length;
        return bytes;
      });
      assert.equal(received, STDOUT_BYTES);
      assert.deepEqual(yield* Effect.promise(() => exited), { code: 0, stderr: "--print" });
      assert.equal(child.exitCode, 0);
    }).pipe(
      Effect.provide(WorkspaceHostLoopback.layerLoopback(bundle, { bundleDirectory: bundle })),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
