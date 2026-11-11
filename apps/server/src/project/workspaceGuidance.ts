export const WORKSPACE_GUIDANCE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** Written into a workspace thread's folder, which the agent starts in but is not a repository. */
export function workspaceGuidanceText(input: {
  readonly roots: ReadonlyArray<{ readonly name: string; readonly title: string }>;
}): string {
  const example = input.roots[0]?.name ?? "<folder>";
  return [
    "# Workspace",
    "",
    "This folder is not a git repository. It holds several independent git repositories:",
    "",
    ...input.roots.map((root) => `- \`${root.name}/\`: ${root.title}`),
    "",
    "Each repository has its own branch, commits and pull request.",
    "Before changing one, read that repository's own AGENTS.md or CLAUDE.md.",
    `Run git inside the repository's folder (for example \`git -C ${example} status\`), never in this folder.`,
    "",
  ].join("\n");
}
