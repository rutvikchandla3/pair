import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  repositories: null as readonly unknown[] | null,
  diffPreviewCwds: [] as string[],
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: null,
    error: null,
    isPending: atom !== null,
    refresh: () => {},
  }),
}));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: "connected", error: null, traceId: null } },
  }),
}));
vi.mock("../../state/session", () => ({ environmentSession: { sessionStateAtom: () => null } }));
vi.mock("@t3tools/client-runtime/state/filesystem", () => ({
  resolveFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("../../state/use-thread-detail", () => ({
  useSelectedThreadProjection: () => ({ projection: null }),
}));
vi.mock("@t3tools/client-runtime/state/thread-checkpoints", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  deriveThreadCheckpointSummaries: () =>
    [1, 2].map((turn) => ({
      runId: `run-${turn}`,
      checkpointTurnCount: turn,
      checkpointRef: `ref-${turn}`,
      status: "ready",
      files: [{ path: "shop-web/src/app.ts", kind: "modified", additions: 1, deletions: 0 }],
      assistantMessageId: null,
    })),
}));
vi.mock("../../state/queries", () => ({
  useCheckpointDiff: () => ({ data: null, error: null, isPending: false, refresh: () => {} }),
}));
vi.mock("../../state/review", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    reviewEnvironment: {
      diffPreview: ({ input }: { input: { cwd: string } }) => {
        harness.diffPreviewCwds.push(input.cwd);
        return Atom.make(null);
      },
    },
    lastReviewGitSectionsAtom: () =>
      Atom.make([
        { kind: "branch-range", title: "Changes", diff: "", baseRef: "main", truncated: false },
        { kind: "working-tree", title: "Uncommitted", diff: "", truncated: false },
      ]),
  };
});
vi.mock("../../state/reviewTurnDiffs", async () => {
  const { Atom } = await import("effect/reactivity");
  return { lastReviewTurnDiffsAtom: () => Atom.make({}) };
});
vi.mock("../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: "/threads/checkout" }),
  useSelectedThreadRepositories: () => harness.repositories,
}));
vi.mock("./reviewState", () => ({ setReviewSelectedSectionId: () => {} }));

import { useReviewSections } from "./useReviewSections";

it.each([
  [
    "one repository",
    null,
    ["/threads/checkout"],
    ["turn:2", "turn:1", "git:branch-range", "git:working-tree"],
    "git:branch-range",
  ],
  ["a workspace", [], [], ["turn:2", "turn:1"], "turn:2"],
] as const)(
  "offers %s only the review modes its folder can read",
  (_, repositories, previewCwds, ids, selected) => {
    harness.repositories = repositories;
    harness.diffPreviewCwds = [];
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement("div"));
    let seen: { ids: string[]; selected: string | null } | null = null;
    function Consumer() {
      const { reviewSections, selectedSection } = useReviewSections({
        environmentId: EnvironmentId.make("environment"),
        threadId: ThreadId.make("thread"),
        reviewCache: {
          threadKey: "environment:thread",
          selectedSectionId: null,
          expandedFileIdsBySection: {},
          revealedLargeFileIdsBySection: {},
          viewedFileIdsBySection: {},
        },
      });
      const ids = reviewSections.map((section) => section.id).join(",");
      const selected = selectedSection?.id ?? null;
      useLayoutEffect(() => {
        seen = { ids: ids.split(","), selected };
      }, [ids, selected]);
      return null;
    }
    try {
      act(() => root.render(<Consumer />));
      expect(seen).toEqual({ ids, selected });
      expect(harness.diffPreviewCwds).toEqual(previewCwds);
    } finally {
      act(() => root.unmount());
    }
  },
);
