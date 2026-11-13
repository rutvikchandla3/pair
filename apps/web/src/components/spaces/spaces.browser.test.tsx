import type { SpaceViewer } from "@t3tools/client-runtime/spaces";
import {
  EnvironmentId,
  MemberId,
  ProjectId,
  ProviderInstanceId,
  type Space,
  SpaceId,
  type SpaceTask,
  SpaceTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { type Locator, page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  run: vi.fn<(label: string, value: unknown, signal?: AbortSignal) => Promise<unknown>>(),
  navigate: vi.fn(),
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { readonly label: string }) => (value: unknown) =>
    state.run(command.label, value)) as never,
}));
vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: ((
    _registry: unknown,
    command: { readonly label: string },
    value: unknown,
    options?: { readonly signal?: AbortSignal },
  ) => state.run(command.label, value, options?.signal)) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
}));
vi.mock(import("../../state/team"), async (original) => ({
  ...(await original()),
  useTeamMembers: (() => new Map()) as never,
}));
vi.mock(import("../../state/spaces"), async (original) => ({
  ...(await original()),
  useSpaceProjects: (() => [
    { id: ProjectId.make("project-be"), title: "pair-be", environmentId: ENVIRONMENT },
  ]) as never,
}));
vi.mock(import("./SpaceModelPicker"), async (original) => ({
  ...(await original()),
  useSpaceModelSelection: (() => ({
    selection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-haiku" },
    entries: [],
    modelOptionsByInstance: {},
  })) as never,
  SpaceModelPicker: (() => null) as never,
}));

import { AttachConfirm } from "./SpaceAttachThreadDialog";
import { SpaceOverview } from "./SpaceRoomPanel";
import { SpaceStartThreadDialog } from "./SpaceStartThreadDialog";

const ENVIRONMENT = EnvironmentId.make("env-1");
const RUTVIK = MemberId.make("member-rutvik");
const KOUSIK = MemberId.make("member-kousik");
const ASHA = MemberId.make("member-asha");
const NAMES: Record<string, string> = { [RUTVIK]: "Rutvik", [KOUSIK]: "Kousik", [ASHA]: "Asha" };
const VIEWER: SpaceViewer = { memberId: RUTVIK, nameOf: (id) => NAMES[id] ?? "Someone" };
const AT = "2026-11-13T10:00:00.000Z";

const member = (memberId: MemberId) => ({ memberId, joinedAt: AT, addedBy: null, removedAt: null });

const SPACE: Space = {
  id: SpaceId.make("spc_0123456789abcdef0123"),
  roomThreadId: ThreadId.make("room-1"),
  name: "Question creation",
  brief: "",
  repositoryIds: [ProjectId.make("project-be")],
  projectId: ProjectId.make("project-be"),
  ownerId: RUTVIK,
  members: [member(RUTVIK), member(KOUSIK), member(ASHA)],
  joinRequests: [],
  createdBy: RUTVIK,
  createdAt: AT,
  updatedAt: AT,
  archivedAt: null,
  archivedBy: null,
};

const TASK: SpaceTask = {
  id: SpaceTaskId.make("stk_0123456789abcdef0123"),
  spaceId: SPACE.id,
  title: "Fix the scoring rubric",
  description: "Make the rubric score partial answers.",
  ownerId: RUTVIK,
  createdBy: RUTVIK,
  createdAt: AT,
  assignedBy: null,
  status: "todo",
  statusVersion: 1,
  statusChangedAt: AT,
  statusChangedBy: { type: "member", memberId: RUTVIK },
  handedBack: null,
  remindedAt: null,
  via: null,
  updatedAt: AT,
  deletedAt: null,
};

async function press(locator: Locator) {
  await expect.element(locator).toBeEnabled();
  (locator.element() as HTMLElement).click();
}

function setup() {
  vi.clearAllMocks();
  state.run.mockResolvedValue({ _tag: "Success", value: {} });
}

describe("SpaceStartThreadDialog", () => {
  it("Cancel start aborts the start and closes at once", async () => {
    setup();
    let signal: AbortSignal | undefined;
    state.run.mockImplementation((label, _value, abort) => {
      if (!label.endsWith("start-thread")) return Promise.resolve({ _tag: "Success", value: {} });
      signal = abort;
      return new Promise(() => undefined);
    });
    const onClose = vi.fn();
    await using _screen = await render(
      <SpaceStartThreadDialog
        environmentId={ENVIRONMENT}
        space={SPACE}
        task={TASK}
        threads={[]}
        onClose={onClose}
      />,
    );

    // The modal's inert backdrop sits over the footer in the test frame, so click the DOM node.
    await act(() => press(page.getByRole("button", { name: /^Start/ })));
    await act(() => press(page.getByRole("button", { name: "Cancel start" })));

    expect(onClose).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
    expect(state.run).toHaveBeenCalledTimes(1);
    expect(state.navigate).not.toHaveBeenCalled();
  });
});

describe("SpaceOverview", () => {
  it("1–5 on a focused task row set its status", async () => {
    setup();
    await using screen = await render(
      <SpaceOverview
        environmentId={ENVIRONMENT}
        space={SPACE}
        tasks={[TASK]}
        threads={[]}
        viewer={VIEWER}
        canCreateTask
        onNewTask={() => undefined}
      />,
    );

    (screen.getByRole("link", { name: TASK.title }).element() as HTMLElement).focus();
    await userEvent.keyboard("3");
    await vi.waitFor(() =>
      expect(state.run).toHaveBeenCalledWith("environment-data:spaces:set-task-status", {
        environmentId: ENVIRONMENT,
        input: { spaceId: SPACE.id, taskId: TASK.id, status: "in-review" },
      }),
    );
  });
});

describe("AttachConfirm", () => {
  it("names the members who will see the thread", async () => {
    setup();
    await using screen = await render(
      <AttachConfirm
        environmentId={ENVIRONMENT}
        space={SPACE}
        task={TASK}
        viewer={VIEWER}
        runsIn="pair-be"
      />,
    );

    await expect.element(screen.getByText(/Kousik and Asha will see this thread/)).toBeVisible();
  });
});
