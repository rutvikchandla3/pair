import type { RunnerForwardName } from "@t3tools/contracts/runner";

import type { ListenTarget } from "./HandleTable.ts";

/** Fixed, so git's helper finds it without per-process env; one per sandbox. */
export const GIT_CREDENTIAL_SOCKET = "git-credential.sock";

/** MCP clients take a URL, so `mcp` listens on loopback; the others are Unix sockets. */
export const listenTarget = (
  name: RunnerForwardName,
  runnerDir: string,
  unique: string,
): ListenTarget => {
  switch (name) {
    case "mcp":
      return { _tag: "tcp" };
    case "codex-token":
      return { _tag: "unix", path: `${runnerDir}/codex-token-${unique}.sock` };
    case "git-credential":
      return { _tag: "unix", path: `${runnerDir}/${GIT_CREDENTIAL_SOCKET}` };
  }
};
