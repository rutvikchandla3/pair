import type { LineageViewer } from "@t3tools/client-runtime/branch-lineage";
import {
  EnvironmentId,
  type LineageNotice,
  type LineageView,
  MemberId,
  type Offer,
  OfferId,
  type OrchestrationV2ThreadShellBranchLink,
  type ScopedThreadRef,
  ThreadId,
  type ThreadUpdatePreview,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { render } from "../../../test/render";
import "~/index.css";

const state = vi.hoisted(() => ({
  viewer: null as unknown,
  shells: new Map<string, unknown>(),
  view: null as unknown,
  branchCount: 0,
  preview: null as unknown,
  calls: [] as Array<{ readonly label: string; readonly value: unknown }>,
  results: new Map<string, unknown>(),
}));

const record = (label: string, value: unknown) => {
  state.calls.push({ label, value });
  return Promise.resolve({ _tag: "Success", value: state.results.get(label) ?? {} });
};

vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: ((ref: ScopedThreadRef | null) =>
    ref === null ? null : (state.shells.get(ref.threadId) ?? null)) as never,
}));
vi.mock(import("~/state/branchLineage"), async (original) => ({
  ...(await original()),
  useLineageViewer: (() => state.viewer) as never,
  useLineageView: ((ref: ScopedThreadRef | null) => (ref === null ? null : state.view)) as never,
  useLineageBranchCount: (() => state.branchCount) as never,
}));
vi.mock(import("~/state/team"), async (original) => ({
  ...(await original()),
  useTeamMembers: (() => MEMBERS) as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: state.preview,
    error: null,
    isPending: false,
    isSuccess: true,
    failure: null,
    dataUpdatedAt: 0,
    refresh: () => undefined,
  })) as never,
}));
vi.mock(import("~/state/use-orchestration-command"), () => ({
  useOrchestrationCommand: ((command: { readonly label: string }) => (value: unknown) =>
    record(command.label, value)) as never,
}));
vi.mock(import("~/state/use-atom-query-runner"), () => ({
  useAtomQueryRunner: (() => (value: unknown) => {
    state.calls.push({ label: "update-preview", value });
    return Promise.resolve({ _tag: "Success", value: state.preview });
  }) as never,
}));
vi.mock(import("~/hooks/useThreadActions"), () => ({
  useThreadActions: (() => ({
    settleThread: (ref: unknown) => record("settle", ref),
  })) as never,
}));

import { useLineageResolvingBanner } from "./lineageResolvingBanner";
import { LineageChip } from "./LineageChip";
import { LineageDialogHost } from "./LineageDialogs";
import { lineageDialogAtom, openLineageDialog } from "./lineageDialogTarget";
import { LineageTimelineRow } from "./LineageTimelineRow";

const ENVIRONMENT = EnvironmentId.make("env-team");
const KOUSIK = MemberId.make("member-kousik");
const HANAD = MemberId.make("member-hanad");
const RUTVIK = MemberId.make("member-rutvik");
const SOURCE = ThreadId.make("thread-prompt-builder");
const BRANCH = ThreadId.make("thread-rationale");
const OFFER = OfferId.make("ofr_0123456789abcdef0123");
const AT = "2026-11-15T11:41:00.000Z";

const MEMBERS = new Map(
  [
    [KOUSIK, "Kousik"],
    [HANAD, "Hanad"],
    [RUTVIK, "Rutvik"],
  ].map(([id, name]) => [
    id,
    {
      id,
      name,
      role: "member",
      color: "#336699",
      isOwner: id === KOUSIK,
      createdAt: AT,
      removedAt: null,
    },
  ]),
);

const viewerOf = (memberId: MemberId): LineageViewer => ({
  memberId,
  serverOwnerId: KOUSIK,
  nameOf: (id) => MEMBERS.get(id)?.name ?? "Someone",
});

type BranchSource = NonNullable<OrchestrationV2ThreadShellBranchLink["source"]>;

const branchLink = (source: Partial<BranchSource> = {}): OrchestrationV2ThreadShellBranchLink => ({
  revision: 3,
  source: {
    threadId: SOURCE,
    ownerId: KOUSIK,
    title: "Prompt builder",
    state: "open",
    toOffer: 2,
    behind: 1,
    updateInProgress: null,
    undoableUpdate: false,
    offerState: null,
    allApplied: false,
    shippedLabel: null,
    unshipped: 0,
    ...source,
  },
  openOffers: 0,
});

const shell = (fields: {
  readonly id: ThreadId;
  readonly title: string;
  readonly ownerId: MemberId;
  readonly branchLink: OrchestrationV2ThreadShellBranchLink | null;
  readonly activeRunId?: string | null;
}) => ({
  environmentId: ENVIRONMENT,
  id: fields.id,
  title: fields.title,
  providerInstanceId: "claudeAgent",
  source: {
    id: fields.id,
    title: fields.title,
    branch: null,
    ownerId: fields.ownerId,
    sandboxId: "sandbox-1",
    branchLink: fields.branchLink,
    activeRunId: fields.activeRunId ?? null,
    pendingRuntimeRequest: null,
    archivedAt: null,
    settledAt: null,
  },
});

const offer = (fields: Partial<Offer> = {}): Offer => ({
  id: OFFER,
  sourceThreadId: SOURCE,
  branchThreadId: BRANCH,
  senderId: HANAD,
  senderKind: "person",
  note: "Adds a one-line rationale to each question.",
  state: "open",
  commits: [
    { sha: "a1b2c3d4e5", subject: "Add a rationale to the Question schema", authorName: "Hanad" },
    { sha: "e4f5a6b7c8", subject: "Show the rationale under each question", authorName: "Hanad" },
  ],
  files: [{ path: "src/schema.ts", status: "modified", additions: 84, deletions: 12 }],
  additions: 84,
  deletions: 12,
  base: "base",
  tip: "tip",
  replaced: false,
  armedAt: null,
  returnReason: null,
  returnPaths: [],
  decidedBy: null,
  decidedAt: null,
  revertedAt: null,
  revertedBy: null,
  waiting: null,
  createdAt: AT,
  updatedAt: AT,
  ...fields,
});

const sourceView = (offers: ReadonlyArray<Offer>): LineageView => ({
  thread: { threadId: SOURCE, role: "source" },
  source: null,
  branches: [
    {
      threadId: BRANCH,
      title: "Rationale per question",
      ownerId: HANAD,
      branch: "hanad/rationale",
      runsOn: "source-machine",
      toOffer: 2,
      behind: 0,
      workState: "idle",
    },
  ],
  lineage: null,
  offers,
});

function setup(input: {
  readonly viewer: MemberId;
  readonly shells?: ReadonlyArray<ReturnType<typeof shell>>;
  readonly view?: LineageView | null;
  readonly preview?: unknown;
}) {
  state.viewer = viewerOf(input.viewer);
  state.shells = new Map((input.shells ?? []).map((entry) => [entry.id, entry]));
  state.view = input.view ?? null;
  state.branchCount = 0;
  state.preview = input.preview ?? null;
  state.calls = [];
  state.results = new Map();
  appAtomRegistry.set(lineageDialogAtom, null);
}

const branchShell = (source: Partial<BranchSource> = {}) =>
  shell({
    id: BRANCH,
    title: "Rationale per question",
    ownerId: HANAD,
    branchLink: branchLink(source),
  });

const branchView: LineageView = {
  thread: { threadId: BRANCH, role: "branch" },
  source: {
    threadId: SOURCE,
    title: "Prompt builder",
    ownerId: KOUSIK,
    state: "open",
    canOpen: true,
  },
  branches: [],
  lineage: null,
  offers: [],
};

const callsTo = (suffix: string) =>
  state.calls.filter((call) => call.label.endsWith(suffix)).map((call) => call.value);

describe("LineageChip", () => {
  it("shows the branch's lineage and the owner's Update and Offer", async () => {
    setup({
      viewer: HANAD,
      shells: [branchShell()],
      view: branchView,
      preview: { files: [{ path: "src/a.ts", status: "clean" }], conflicts: [], behind: 1 },
    });
    await using screen = await render(
      <LineageChip threadRef={{ environmentId: ENVIRONMENT, threadId: BRANCH }} />,
    );

    const chip = screen.getByRole("button", {
      name: "Lineage: from Prompt builder · 2 to offer · 1 behind",
    });
    await userEvent.click(chip);
    await expect.element(page.getByText("Prompt builder and its branches")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Offer to Kousik" }));
    expect(appAtomRegistry.get(lineageDialogAtom)?.kind).toBe("offer");

    await userEvent.click(chip);
    await userEvent.click(page.getByRole("button", { name: "Update from Prompt builder" }));
    // A clean preview merges in one click.
    await vi.waitFor(() =>
      expect(callsTo("branch-lineage:update")).toEqual([
        { environmentId: ENVIRONMENT, input: { threadId: BRANCH, onConflict: "agent" } },
      ]),
    );
  });

  it("offers nobody else the branch owner's actions", async () => {
    setup({ viewer: RUTVIK, shells: [branchShell()], view: branchView });
    await using screen = await render(
      <LineageChip threadRef={{ environmentId: ENVIRONMENT, threadId: BRANCH }} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /^Lineage: from Prompt builder/ }));
    await expect.element(page.getByText("Prompt builder and its branches")).toBeVisible();
    expect(page.getByRole("button", { name: "Offer to Kousik" }).elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: /^Update/ }).elements()).toHaveLength(0);
  });

  it("puts Start from main with them and Settle beside a shipped branch's chip", async () => {
    setup({
      viewer: HANAD,
      shells: [branchShell({ state: "shipped", shippedLabel: "pair-be#482", unshipped: 2 })],
    });
    await using screen = await render(
      <LineageChip threadRef={{ environmentId: ENVIRONMENT, threadId: BRANCH }} />,
    );

    await expect
      .element(
        screen.getByRole("button", {
          name: /Prompt builder shipped in pair-be#482 · 2 commits not in it/,
        }),
      )
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Start from main with them" }));
    await userEvent.click(screen.getByRole("button", { name: "Settle" }));
    await vi.waitFor(() => {
      expect(callsTo("start-from-main")).toEqual([
        { environmentId: ENVIRONMENT, input: { threadId: BRANCH } },
      ]);
      expect(callsTo("settle")).toEqual([{ environmentId: ENVIRONMENT, threadId: BRANCH }]);
    });
  });
});

describe("Offer card", () => {
  const sourceShell = (activeRunId: string | null) =>
    shell({
      id: SOURCE,
      title: "Prompt builder",
      ownerId: KOUSIK,
      branchLink: { revision: 4, source: null, openOffers: 1 },
      activeRunId,
    });
  const renderCard = () =>
    render(
      <LineageTimelineRow
        environmentId={ENVIRONMENT}
        threadId={SOURCE}
        notice={{ kind: "offer", offerId: OFFER, senderId: HANAD }}
        createdAt={AT}
      />,
    );

  it("lets its idle holder apply at once", async () => {
    setup({ viewer: KOUSIK, shells: [sourceShell(null)], view: sourceView([offer()]) });
    await using screen = await renderCard();

    await expect
      .element(screen.getByText("Applies cleanly · your agent is idle, so it applies now"))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Apply", exact: true }));
    await vi.waitFor(() =>
      expect(callsTo("offer-apply")).toEqual([
        { environmentId: ENVIRONMENT, input: { offerId: OFFER } },
      ]),
    );
    await expect.element(screen.getByRole("button", { name: "Decline" })).toBeVisible();
  });

  it("arms Apply for when the holder's turn ends", async () => {
    setup({ viewer: KOUSIK, shells: [sourceShell("run-1")], view: sourceView([offer()]) });
    await using screen = await renderCard();

    await userEvent.click(screen.getByRole("button", { name: "Apply when this turn ends" }));
    await vi.waitFor(() => expect(callsTo("offer-apply")).toHaveLength(1));
  });

  it("shows anyone else who it waits for, with View changes only", async () => {
    setup({ viewer: RUTVIK, shells: [sourceShell(null)], view: sourceView([offer()]) });
    await using screen = await renderCard();

    await expect.element(screen.getByText("Waiting for Kousik")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "View changes" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Apply|Decline/ }).elements()).toHaveLength(0);
  });
});

describe("Update dialog", () => {
  it("offers the two ways through a conflict and sends the one chosen", async () => {
    const preview: ThreadUpdatePreview = {
      files: [
        { path: "src/Preview.tsx", status: "clean" },
        { path: "src/schema.ts", status: "conflict" },
      ],
      conflicts: ["src/schema.ts"],
      behind: 1,
      sourceTitle: "Prompt builder",
    };
    setup({ viewer: HANAD, shells: [branchShell()], preview });
    openLineageDialog({
      kind: "update",
      threadRef: { environmentId: ENVIRONMENT, threadId: BRANCH },
    });
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <LineageDialogHost />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("conflicts with your edit")).toBeVisible();
    await expect.element(page.getByText("You can abort until it's resolved.")).toBeVisible();
    await userEvent.click(page.getByText("Update and resolve it myself"));
    await userEvent.click(page.getByRole("button", { name: "Update", exact: true }));
    await vi.waitFor(() =>
      expect(callsTo("branch-lineage:update")).toEqual([
        { environmentId: ENVIRONMENT, input: { threadId: BRANCH, onConflict: "self" } },
      ]),
    );
  });
});

function ResolvingRow({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const item = useLineageResolvingBanner(threadRef);
  return item === null ? null : (
    <div>
      {item.title}
      {item.actions}
    </div>
  );
}

describe("Resolving row", () => {
  it("names the conflicted files and aborts the update", async () => {
    setup({
      viewer: HANAD,
      shells: [
        branchShell({ updateInProgress: { conflictedPaths: ["src/schema.ts"], resolver: "self" } }),
      ],
    });
    await using screen = await render(
      <ResolvingRow threadRef={{ environmentId: ENVIRONMENT, threadId: BRANCH }} />,
    );

    await expect
      .element(screen.getByText("Resolving update from Prompt builder · src/schema.ts"))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Abort update" }));
    await vi.waitFor(() =>
      expect(callsTo("abort-update")).toEqual([
        { environmentId: ENVIRONMENT, input: { threadId: BRANCH } },
      ]),
    );
  });
});

describe("Lineage timeline rows", () => {
  it("offers Undo update on the Update it can still undo", async () => {
    const notice: LineageNotice = { kind: "updated", snapshotSha: "snap-2", files: 2, turn: 7 };
    setup({
      viewer: HANAD,
      shells: [branchShell()],
      view: {
        thread: { threadId: BRANCH, role: "branch" },
        source: {
          threadId: SOURCE,
          title: "Prompt builder",
          ownerId: KOUSIK,
          state: "open",
          canOpen: true,
        },
        branches: [],
        lineage: {
          undoableUpdate: {
            snapshotSha: "snap-2",
            mergeCommit: "m",
            preUpdateHead: "h",
            wipCommit: null,
          },
          update: null,
        } as never,
        offers: [],
      },
    });
    await using screen = await render(
      <LineageTimelineRow
        environmentId={ENVIRONMENT}
        threadId={BRANCH}
        notice={notice}
        createdAt={AT}
      />,
    );

    await expect
      .element(screen.getByText("Updated from Prompt builder · turn 7, 2 files"))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Undo update" }));
    await vi.waitFor(() =>
      expect(callsTo("undo-update")).toEqual([
        { environmentId: ENVIRONMENT, input: { threadId: BRANCH } },
      ]),
    );
  });
});
