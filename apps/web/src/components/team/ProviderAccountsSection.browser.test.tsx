import {
  EnvironmentId,
  MemberId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry as registry } from "../../rpc/atomRegistry";

const state = vi.hoisted(() => ({
  providers: null as unknown,
  providerInstances: {} as Record<string, unknown>,
  mutate: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: (() => state.providers) as never,
      refreshProviders: vi.fn(async () => ({ _tag: "Success" as const })) as never,
    },
  };
});
vi.mock(import("../../state/team"), async (original) => {
  const actual = await original();
  const { Atom: AtomModule } = await import("effect/reactivity");
  const allowed = AtomModule.make(true);
  return {
    ...actual,
    useIsTeamMode: () => true,
    useCurrentMemberId: () => MemberId.make("member-alice"),
    useTeamMembers: () => new Map() as never,
    teamEnvironment: {
      ...actual.teamEnvironment,
      mutateProviderAccount: Object.assign(state.mutate, {
        permissionAtom: () => allowed,
      }) as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: () => null,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((
    _environmentId: unknown,
    select: (settings: { providerInstances: Record<string, unknown> }) => unknown,
  ) => select({ providerInstances: state.providerInstances })) as never,
}));

import { ProviderAccountsSection } from "./ProviderAccountsSection";
import { setAddProviderAccountDialogOpen } from "./providerAccountDialogState";

const environmentId = EnvironmentId.make("local");
const instanceId = ProviderInstanceId.make("claude_alice");
const homePath = "/srv/t3/providers/claudeAgent/claude_alice/home";

function claudeProvider(auth: ServerProvider["auth"]): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    installed: true,
    enabled: true,
    version: "test-version",
    status: "ready",
    auth,
    checkedAt: "2026-11-01T00:00:00.000Z",
    models: [],
    skills: [],
    slashCommands: [],
  };
}

function setup() {
  const providers = Atom.make<ReadonlyArray<ServerProvider> | null>([]).pipe(Atom.keepAlive);
  state.providers = providers;
  state.providerInstances = {};
  state.mutate.mockReset();
  state.mutate.mockImplementation(async () => {
    const instance: ProviderInstanceConfig = {
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Alice's Claude",
      ownerMemberId: MemberId.make("member-alice"),
      config: { homePath },
    };
    state.providerInstances = { [instanceId]: instance };
    return { _tag: "Success" as const, value: { instanceId } };
  });
  setAddProviderAccountDialogOpen(false);
  return providers;
}

describe("ProviderAccountsSection", () => {
  it("hands a new Claude account without a token to the terminal sign-in", async () => {
    const providers = setup();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <ProviderAccountsSection environmentId={environmentId} />
      </AppAtomRegistryProvider>,
    );

    await userEvent.click(page.getByRole("button", { name: "Add account" }));
    await userEvent.click(page.getByRole("button", { name: "Continue" }));

    expect(state.mutate).toHaveBeenCalledWith({
      environmentId,
      input: { operation: "create", driver: "claudeAgent" },
    });
    await expect.element(page.getByText("Run this in a terminal")).toBeVisible();
    await expect
      .element(page.getByText(`CLAUDE_CONFIG_DIR='${homePath}' claude auth login`))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Finish later" })).toBeVisible();

    await act(() =>
      registry.set(providers, [claudeProvider({ status: "authenticated", email: "a@x.dev" })]),
    );
    await userEvent.click(page.getByRole("button", { name: "Done" }));
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(page.getByText("Claude · Signed in as a@x.dev")).toBeVisible();
  });
});
