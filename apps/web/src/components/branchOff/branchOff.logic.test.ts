import { describe, expect, it } from "vite-plus/test";

import { branchFromPrompt, threadsByLineage } from "./branchOff.logic";

describe("branchFromPrompt", () => {
  it.each([
    ["hanad/prompt-builder", "", "hanad/prompt-builder"],
    [
      "hanad/prompt-builder",
      "Add a one-line rationale to each generated question.",
      "hanad/add-a-one-line-rationale",
    ],
    ["prompt-builder", "Fix the Rubric's scoring!", "fix-the-rubric-s-scoring"],
    ["hanad/prompt-builder", "  ✨ …  ", "hanad/prompt-builder"],
  ])("%s with %j is %s", (suggested, prompt, expected) => {
    expect(branchFromPrompt(suggested, prompt)).toBe(expected);
  });
});

describe("threadsByLineage", () => {
  const thread = (id: string, source: string | null = null) => ({
    id,
    branchLink: { source: source === null ? null : { threadId: source } },
  });

  it("lists each source, then its branches under it; a branch of an unlisted source keeps its place", () => {
    const ordered = threadsByLineage([
      thread("rationale", "builder"),
      thread("builder"),
      thread("orphan", "elsewhere"),
      thread("fixtures"),
      thread("loading", "builder"),
    ]);
    expect(ordered.map(({ thread: { id }, indented }) => [id, indented])).toEqual([
      ["builder", false],
      ["rationale", true],
      ["loading", true],
      ["orphan", false],
      ["fixtures", false],
    ]);
  });
});
