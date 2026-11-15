import { type LineageViewer, rememberedRunsOnKey } from "@t3tools/client-runtime/branch-lineage";
import {
  EnvironmentId,
  MemberId,
  ProviderInstanceId,
  RunId,
  SandboxId,
  type ThreadBranchOffDraft,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  run: vi.fn<(label: string, value: unknown) => Promise<unknown>>(),
  navigate: vi.fn(),
  model: null as null | { instanceId: string; model: string },
  viewer: null as unknown,
  shell: null as unknown,
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { readonly label: string }) => (value: unknown) =>
    state.run(command.label, value)) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
}));
vi.mock(import("../spaces/SpaceModelPicker"), async (original) => ({
  ...(await original()),
  useSpaceModelSelection: (() => ({
    selection: state.model,
    entries: [],
    modelOptionsByInstance: {},
  })) as never,
  SpaceModelPicker: (() => null) as never,
}));
vi.mock(import("./useBranchOff"), async (original) => ({
  ...(await original()),
  useBranchOffViewer: (() => state.viewer) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: (() => state.shell) as never,
}));

import { BranchOffDraftForm } from "./BranchOffPage";
import { ComposerBranchOffHint } from "./ComposerBranchOffHint";

const ENVIRONMENT = EnvironmentId.make("env-branch-off");
const KOUSIK = MemberId.make("member-kousik");
const HANAD = MemberId.make("member-hanad");
const RUTVIK = MemberId.make("member-rutvik");
const NAMES: Record<string, string> = { [KOUSIK]: "Kousik", [HANAD]: "Hanad", [RUTVIK]: "Rutvik" };
const AS_HANAD: LineageViewer = { memberId: HANAD, nameOf: (id) => NAMES[id] ?? "Someone" };
const SOURCE = ThreadId.make("thread-prompt-builder");

const DRAFT: ThreadBranchOffDraft = {
  allowed: true,
  sourceTitle: "Prompt builder",
  sourceOwnerId: KOUSIK,
  latestTurn: { turn: 6, at: null, uncommittedFiles: 2 },
  turns: [],
  machine: { state: "ready", working: 1, vcpus: 4, ownerId: KOUSIK },
  audience: [KOUSIK, HANAD, RUTVIK],
  busy: false,
  suggestedBranch: "hanad/prompt-builder",
};

const SOURCE_DISCLOSURE =
  "Shares Kousik's running database and services. Kousik and Rutvik can open this machine and reach your Claude and GitHub sign-ins from its terminal. Machine time counts toward Kousik.";
const NEW_DISCLOSURE =
  "Its own database and services, on your machine time. Kousik and Rutvik can open it and reach your Claude and GitHub sign-ins, as with any thread you share.";

function setup(model: typeof state.model = { instanceId: "claude", model: "claude-haiku" }) {
  vi.clearAllMocks();
  localStorage.removeItem(rememberedRunsOnKey(ENVIRONMENT));
  state.model = model;
  state.run.mockResolvedValue({
    _tag: "Success",
    value: { threadId: ThreadId.make("thread-branch") },
  });
}

const draftForm = (draft: ThreadBranchOffDraft) => (
  <BranchOffDraftForm
    environmentId={ENVIRONMENT}
    sourceThreadId={SOURCE}
    projectId={null}
    draft={draft}
    viewer={AS_HANAD}
  />
);

const radio = (name: string) => page.getByRole("radio", { name });

describe("BranchOffDraftForm", () => {
  it("selects the source's machine first, then remembers the choice, with its line in full", async () => {
    setup();
    {
      await using screen = await render(draftForm(DRAFT));
      await expect.element(radio("Kousik's machine")).toBeChecked();
      await expect
        .element(screen.getByTestId("branch-off-disclosure"))
        .toHaveTextContent(SOURCE_DISCLOSURE);

      await userEvent.click(radio("New machine"));
      await expect.element(radio("New machine")).toBeChecked();
      await expect
        .element(screen.getByTestId("branch-off-disclosure"))
        .toHaveTextContent(NEW_DISCLOSURE);
    }
    expect(localStorage.getItem(rememberedRunsOnKey(ENVIRONMENT))).toBe('"new-machine"');

    await using _next = await render(draftForm(DRAFT));
    await expect.element(radio("New machine")).toBeChecked();
  });

  it("selects New machine on a busy machine whatever was remembered, with the reason above the line", async () => {
    setup();
    localStorage.setItem(rememberedRunsOnKey(ENVIRONMENT), '"source-machine"');
    await using screen = await render(
      draftForm({ ...DRAFT, machine: { ...DRAFT.machine, working: 3 } }),
    );
    await expect.element(radio("New machine")).toBeChecked();
    await expect
      .element(screen.getByTestId("branch-off-runs-on-reason"))
      .toHaveTextContent(
        "Kousik's machine has 3 threads working on 4 vCPU, so New machine is selected. You can still pick it.",
      );
    await expect
      .element(screen.getByTestId("branch-off-disclosure"))
      .toHaveTextContent(NEW_DISCLOSURE);
  });

  it("offers only New machine when the source's machine was discarded", async () => {
    setup();
    await using _screen = await render(
      draftForm({ ...DRAFT, machine: { ...DRAFT.machine, state: "gone" } }),
    );
    await expect.element(radio("New machine")).toBeChecked();
    await expect.element(radio("Kousik's machine")).not.toBeInTheDocument();
  });

  it("disables Branch off and offers Connect Claude without an account", async () => {
    setup(null);
    await using screen = await render(draftForm(DRAFT));
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }), "Add a rationale");
    await expect.element(screen.getByRole("button", { name: /^Branch off/ })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Connect Claude" })).toBeVisible();
  });

  it("branches off with the chosen machine, the branch from the prompt, and opens the branch", async () => {
    setup();
    await using screen = await render(draftForm(DRAFT));
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }), "Add a rationale");
    await userEvent.click(screen.getByRole("button", { name: /^Branch off/ }));
    await vi.waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: ENVIRONMENT, threadId: "thread-branch" },
      }),
    );
    expect(state.run).toHaveBeenCalledWith("environment-data:branch-lineage:branch-off", {
      environmentId: ENVIRONMENT,
      input: {
        sourceThreadId: SOURCE,
        runsOn: "source-machine",
        startFrom: { type: "latest" },
        branch: "hanad/add-a-rationale",
        prompt: "Add a rationale",
        modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-haiku" },
      },
    });
  });
});

describe("ComposerBranchOffHint", () => {
  const shell = (fields: Record<string, unknown> = {}) => ({
    source: {
      id: SOURCE,
      title: "Prompt builder",
      ownerId: KOUSIK,
      sandboxId: SandboxId.make("sbx_0123456789abcdef0123"),
      archivedAt: null,
      activeRunId: null,
      ...fields,
    },
  });
  const hint = () => (
    <ComposerBranchOffHint threadRef={{ environmentId: ENVIRONMENT, threadId: SOURCE }} />
  );

  it("says where a message goes on someone else's cloud thread, and opens the draft", async () => {
    setup();
    state.viewer = AS_HANAD;
    state.shell = shell();
    await using screen = await render(hint());
    await expect.element(screen.getByText("Goes into Kousik's conversation")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Branch off" }));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/branch-off/$environmentId/$sourceThreadId",
      params: { environmentId: ENVIRONMENT, sourceThreadId: SOURCE },
    });

    state.shell = shell({ activeRunId: RunId.make("run-7") });
    await screen.rerender(hint());
    await expect
      .element(screen.getByText("Goes into Kousik's conversation, after the current turn"))
      .toBeVisible();
  });

  it.each([
    ["your own thread", () => ({ viewer: AS_HANAD, shell: shell({ ownerId: HANAD }) })],
    ["a local thread", () => ({ viewer: AS_HANAD, shell: shell({ sandboxId: undefined }) })],
    ["a solo server", () => ({ viewer: null, shell: shell() })],
  ])("is hidden on %s", async (_name, given) => {
    setup();
    const { viewer, shell: current } = given();
    state.viewer = viewer;
    state.shell = current;
    await using screen = await render(hint());
    expect(screen.container.textContent).toBe("");
  });
});
