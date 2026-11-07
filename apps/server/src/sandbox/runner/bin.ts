/**
 * The runner bundle's entry (`runner.mjs`). In a sandbox `t3` is this file, so it also answers
 * the fast paths agents spawn there; the full CLI reaches `t3 runner` through `src/bin.ts`.
 */
import { isEntrypoint } from "../../entrypoint.ts";

export const runRunnerCli = async (argv: ReadonlyArray<string>): Promise<void> => {
  if (argv.length > 0) {
    process.stderr.write(`t3 runner takes no arguments, got: ${argv.join(" ")}\n`);
    process.exitCode = 64;
    return;
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
