import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const PRIMARY = EnvironmentId.make("primary");
const REMOTE = EnvironmentId.make("remote");

const capabilities = vi.hoisted(() => ({ serverBrowser: true, machineBrowser: false }));

vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/previewStateStore", () => ({ isPreviewSupportedInRuntime: () => true }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => PRIMARY } }));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));
vi.mock("~/connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: {} } }));
vi.mock("~/state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("~/state/session", () => ({
  environmentSession: { sessionStateAtom: () => ({}) },
  sessionHasScope: () => true,
}));
vi.mock("./browserTargetResolver", () => ({
  environmentMayTunnelLoopback: () => true,
  tunnelsEnvironmentLoopback: () => true,
}));
vi.mock("~/state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => capabilities.serverBrowser,
  readEnvironmentHasMachineBrowser: () => capabilities.machineBrowser,
  useEnvironmentSupportsServerBrowser: () => capabilities.serverBrowser,
}));

const setup = (machineBrowser: boolean) => {
  capabilities.serverBrowser = true;
  capabilities.machineBrowser = machineBrowser;
};

describe("preview runtime in the desktop app", () => {
  it("renders a remote environment's tabs in its own webview unless they run on a machine", async () => {
    const { alternatePreviewRuntime, previewRuntimeFor } = await import("./previewRuntime");
    setup(false);
    expect(previewRuntimeFor(REMOTE)).toBeUndefined();
    expect(alternatePreviewRuntime(REMOTE, PRIMARY, true, false, true, { runtime: "server" })).toBe(
      "desktop",
    );
    // Without its tunnel the desktop cannot load the environment's localhost.
    expect(
      alternatePreviewRuntime(REMOTE, PRIMARY, true, false, false, { runtime: "server" }),
    ).toBeNull();

    setup(true);
    expect(previewRuntimeFor(REMOTE)).toBe("server");
    expect(
      alternatePreviewRuntime(REMOTE, PRIMARY, true, true, true, { runtime: "server" }),
    ).toBeNull();
  });

  it("collapses named profiles into the machine's one profile", async () => {
    const { machineBrowserProfileId } = await import("./previewRuntime");
    expect(machineBrowserProfileId("work")).toBe("default");
    expect(machineBrowserProfileId("incognito")).toBe("incognito");
  });
});
