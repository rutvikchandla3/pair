import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  BotId,
  BotJobId,
  type Bot,
  type BotSession,
  type BotsSnapshot,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const PRIMARY = EnvironmentId.make("env-primary");
const CLOUD = EnvironmentId.make("env-cloud");
const BOT = BotId.make("bot-1");
const JOB = BotJobId.make("job-1");
const NOW = Date.parse("2026-11-18T14:00:00.000Z");
const HOUR = 60 * 60_000;

const state = vi.hoisted(() => ({
  snapshot: null as BotsSnapshot | null,
  shells: [] as ReadonlyArray<EnvironmentThreadShell>,
}));

vi.mock(import("../../state/bots"), async (original) => ({
  ...(await original()),
  useBotsSnapshot: (() => state.snapshot) as never,
  useBotsNow: () => NOW,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShells: (() => state.shells) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => PRIMARY,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => () => Promise.resolve({ _tag: "Success", value: {} })) as never,
}));

import { SidebarBots } from "./SidebarBots";

const iso = (at: number) => new Date(at).toISOString();

function session(threadId: string, title: string, cloud = false): BotSession {
  return {
    threadId: ThreadId.make(threadId),
    botId: BOT,
    jobId: JOB,
    role: "worker",
    title,
    projectId: ProjectId.make("project-1"),
    takenOver: false,
    createdAt: iso(NOW - 30 * HOUR),
    ...(cloud
      ? {
          cloud: {
            environmentId: CLOUD,
            label: "Pair Cloud",
            state: "done" as const,
            pendingRequest: null,
            lastOutputAt: iso(NOW - (threadId === "cloud-old" ? 30 : 1) * HOUR),
            reportedRunId: null,
            reportedRequestIds: [],
            position: 0,
          },
        }
      : {}),
  };
}

const bot: Bot = {
  id: BOT,
  ownerId: "member-1" as Bot["ownerId"],
  name: "Chief of staff",
  color: "#6366f1",
  shape: "round",
  voice: "crisp",
  picture: null,
  charter: "",
  instructions: "",
  limits: [],
  models: {} as Bot["models"],
  homeThreadId: null,
  homeProjectId: null,
  paused: false,
  lastSeenAt: null,
  nextJobNumber: 1,
  createdAt: iso(NOW),
  updatedAt: iso(NOW),
};

function setup() {
  state.snapshot = {
    bots: [bot],
    jobs: [],
    sessions: [
      session("local-1", "Fix the build"),
      session("cloud-1", "Review the PRs", true),
      session("cloud-old", "Triage last week", true),
    ],
    asks: [],
    notes: [],
    events: [],
    revision: 0,
  };
  state.shells = [
    {
      id: ThreadId.make("local-1"),
      environmentId: PRIMARY,
      updatedAt: iso(NOW - 2 * HOUR),
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      pendingSubagentRequest: null,
      runtime: { status: "completed" },
      latestRun: null,
    } as unknown as EnvironmentThreadShell,
  ];
}

async function mountSidebar(path: string) {
  const root = createRootRoute({
    component: () => (
      <>
        <SidebarBots />
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "bots/$environmentId/$botId" }),
      createRoute({ getParentRoute: () => root, path: "$environmentId/$threadId" }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  // The sidebar reads the bot and thread route params, which the default test router lacks.
  const screen = await render(<RouterProvider router={router} />, { router: false });
  return { ...screen, router };
}

describe("SidebarBots", () => {
  it("keeps a bot's sessions listed while one of them is open, local or cloud", async () => {
    setup();
    await using screen = await mountSidebar(`/bots/${PRIMARY}/${BOT}`);
    const local = screen.getByRole("link", { name: /Fix the build/ });
    const cloud = screen.getByRole("link", { name: /Review the PRs/ });

    await userEvent.click(local);
    expect(screen.router.state.location.pathname).toBe(`/${PRIMARY}/local-1`);
    await expect.element(local).toHaveAttribute("aria-current", "page");
    await expect.element(cloud).toBeVisible();

    await userEvent.click(cloud);
    expect(screen.router.state.location.pathname).toBe(`/${CLOUD}/cloud-1`);
    await expect.element(cloud).toHaveAttribute("aria-current", "page");
    await expect.element(local).not.toHaveAttribute("aria-current");

    await userEvent.click(screen.getByRole("link", { name: /Chief of staff/ }));
    await expect
      .element(screen.getByRole("link", { name: /Chief of staff/ }))
      .toHaveAttribute("aria-current", "page");
    await expect.element(local).toBeVisible();
    await expect.element(cloud).not.toHaveAttribute("aria-current");
  });

  it("expands earlier sessions for one opened from elsewhere, and still collapses", async () => {
    setup();
    await using screen = await mountSidebar(`/${CLOUD}/cloud-old`);

    const old = screen.getByRole("link", { name: /Triage last week/ });
    await expect.element(old).toHaveAttribute("aria-current", "page");
    await expect.element(screen.getByRole("link", { name: /Fix the build/ })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Hide earlier" }));
    await expect.element(old).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "1 earlier" }));
    await expect.element(old).toHaveAttribute("aria-current", "page");
  });

  it("lists no sessions for a thread that is not the bot's", async () => {
    setup();
    await using screen = await mountSidebar(`/${PRIMARY}/cloud-1`);

    await expect.element(screen.getByRole("link", { name: /Chief of staff/ })).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: /Review the PRs/ }))
      .not.toBeInTheDocument();
  });
});
