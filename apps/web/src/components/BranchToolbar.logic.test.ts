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
  pairCloudAddInput,
  resolveCloudEnvModeItem,
  resolveCloudLaunchTarget,
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
  const mac = EnvironmentId.make("mac");
  const cloud = EnvironmentId.make("cloud");
  const cloudB = EnvironmentId.make("cloud-b");
  const project = {
    environmentId: mac,
    repositoryIdentity: {
      canonicalKey: "github.com/acme/app",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "git@github.com:acme/app.git",
      },
    },
  } as const;
  const option = (
    environmentId: EnvironmentId,
    label: string,
    projectId: string | null,
    disabledReason: string | null = null,
  ) => ({
    environmentId,
    label,
    projectId: projectId === null ? null : ProjectId.make(projectId),
    disabledReason,
  });
  const targets = (...options: ReadonlyArray<ReturnType<typeof option>>) =>
    ({ kind: "targets", targets: options }) as const;
  const draft = {
    project,
    cloudEnvironmentId: undefined,
    effectiveEnvMode: "cloud",
    isServerThread: false,
    forceNewWorktree: false,
  } as const;
  const cloudRow = (reason: string | null = null) => ({
    value: "cloud",
    label: "Cloud",
    action: { kind: "launch", environmentId: null },
    disabled: reason !== null,
    reason,
  });

  it.each([
    ["hidden with no Pair Cloud paired", { cloud: { kind: "hidden" } }, null],
    [
      "disabled when the origin isn't on github.com",
      {
        cloud: { kind: "unavailable", message: "Cloud needs this project's origin on github.com." },
      },
      {
        disabledReason: "Cloud needs this project's origin on github.com.",
        only: false,
        rows: [cloudRow("Cloud needs this project's origin on github.com.")],
        value: "cloud",
      },
    ],
    [
      "the only choice on a Pair Cloud project",
      {
        cloud: targets(
          option(mac, "Pair Cloud", "own", "Cloud is not set up on this environment."),
        ),
      },
      {
        disabledReason: "Cloud is not set up on this environment.",
        only: true,
        rows: [cloudRow("Cloud is not set up on this environment.")],
        value: "cloud",
      },
    ],
    [
      "Cloud for one matching Pair Cloud project",
      { cloud: targets(option(cloud, "Pair Cloud", "match")) },
      { disabledReason: null, only: false, rows: [cloudRow()], value: "cloud" },
    ],
    [
      "Add to Pair Cloud with no match",
      { cloud: targets(option(cloud, "Pair Cloud", null)) },
      {
        disabledReason: "Add acme/app to Pair Cloud first.",
        only: false,
        rows: [
          {
            value: "add:cloud",
            label: "Add to Pair Cloud",
            action: { kind: "add", environmentId: cloud, label: "Pair Cloud" },
            disabled: false,
            reason: "Add acme/app to Pair Cloud first.",
          },
        ],
        value: "cloud",
      },
    ],
    [
      "one row per Pair Cloud, on the draft's pick",
      {
        cloud: targets(option(cloud, "Pair Cloud", "match"), option(cloudB, "Zeta", null)),
        cloudEnvironmentId: cloud,
      },
      {
        disabledReason: null,
        only: false,
        rows: [
          {
            value: "cloud:cloud",
            label: "Cloud on Pair Cloud",
            action: { kind: "launch", environmentId: cloud },
            disabled: false,
            reason: null,
          },
          {
            value: "add:cloud-b",
            label: "Add to Zeta",
            action: { kind: "add", environmentId: cloudB, label: "Zeta" },
            disabled: false,
            reason: "Add acme/app to Zeta first.",
          },
        ],
        value: "cloud:cloud",
      },
    ],
    [
      "disabled for a multi-model send",
      {
        cloud: targets(option(cloud, "Pair Cloud", "match")),
        forceNewWorktree: true,
        effectiveEnvMode: "worktree",
      },
      {
        disabledReason: "Each model starts in its own worktree.",
        only: false,
        rows: [cloudRow("Each model starts in its own worktree.")],
        value: "cloud",
      },
    ],
    [
      "hidden on a started local thread",
      {
        cloud: targets(option(cloud, "Pair Cloud", "match")),
        isServerThread: true,
        effectiveEnvMode: "local",
      },
      null,
    ],
    [
      "shown on a cloud thread after its server stopped launching cloud work",
      { cloud: { kind: "hidden" }, isServerThread: true },
      { disabledReason: null, only: false, rows: [cloudRow()], value: "cloud" },
    ],
  ] as const)("%s", (_name, overrides, expected) => {
    expect(resolveCloudEnvModeItem({ ...draft, ...overrides })).toEqual(expected);
  });

  it.each([
    ["the draft's pick", [option(cloud, "A", "a"), option(cloudB, "B", "b")], cloudB, cloudB],
    [
      "the first launchable target",
      [option(cloud, "A", null), option(cloudB, "B", "b")],
      undefined,
      cloudB,
    ],
    [
      "nothing when the pick is offline",
      [option(cloud, "A", "a", "A is offline."), option(cloudB, "B", "b")],
      cloud,
      null,
    ],
    ["nothing with only an Add target", [option(cloud, "A", null)], undefined, null],
  ] as const)("launches Cloud on %s", (_name, options, cloudEnvironmentId, expected) => {
    expect(
      resolveCloudLaunchTarget(targets(...options), cloudEnvironmentId)?.environmentId ?? null,
    ).toBe(expected);
  });

  it("adds the local origin to Pair Cloud over https with no files", () => {
    expect(
      pairCloudAddInput({
        project: { ...project, workspaceRoot: "/src/app/web", title: "app" },
        target: { environmentId: cloud, label: "Pair Cloud" },
        projectId: ProjectId.make("new"),
      }),
    ).toEqual({
      source: { environmentId: mac, cwd: "/src/app/web" },
      subdirectory: "",
      target: { environmentId: cloud, label: "Pair Cloud" },
      projectId: ProjectId.make("new"),
      title: "app",
      remoteUrl: "https://github.com/acme/app.git",
      files: [],
    });
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
