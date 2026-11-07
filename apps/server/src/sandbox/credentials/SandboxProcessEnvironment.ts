import type { RunnerInfo } from "@t3tools/contracts/runner";

/**
 * The base environment of every process the server starts in a sandbox: the image's own `ENV`
 * with Pair's names over it. Never anything from the server's environment.
 */
export const sandboxBaseEnvironment = (info: RunnerInfo): Record<string, string> => {
  const image = info.imageEnvironment;
  return {
    ...image,
    // The bundle's `t3` first, for ACP bridges and the Codex auth command.
    PATH: image.PATH ? `${info.bundleDirectory}:${image.PATH}` : info.bundleDirectory,
    HOME: info.agent.homeDirectory,
    SHELL: info.agent.shell,
    USER: "t3",
    LANG: image.LANG ?? "C.UTF-8",
    TERM: "xterm-256color",
  };
};
