import type { LineageStartFrom, RunId } from "@t3tools/contracts";

const PROMPT_WORDS = 5;

/** "rationale-per-question" from the prompt's first words; empty when it has none. */
function slugOf(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word !== "")
    .slice(0, PROMPT_WORDS)
    .join("-");
}

/**
 * The branch name the draft shows until the user edits it: the server's suggestion, with its
 * last segment replaced by the prompt's first words once there are some.
 */
export function branchFromPrompt(suggested: string, prompt: string): string {
  const slug = slugOf(prompt);
  if (slug === "") return suggested;
  const slash = suggested.lastIndexOf("/");
  return slash === -1 ? slug : `${suggested.slice(0, slash + 1)}${slug}`;
}

/** Start from's select value: `latest`, `turn:<runId>` or `branch`. */
export type StartFromValue = "latest" | "branch" | `turn:${string}`;

export function startFromOf(value: StartFromValue, branch: string): LineageStartFrom | null {
  if (value === "latest") return { type: "latest" };
  if (value === "branch") {
    const trimmed = branch.trim();
    return trimmed === "" ? null : { type: "branch", branch: trimmed };
  }
  return { type: "turn", runId: value.slice("turn:".length) as RunId };
}

interface LineageOrdered {
  readonly id: string;
  readonly branchLink?: { readonly source: { readonly threadId: string } | null } | undefined;
}

/**
 * A task's threads by lineage: each source, then its branches under it. A branch whose source
 * isn't listed keeps its place.
 */
export function threadsByLineage<T extends LineageOrdered>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<{ readonly thread: T; readonly indented: boolean }> {
  const listed = new Set(threads.map((thread) => thread.id));
  const sourceOf = (thread: T) => thread.branchLink?.source?.threadId ?? null;
  return threads.flatMap((thread) => {
    const source = sourceOf(thread);
    if (source !== null && listed.has(source)) return [];
    return [
      { thread, indented: false },
      ...threads
        .filter((candidate) => sourceOf(candidate) === thread.id)
        .map((branch) => ({ thread: branch, indented: true })),
    ];
  });
}
