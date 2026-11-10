import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const PRIMARY = EnvironmentId.make("primary");
const REMOTE = EnvironmentId.make("remote");

const capabilities = vi.hoisted(() => ({ serverBrowser: true, machineBrowser: false }));

vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/previewStateStore", () => ({ isPreviewSupportedInRuntime: () => true }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => PRIMARY } }));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));
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
    expect(alternatePreviewRuntime(REMOTE, PRIMARY, true, false, { runtime: "server" })).toBe(
      "desktop",
    );

    setup(true);
    expect(previewRuntimeFor(REMOTE)).toBe("server");
    expect(alternatePreviewRuntime(REMOTE, PRIMARY, true, true, { runtime: "server" })).toBeNull();
  });

  it("collapses named profiles into the machine's one profile", async () => {
    const { machineBrowserProfileId } = await import("./previewRuntime");
    expect(machineBrowserProfileId("work")).toBe("default");
    expect(machineBrowserProfileId("incognito")).toBe("incognito");
  });
});
