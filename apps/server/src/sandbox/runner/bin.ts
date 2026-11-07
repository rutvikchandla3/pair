/**
 * The runner bundle's entry (`runner.mjs`). In a sandbox `t3` is this file, so it also answers
 * the fast paths agents spawn there; the full CLI reaches `t3 runner` through `src/bin.ts`.
 */
import { isEntrypoint } from "../../entrypoint.ts";

/** Exit code for a Node outside the bundle's range: the image owns Node (05), not the runner. */
const EXIT_UNSUPPORTED_NODE = 78;

/** The bundle's `MANIFEST.json` sits beside `runner.mjs`; a full CLI build has none. */
const bundleNodeRange = async (): Promise<string | undefined> => {
  const { readFile } = await import("node:fs/promises");
  try {
    const manifest: unknown = JSON.parse(
      await readFile(new URL("./MANIFEST.json", import.meta.url), "utf8"),
    );
    return typeof manifest === "object" &&
      manifest !== null &&
      "node" in manifest &&
      typeof manifest.node === "string"
      ? manifest.node
      : undefined;
  } catch {
    return undefined;
  }
};

const runPrefetchCli = async (argv: ReadonlyArray<string>): Promise<void> => {
  if (argv.length !== 1) {
    process.stderr.write("usage: t3 runner prefetch <runnerBuildId>\n");
    process.exitCode = 64;
    return;
  }
  const [NodeRuntime, NodeServices, Effect, { prefetch }] = await Promise.all([
    import("@effect/platform-node/NodeRuntime"),
    import("@effect/platform-node/NodeServices"),
    import("effect/Effect"),
    import("./prefetch.ts"),
  ]);
  NodeRuntime.runMain(prefetch(argv[0]!).pipe(Effect.provide(NodeServices.layer)));
};

export const runRunnerCli = async (argv: ReadonlyArray<string>): Promise<void> => {
  if (argv[0] === "prefetch") return runPrefetchCli(argv.slice(1));
  if (argv[0] === "git-credential") {
    const { runGitCredentialHelper } = await import("./gitCredentialHelper.ts");
    return runGitCredentialHelper(argv.slice(1));
  }
  if (argv.length > 0) {
    process.stderr.write(
      `t3 runner takes no arguments, prefetch or git-credential, got: ${argv.join(" ")}\n`,
    );
    process.exitCode = 64;
    return;
  }
  const nodeRange = await bundleNodeRange();
  if (nodeRange !== undefined) {
    const { satisfiesSemverRange } = await import("@t3tools/shared/semver");
    if (!satisfiesSemverRange(process.versions.node, nodeRange)) {
      process.stderr.write(`t3 runner needs Node ${nodeRange}, running ${process.versions.node}\n`);
      process.exitCode = EXIT_UNSUPPORTED_NODE;
      return;
    }
  }
  const [NodeRuntime, Exit, Runtime, { runRunner }] = await Promise.all([
    import("@effect/platform-node/NodeRuntime"),
    import("effect/Exit"),
    import("effect/Runtime"),
    import("./main.ts"),
  ]);
  NodeRuntime.runMain(runRunner(), {
    teardown: (exit, onExit) =>
      Exit.isSuccess(exit) && typeof exit.value === "number"
        ? onExit(exit.value)
        : Runtime.defaultTeardown(exit, onExit),
  });
};

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  const command = process.argv[2];
  if (command === "runner") {
    await runRunnerCli(process.argv.slice(3));
  } else if (command === "__managed-chatgpt-token") {
    const { runManagedChatGptTokenCli } = await import("../../cli/managedChatGptToken.ts");
    await runManagedChatGptTokenCli(process.argv.slice(3));
  } else if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("../../mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else {
    process.stderr.write(`t3 in a sandbox runs only: runner, acp-mcp-bridge, acp-mcp-call\n`);
    process.exitCode = 64;
  }
}
