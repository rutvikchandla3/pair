import {
  EnvironmentId,
  ProjectId,
  SandboxId,
  orchestrationV2PendingWorktreeBase,
  type OrchestrationV2Run,
  type ServerConfig,
  type VcsRef,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";
import {
  deriveLocalBranchNameFromRemoteRef,
  resolveBranchSelectionTarget,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  resolveBranchToolbarPrBranch,
  resolveBranchToolbarValue,
  resolveCloudEnvModeItem,
  resolveLocalCheckoutBranchMismatch,
  resolveLogicalProjectEnvironments,
  resolvePreviousWorktreeSeed,
  resolveWorktreeBaseBranchName,
  sanitizeNewRefName,
  shouldIncludeBranchPickerItem,
} from "./BranchToolbar.logic";

describe("resolveDraftEnvModeAfterBranchChange", () => {
  it("switches to local mode when returning from an existing worktree to the main worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: "/repo/.t3/worktrees/feature-a",
        effectiveEnvMode: "worktree",
      }),
    ).toBe("local");
  });

  it("uses worktree mode when selecting a ref already attached to a worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: "/repo/.t3/worktrees/feature-a",
        currentWorktreePath: null,
        effectiveEnvMode: "local",
      }),
    ).toBe("worktree");
  });

  it("keeps a cloud draft in cloud when its base ref changes", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: null,
        effectiveEnvMode: "cloud",
      }),
    ).toBe("cloud");
  });
});

describe("resolveBranchToolbarValue", () => {
  it("a cloud thread waiting for its machine shows its base, not the host branch", () => {
    const runs: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "workspacePreparation">> = [
      { status: "completed", workspacePreparation: { type: "worktree", baseRef: "old-base" } },
      { status: "preparing", workspacePreparation: { type: "worktree", baseRef: "main" } },
    ];
    const waiting = {
      envMode: "cloud",
      activeWorktreePath: null,
      currentGitBranch: "host-checkout-branch",
      cloudThread: { baseRef: orchestrationV2PendingWorktreeBase(runs) },
    } as const;
    expect(resolveBranchToolbarValue({ ...waiting, activeThreadBranch: null })).toBe("main");
    expect(resolveBranchToolbarValue({ ...waiting, activeThreadBranch: "feature/x" })).toBe(
      "feature/x",
    );
    expect(
      resolveBranchToolbarValue({
        ...waiting,
        activeThreadBranch: null,
        cloudThread: { baseRef: orchestrationV2PendingWorktreeBase([]) },
      }),
    ).toBeNull();
    // A cloud draft has no machine yet either, but defaults its base to the host branch.
    expect(
      resolveBranchToolbarValue({ ...waiting, activeThreadBranch: null, cloudThread: null }),
    ).toBe("host-checkout-branch");
  });
});

describe("resolveBranchToolbarPrBranch", () => {
  it("hides PR state while an optimistic branch switch is in flight", () => {
    expect(
      resolveBranchToolbarPrBranch({
        activeThreadBranch: "feature/current",
        resolvedActiveBranch: "feature/next",
      }),
    ).toBeNull();
  });
});

describe("resolveLocalCheckoutBranchMismatch", () => {
  it("detects when a local thread is associated with a different branch than the checkout", () => {
    expect(
      resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: "feature/thread",
        currentGitBranch: "feature/current",
      }),
    ).toEqual({
      threadBranch: "feature/thread",
      currentBranch: "feature/current",
    });
  });

  it("ignores dedicated worktrees because their checkout is already thread-scoped", () => {
    expect(
      resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: "worktree",
        activeWorktreePath: "/repo/.t3/worktrees/feature-thread",
        activeThreadBranch: "feature/thread",
        currentGitBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("resolveEffectiveEnvMode", () => {
  const sandboxId = SandboxId.make("sbx_0123456789abcdef0123");
  const base = {
    activeWorktreePath: null,
    hasServerThread: false,
    draftThreadEnvMode: undefined,
    sandboxId: undefined,
    cloudAvailable: true,
    cloudLaunch: false,
  } as const;

  it.each([
    [
      "a server thread preparing its worktree",
      { hasServerThread: true, preparingWorktree: true },
      "worktree",
    ],
    ["a server thread in the checkout", { hasServerThread: true }, "local"],
    [
      "a server thread with a sandbox",
      {
        hasServerThread: true,
        activeWorktreePath: "/t3-sandbox/x/worktrees/a",
        sandboxId,
        cloudAvailable: false,
      },
      "cloud",
    ],
    ["a cloud draft while Cloud is available", { draftThreadEnvMode: "cloud" }, "cloud"],
    [
      "a cloud draft after Cloud went away",
      { draftThreadEnvMode: "cloud", cloudAvailable: false },
      "worktree",
    ],
    [
      "any draft on a cloud-launch server",
      { draftThreadEnvMode: "local", cloudLaunch: true },
      "cloud",
    ],
    [
      "a local thread on a cloud-launch server",
      { hasServerThread: true, cloudLaunch: true },
      "local",
    ],
  ] as const)("%s", (_name, overrides, expected) => {
    expect(resolveEffectiveEnvMode({ ...base, ...overrides })).toBe(expected);
  });
});

describe("resolveCloudEnvModeItem", () => {
  const available = { available: true } as const;
  const disallowed = {
    available: false,
    reason: "project-disallowed",
    message: "Cloud threads are turned off for this project.",
  } as const;
  const notConfigured = {
    ...disallowed,
    reason: "not-configured",
    message: "Cloud is not set up on this environment.",
  } as const;
  const notCloudOnly = { ...disallowed, reason: "not-cloud-only", message: "" } as const;
  const draft = {
    effectiveEnvMode: "cloud",
    isServerThread: false,
    forceNewWorktree: false,
  } as const;

  it.each([
    [
      "hidden on a server that isn't cloud-only",
      { cloud: notCloudOnly, effectiveEnvMode: "worktree" },
      null,
    ],
    [
      "the only choice without a driver",
      { cloud: notConfigured },
      { disabledReason: notConfigured.message, only: true },
    ],
    ["the only choice on a draft", { cloud: available }, { disabledReason: null, only: true }],
    [
      "disabled by the project",
      { cloud: disallowed },
      { disabledReason: disallowed.message, only: true },
    ],
    [
      "disabled for a multi-model send",
      { cloud: available, forceNewWorktree: true, effectiveEnvMode: "worktree" },
      { disabledReason: "Each model starts in its own worktree.", only: true },
    ],
    [
      "hidden on a started local thread",
      { cloud: available, isServerThread: true, effectiveEnvMode: "local" },
      null,
    ],
    [
      "shown on a cloud thread after its server stopped launching cloud work",
      { cloud: notCloudOnly, isServerThread: true },
      { disabledReason: null, only: false },
    ],
  ] as const)("%s", (_name, overrides, expected) => {
    expect(resolveCloudEnvModeItem({ ...draft, ...overrides })).toEqual(expected);
  });
});

describe("deriveLocalBranchNameFromRemoteRef", () => {
  it("supports remote names that contain slashes", () => {
    expect(deriveLocalBranchNameFromRemoteRef("my-org/upstream/feature/demo")).toBe(
      "upstream/feature/demo",
    );
  });
});

describe("resolveWorktreeBaseBranchName", () => {
  it("drops the remote from a cloud base, which the machine resolves on origin itself", () => {
    const remote = { name: "origin/test", isRemote: true };
    expect(resolveWorktreeBaseBranchName("cloud", remote)).toBe("test");
    expect(resolveWorktreeBaseBranchName("worktree", remote)).toBe("origin/test");
  });
});

describe("resolvePreviousWorktreeSeed", () => {
  it("skips a newer cloud thread, whose worktree is on its machine", () => {
    expect(
      resolvePreviousWorktreeSeed({
        threads: [
          {
            branch: "t3/local",
            worktreePath: "/repo/.t3/wt",
            updatedAt: "2026-11-08T10:00:00.000Z",
          },
          {
            branch: "t3/cloud",
            worktreePath: "/t3-sandbox/sbx_1/worktrees/t3-cloud",
            updatedAt: "2026-11-08T11:00:00.000Z",
            source: { sandboxId: SandboxId.make("sbx_0123456789abcdef0123") },
          },
        ],
        currentWorktreePath: null,
      }),
    ).toEqual({ branch: "t3/local", worktreePath: "/repo/.t3/wt" });
  });
});

describe("resolveLogicalProjectEnvironments", () => {
  const mac = EnvironmentId.make("mac");
  const cloud = EnvironmentId.make("cloud");
  const serverConfig = (cloudLaunch: boolean) =>
    ({
      environment: { platform: { machine: "server" }, capabilities: { cloudLaunch } },
      scratchWorkspaceRoot: "/scratch",
    }) as unknown as ServerConfig;
  const project = (id: string, environmentId: EnvironmentId) => ({
    id: ProjectId.make(id),
    environmentId,
    title: "app",
    workspaceRoot: `/${id}/app`,
    repositoryIdentity: {
      canonicalKey: "github.com/acme/app",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/acme/app",
      },
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  });
  const local = project("local", mac);
  const onCloud = project("on-cloud", cloud);
  const resolve = (activeProject: typeof local, scratchDraft = false) =>
    resolveLogicalProjectEnvironments({
      activeProject,
      scratchDraft,
      environments: [
        {
          environmentId: mac,
          label: "Mac",
          connection: { phase: "connected" },
          serverConfig: serverConfig(false),
        },
        {
          environmentId: cloud,
          label: "Pair Cloud",
          connection: { phase: "connected" },
          serverConfig: serverConfig(true),
        },
      ],
      projects: [local, onCloud],
      primaryEnvironmentId: mac,
      projectGroupingSettings: {
        sidebarProjectGroupingMode: "repository",
        sidebarProjectGroupingOverrides: {},
      },
    }).map((option) => option.environmentId);

  it("keeps a cloud-launch server out of a local draft's machines unless it holds the project", () => {
    expect(resolve(local)).toEqual([mac]);
    expect(resolve(local, true)).toEqual([mac]);
    expect(resolve(onCloud)).toEqual([mac, cloud]);
  });
});

describe("dedupeRemoteBranchesWithLocalMatches", () => {
  it("hides remote refs when the matching local ref exists", () => {
    const input: VcsRef[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/demo",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "feature/demo",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps non-origin remote refs visible when git tracks with first-slash local naming", () => {
    const input: VcsRef[] = [
      {
        name: "upstream/feature",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "upstream/feature",
      "my-org/upstream/feature",
    ]);
  });
});

describe("resolveBranchSelectionTarget", () => {
  it("reuses an existing secondary worktree for the selected ref", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo/nested-checkout/packages/app",
        activeProjectCheckoutRoot: "/repo/nested-checkout",
        activeWorktreePath: null,
        refName: { isDefault: true, worktreePath: "/repo" },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: "/repo",
      reuseExistingWorktree: true,
    });
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        refName: {
          isDefault: false,
          worktreePath: "/repo/.t3/worktrees/feature-b",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.t3/worktrees/feature-b",
      nextWorktreePath: "/repo/.t3/worktrees/feature-b",
      reuseExistingWorktree: true,
    });
  });

  it("switches back to the main repo when the ref already lives there", () => {
    // A subdirectory project's own checkout is reported at the repository root.
    // The checkout root is undefined until the project's status loads.
    for (const [activeProjectCwd, activeWorktreePath, activeProjectCheckoutRoot] of [
      ["/repo", "/repo/.t3/worktrees/feature-a", "/repo"],
      ["/repo/packages/app", "/repo/.t3/worktrees/feature-a", "/repo"],
      ["/repo/packages/app", null, "/repo"],
      ["/repo/packages/app", "/repo/.t3/worktrees/feature-a", undefined],
      ["/repo/packages/app", null, undefined],
    ] as const) {
      expect(
        resolveBranchSelectionTarget({
          activeProjectCwd,
          activeProjectCheckoutRoot,
          activeWorktreePath,
          refName: {
            isDefault: true,
            worktreePath: "/repo",
          },
        }),
      ).toEqual({
        checkoutCwd: "/repo",
        nextWorktreePath: null,
        reuseExistingWorktree: true,
      });
    }
  });

  it("keeps checkout in the current worktree for non-default refs", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        refName: {
          isDefault: false,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.t3/worktrees/feature-a",
      nextWorktreePath: "/repo/.t3/worktrees/feature-a",
      reuseExistingWorktree: false,
    });
  });
});

describe("shouldIncludeBranchPickerItem", () => {
  it("keeps the synthetic checkout PR item visible for gh pr checkout input", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "__checkout_pull_request__:1359",
        normalizedQuery: "gh pr checkout 1359",
        createBranchItemValue: "__create_new_branch__:gh pr checkout 1359",
        checkoutPullRequestItemValue: "__checkout_pull_request__:1359",
      }),
    ).toBe(true);
  });

  it("surfaces an existing ref matching the sanitized query", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "new-branch",
        normalizedQuery: "new branch",
        createBranchItemValue: null,
        checkoutPullRequestItemValue: null,
      }),
    ).toBe(true);
  });
});

describe("sanitizeNewRefName", () => {
  it("collapses a run of whitespace into a single dash", () => {
    expect(sanitizeNewRefName("new   branch")).toBe("new-branch");
  });

  it("replaces tabs, which git rejects just like spaces", () => {
    expect(sanitizeNewRefName("new\tbranch")).toBe("new-branch");
  });

  it("preserves whitespace that git accepts", () => {
    expect(sanitizeNewRefName("new\u00a0branch")).toBe("new\u00a0branch");
    expect(sanitizeNewRefName("new\u2009branch")).toBe("new\u2009branch");
  });

  it("does not collapse dashes the user typed", () => {
    expect(sanitizeNewRefName("new - branch")).toBe("new---branch");
    expect(sanitizeNewRefName("foo--bar")).toBe("foo--bar");
  });
});
