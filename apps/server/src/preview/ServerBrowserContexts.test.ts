import * as NodeEvents from "node:events";

import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { chromium, type Browser, type BrowserContext, type BrowserType } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { presentAsChrome, ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const launches = vi.hoisted(() => ({
  launch: vi.fn<BrowserType["launch"]>(),
  persistent: vi.fn<BrowserType["launchPersistentContext"]>(),
  connect: vi.fn<BrowserType["connectOverCDP"]>(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));
vi.spyOn(chromium, "launch").mockImplementation(launches.launch);
vi.spyOn(chromium, "launchPersistentContext").mockImplementation(launches.persistent);
vi.spyOn(chromium, "connectOverCDP").mockImplementation(launches.connect);
vi.mock("node:fs/promises", () => ({ mkdir: launches.mkdir, rm: launches.rm }));

const makeContext = () => {
  const events = new NodeEvents.EventEmitter();
  let closed = false;
  return {
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    pages: vi.fn(() => []),
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
};

const makeBrowser = () => {
  const events = new NodeEvents.EventEmitter();
  const contexts: ReturnType<typeof makeContext>[] = [];
  return {
    contexts,
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    newContext: vi.fn(async () => {
      const context = makeContext();
      contexts.push(context);
      return context as unknown as BrowserContext;
    }),
    close: vi.fn(async () => {
      for (const context of contexts) await context.close();
      events.emit("disconnected");
    }),
  };
};

/** Chrome on a machine: Playwright attaches to it, and its default context is its one profile. */
const makeMachineBrowser = () => {
  const browser = makeBrowser();
  const profile = makeContext();
  return Object.assign(browser, {
    profile,
    contexts: vi.fn(() => [profile]),
    created: browser.contexts,
    disconnect: () => browser.on.mock.calls.find(([event]) => event === "disconnected")?.[1](),
  });
};

const machine = (sandboxId: string) => ({
  sandboxId,
  endpoint: vi.fn(async () => `ws://127.0.0.1:1/devtools/browser/${sandboxId}-secret`),
});

const options = () => ({
  profilesDir: "/test/profiles",
  executable: vi.fn(async () => "/test/chromium"),
  env: {},
});

const withLauncher = () => {
  const release = vi.fn(async () => {});
  return {
    release,
    configuration: {
      ...options(),
      launcher: vi.fn(async (executable: string) => ({ path: `${executable}-launcher`, release })),
    },
  };
};

beforeEach(() => {
  launches.launch.mockReset();
  launches.persistent.mockReset();
  launches.connect.mockReset();
  launches.mkdir.mockClear();
  launches.rm.mockClear();
});

describe("ServerBrowserContexts", () => {
  it("lazily shares one browser across concurrent isolated sessions and reuses each context", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    const started = Promise.withResolvers<void>();
    launches.launch.mockImplementation(() => {
      started.resolve();
      return launch.promise;
    });
    const { configuration, release } = withLauncher();
    const pool = new ServerBrowserContexts(configuration);
    expect(configuration.executable).not.toHaveBeenCalled();
    const first = pool.contextFor("default", "agent-a");
    const again = pool.contextFor("default", "agent-a");
    const second = pool.contextFor("default", "agent-b");
    const incognito = pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    await started.promise;
    // Playwright may retry the same path until the launch settles.
    expect(release).not.toHaveBeenCalled();
    launch.resolve(browser as unknown as Browser);
    const [a, reused, b, privateContext] = await Promise.all([first, again, second, incognito]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(a).toBe(reused);
    expect(new Set([a, b, privateContext]).size).toBe(3);
    expect(launches.launch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ executablePath: "/test/chromium-launcher" }),
    );
    expect(launches.persistent).not.toHaveBeenCalled();
    expect(browser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    for (const context of browser.contexts) expect(context.close).toHaveBeenCalled();
  });

  it("keeps human profiles persistent without sharing their storage with agents", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const { configuration, release } = withLauncher();
    const pool = new ServerBrowserContexts(configuration);
    const persistent = await pool.contextFor("work/team");
    expect(await pool.contextFor("work/team")).toBe(persistent);
    expect(await pool.contextFor("work/team", "agent")).not.toBe(persistent);
    expect(launches.persistent).toHaveBeenCalledExactlyOnceWith(
      "/test/profiles/work%2Fteam",
      expect.objectContaining({ chromiumSandbox: true, executablePath: "/test/chromium-launcher" }),
    );
    expect(release).toHaveBeenCalledTimes(2);
    expect(launches.mkdir).toHaveBeenCalledWith("/test/profiles/work%2Fteam", { recursive: true });
    await pool.close();
    expect(human.close).toHaveBeenCalledTimes(1);
  });

  it("diagnoses a launcher failure against the real executable", async () => {
    const diagnosed = new Error("diagnosed");
    const diagnose = vi.fn(async () => diagnosed);
    const pool = new ServerBrowserContexts({
      ...options(),
      diagnose,
      launcher: vi.fn(async () => {
        throw new Error("EACCES");
      }),
    });
    await expect(pool.contextFor("default", "agent")).rejects.toBe(diagnosed);
    expect(diagnose).toHaveBeenCalledExactlyOnceWith("/test/chromium", expect.any(Error));
    expect(launches.launch).not.toHaveBeenCalled();
  });

  it("creates no launcher for a profile whose storage cannot be created", async () => {
    launches.mkdir.mockRejectedValueOnce(new Error("EACCES"));
    const { configuration } = withLauncher();
    const pool = new ServerBrowserContexts(configuration);
    await expect(pool.contextFor("work/team")).rejects.toThrow("EACCES");
    expect(configuration.launcher).not.toHaveBeenCalled();
  });

  it("clears a profile by closing its open context before deleting its storage", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const onContextClose = vi.fn();
    const pool = new ServerBrowserContexts({ ...options(), onContextClose });
    const persistent = await pool.contextFor("work/team");
    const agent = await pool.contextFor("work/team", "agent");
    launches.rm.mockImplementationOnce(async () => {
      expect(human.close).toHaveBeenCalledTimes(1);
    });
    await pool.clearProfile("work/team");
    expect(onContextClose).toHaveBeenCalledExactlyOnceWith(persistent);
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith("/test/profiles/work%2Fteam", {
      recursive: true,
      force: true,
    });
    expect(await pool.contextFor("work/team", "agent")).toBe(agent);
    expect(browser.contexts[0]?.close).not.toHaveBeenCalled();
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    expect(await pool.contextFor("work/team")).not.toBe(persistent);
    await pool.clearProfile("never-opened");
    expect(launches.rm).toHaveBeenLastCalledWith("/test/profiles/never-opened", {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("waits for the context to close when the same profile is cleared concurrently", async () => {
    const human = makeContext();
    const closed = Promise.withResolvers<void>();
    human.close.mockImplementation(async () => closed.promise);
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    await pool.contextFor("work/team");

    const first = pool.clearProfile("work/team");
    const second = pool.clearProfile("work/team");
    const deletionsBeforeClose = launches.rm.mock.calls.length;
    closed.resolve();
    await Promise.all([first, second]);

    expect(deletionsBeforeClose).toBe(0);
    expect(human.close).toHaveBeenCalledTimes(1);
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith("/test/profiles/work%2Fteam", {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("opens a profile requested during its clear only after the storage is deleted", async () => {
    launches.persistent.mockImplementation(async () => makeContext() as unknown as BrowserContext);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    await pool.contextFor("work/team");
    const removing = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    let deleted = false;
    launches.rm.mockImplementationOnce(async () => {
      removing.resolve();
      await removed.promise;
      deleted = true;
    });
    const launchedAfterDelete: Array<boolean> = [];
    configuration.executable.mockImplementation(async () => {
      launchedAfterDelete.push(deleted);
      return "/test/chromium";
    });
    const clearing = pool.clearProfile("work/team");
    const reopening = pool.contextFor("work/team");
    await removing.promise;
    removed.resolve();
    await Promise.all([clearing, reopening]);
    expect(launchedAfterDelete).toEqual([true]);
    await pool.close();
  });

  it.each([undefined, "default"])(
    "never retries a failed %s launch with the sandbox disabled",
    async (profile) => {
      const launch = profile ? launches.persistent : launches.launch;
      launch.mockRejectedValue(new Error("sandbox unavailable"));
      const pool = new ServerBrowserContexts(options());
      await expect(pool.contextFor(profile ?? INCOGNITO_BROWSER_PROFILE_ID)).rejects.toThrow(
        "sandbox unavailable",
      );
      expect(launch).toHaveBeenCalledTimes(1);
      expect(
        profile ? launches.persistent.mock.calls[0]?.[1] : launches.launch.mock.calls[0]?.[0],
      ).toMatchObject({ chromiumSandbox: true });
      await pool.close();
    },
  );

  it("allows only an explicit sandbox opt-out", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts({
      ...options(),
      env: { T3CODE_SERVER_BROWSER_SANDBOX: "0" },
    });
    await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    expect(launches.launch).toHaveBeenCalledWith(
      expect.objectContaining({ chromiumSandbox: false }),
    );
    await pool.close();
  });

  it("retries a failed startup on a later request with sandboxing still enabled", async () => {
    const browser = makeBrowser();
    launches.launch
      .mockRejectedValueOnce(new Error("executable unavailable"))
      .mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("executable unavailable");
    await pool.contextFor("default", "agent");
    expect(launches.launch).toHaveBeenCalledTimes(2);
    expect(launches.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ chromiumSandbox: true }),
    );
    await pool.close();
  });

  it("cleans up a browser whose launch finishes during shutdown and rejects future work", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const pool = new ServerBrowserContexts(options());
    const opening = expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    const closing = pool.close();
    launch.resolve(browser as unknown as Browser);
    await Promise.all([opening, closing]);
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.contexts[0]?.close).toHaveBeenCalled();
  });

  it("runs a machine's tabs in its own Chrome, with one profile and no local storage", async () => {
    const browsers = new Map([
      ["a", makeMachineBrowser()],
      ["b", makeMachineBrowser()],
    ]);
    launches.connect.mockImplementation(
      async (endpoint) =>
        browsers.get(String(endpoint).includes("/a-") ? "a" : "b") as unknown as Browser,
    );
    const local = options();
    const pool = new ServerBrowserContexts(local);
    const a = machine("a");
    const b = machine("b");
    const [profile, again, named] = await Promise.all([
      pool.contextFor("default", undefined, a),
      pool.contextFor("default", undefined, a),
      // Named profiles are local-only: a machine has its one.
      pool.contextFor("work", undefined, a),
    ]);
    expect(profile).toBe(browsers.get("a")!.profile);
    expect(again).toBe(profile);
    expect(named).toBe(profile);
    const isolated = await pool.contextFor("default", "agent", a);
    const incognito = await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID, undefined, a);
    expect(browsers.get("a")!.created).toEqual([isolated, incognito]);
    expect(await pool.contextFor("default", undefined, b)).toBe(browsers.get("b")!.profile);
    expect(a.endpoint).toHaveBeenCalledTimes(1);
    expect(launches.connect).toHaveBeenCalledTimes(2);
    await pool.scratchPage(a).catch(() => undefined);
    expect(browsers.get("a")!.newContext).toHaveBeenCalledTimes(3);
    // Nothing on a machine tab's path starts, or even looks for, this server's Chromium.
    expect(local.executable).not.toHaveBeenCalled();
    expect(launches.launch).not.toHaveBeenCalled();
    expect(launches.persistent).not.toHaveBeenCalled();
    expect(launches.mkdir).not.toHaveBeenCalled();

    // A lost connection reconnects from a fresh endpoint; a new boot's Chrome is a new browser.
    const lost = browsers.get("a")!;
    lost.disconnect();
    lost.profile.close();
    browsers.set("a", makeMachineBrowser());
    expect(await pool.contextFor("default", undefined, a)).toBe(browsers.get("a")!.profile);
    expect(a.endpoint).toHaveBeenCalledTimes(2);

    await pool.close();
    expect(browsers.get("a")!.close).toHaveBeenCalled();
    expect(browsers.get("b")!.close).toHaveBeenCalled();
  });

  it("presents a machine tab with the kernel version it is given", async () => {
    const send = vi.fn(async (method: string, _params?: unknown) =>
      method === "Browser.getVersion"
        ? { userAgent: "Mozilla/5.0 HeadlessChrome/156.0.1.2 Safari/537.36" }
        : {},
    );
    await presentAsChrome({ send } as never, {
      platform: "linux",
      arch: "arm64",
      release: "6.8.0",
    });
    expect(send).toHaveBeenCalledWith(
      "Emulation.setUserAgentOverride",
      expect.objectContaining({
        userAgentMetadata: expect.objectContaining({ platform: "Linux", platformVersion: "6.8.0" }),
      }),
    );
  });

  it("keeps a machine's endpoint out of a failed attach's error", async () => {
    launches.connect.mockRejectedValue(
      new Error("connect ECONNREFUSED ws://127.0.0.1:1/devtools/browser/a-secret"),
    );
    const pool = new ServerBrowserContexts(options());
    const error = await pool.contextFor("default", undefined, machine("a")).catch((e) => e);
    expect(String(error.message)).not.toContain("secret");
    await pool.close();
  });
});
