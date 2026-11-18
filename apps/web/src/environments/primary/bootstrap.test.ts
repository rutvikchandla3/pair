import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readPrimaryEnvironmentTarget, resolvePrimaryEnvironmentHttpUrl } from ".";

function installTestBrowser(url: string) {
  vi.stubGlobal("window", {
    location: new URL(url),
    history: {
      replaceState: vi.fn(),
    },
  });
}

describe("environmentBootstrap", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    installTestBrowser("http://localhost/");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses https descriptor urls when the primary environment uses wss", () => {
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "https://remote.example.com/.well-known/t3/environment",
    );
  });

  it("keeps an uppercase wss scheme secure when deriving the http url", () => {
    vi.stubEnv("VITE_WS_URL", "WSS://remote.example.com");

    expect(readPrimaryEnvironmentTarget()?.target).toEqual({
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("keeps an uppercase https scheme secure when deriving the websocket url", () => {
    vi.stubEnv("VITE_HTTP_URL", "HTTPS://remote.example.com");

    expect(readPrimaryEnvironmentTarget()?.target).toEqual({
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("uses the vite proxy for desktop-managed loopback descriptor requests during local dev", () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:5733");
    vi.stubGlobal("window", {
      location: new URL("http://127.0.0.1:5733/"),
      history: {
        replaceState: vi.fn(),
      },
      desktopBridge: {
        getLocalEnvironmentEnabled: () => true,
        getLocalEnvironmentBootstraps: () => [
          {
            id: "primary",
            label: "Windows",
            httpBaseUrl: "http://127.0.0.1:3773",
            wsBaseUrl: "ws://127.0.0.1:3773",
            bootstrapToken: "desktop-bootstrap-token",
          },
        ],
      },
    });

    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "http://127.0.0.1:5733/.well-known/t3/environment",
    );
  });

  it("targets the server under the sub-path the bundle is served from", () => {
    vi.stubEnv("BASE_URL", "/t3/");
    installTestBrowser("https://host.test/t3/settings");

    expect(readPrimaryEnvironmentTarget()?.target).toEqual({
      httpBaseUrl: "https://host.test/t3/",
      wsBaseUrl: "wss://host.test/t3/",
    });
    expect(resolvePrimaryEnvironmentHttpUrl("/api/auth/session")).toBe(
      "https://host.test/t3/api/auth/session",
    );
  });

  it("targets the server path an embedding host names, never the page origin", async () => {
    const readEmbedded = async (server: string) => {
      vi.stubGlobal("window", {
        location: new URL(
          `https://host.test/builder/t3code/index.html?embed=1&server=${encodeURIComponent(server)}`,
        ),
        parent: {},
        history: { replaceState: vi.fn() },
      });
      vi.resetModules();
      return import(".");
    };

    const embedded = await readEmbedded("/sbx/abc");
    expect(embedded.readPrimaryEnvironmentTarget()?.target).toEqual({
      httpBaseUrl: "https://host.test/sbx/abc/",
      wsBaseUrl: "wss://host.test/sbx/abc/",
    });
    expect(embedded.resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "https://host.test/sbx/abc/.well-known/t3/environment",
    );

    const invalid = await readEmbedded("//evil.test/sbx");
    expect(() => invalid.readPrimaryEnvironmentTarget()).toThrow(/could not be opened/);
  });
});
