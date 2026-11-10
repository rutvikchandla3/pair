// @effect-diagnostics nodeBuiltinImport:off - Owns Playwright resources outside the Effect runtime.
import { DEFAULT_BROWSER_PROFILE_ID, INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Browser, BrowserContext, CDPSession } from "playwright-core";

import { sandboxDisabled } from "./PreviewBrowserHost.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

interface Options {
  readonly profilesDir: string;
  readonly executable: () => Promise<string>;
  /**
   * A path that starts `executable`, such as one that moves Chrome out of the server's cgroup.
   * Released after the whole launch call, since Playwright retries the same path after a glibc race.
   */
  readonly launcher?: (
    executable: string,
  ) => Promise<{ readonly path: string; readonly release: () => Promise<void> } | undefined>;
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onContextClose?: (context: BrowserContext) => void;
}

/** Chrome flags every preview browser starts with, on the server or on a machine. */
export const PREVIEW_BROWSER_ARGS = [
  "--disable-gpu",
  "--force-device-scale-factor=2",
  "--disable-blink-features=AutomationControlled",
] as const;

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/** Change user agent and Sec-CH-UA together; sites block mismatches. */
const chromeIdentity = (
  headlessUserAgent: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release: string },
) => {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  const brands = (names: (version: string) => string) => [
    { brand: "Chromium", version: names(major) },
    { brand: "Google Chrome", version: names(major) },
    { brand: "Not A(Brand", version: names("99") },
  ];
  return {
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platform === "linux" ? host.release : "",
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
};

/**
 * A thread's machine (Pair Cloud): its Chrome runs there and the server attaches over CDP.
 * `endpoint` is a secret and is never logged.
 */
export interface MachineTarget {
  readonly sandboxId: string;
  readonly endpoint: () => Promise<string>;
}

/** `release` defaults to this server's kernel; a machine tab passes a fixed one. */
export const presentAsChrome = async (
  cdp: CDPSession,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release?: string },
) => {
  const { userAgent } = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(userAgent, {
    ...host,
    release: host.release ?? NodeOS.release(),
  });
  if (identity) await cdp.send("Emulation.setUserAgentOverride", identity);
};

export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  private readonly clearing = new Map<string, Promise<void>>();
  private readonly machines = new Map<string, Promise<Browser>>();
  private browser: Promise<Browser> | undefined;
  private closing: Promise<void> | undefined;

  constructor(options: Options) {
    this.options = options;
  }

  private async launchOptions() {
    const executable = await this.options.executable();
    const env = this.options.env ?? process.env;
    return {
      executable,
      env,
      args: [...PREVIEW_BROWSER_ARGS],
      ignoreDefaultArgs: ["--enable-automation"],
      headless: true,
      // Only an explicit operator opt-out disables sandboxing. Launch errors never do.
      chromiumSandbox: !sandboxDisabled(env),
    };
  }

  private async launch<A>(executable: string, start: (executablePath: string) => Promise<A>) {
    let release: (() => Promise<void>) | undefined;
    try {
      const launcher = await this.options.launcher?.(executable);
      release = launcher?.release;
      return await start(launcher?.path ?? executable);
    } catch (cause) {
      throw (await this.options.diagnose?.(executable, cause)) ?? cause;
    } finally {
      await release?.().catch(constVoid);
    }
  }

  private sharedBrowser() {
    if (!this.browser) {
      const launched = this.launchOptions().then(async ({ executable, ...options }) => {
        const { chromium } = loadPlaywright();
        const browser = await this.launch(executable, (executablePath) =>
          chromium.launch({ ...options, executablePath }),
        );
        browser.on("disconnected", () => {
          if (this.browser === launched) this.browser = undefined;
        });
        return browser;
      });
      this.browser = launched;
      void launched.catch(() => {
        if (this.browser === launched) this.browser = undefined;
      });
    }
    return this.browser;
  }

  /** One connection per machine; Chrome itself belongs to the machine and outlives it. */
  private machineBrowser(machine: MachineTarget) {
    const cached = this.machines.get(machine.sandboxId);
    if (cached) return cached;
    const connected = machine.endpoint().then(async (endpoint) => {
      const { chromium } = loadPlaywright();
      const browser = await chromium
        .connectOverCDP(endpoint, { timeout: 15_000 })
        .catch((cause: unknown) => {
          // Playwright's message quotes the endpoint, which is a secret.
          throw new Error("Could not attach to the machine's browser.", {
            cause: cause instanceof Error ? cause.name : undefined,
          });
        });
      browser.on("disconnected", () => {
        if (this.machines.get(machine.sandboxId) === connected) {
          this.machines.delete(machine.sandboxId);
        }
      });
      return browser;
    });
    this.machines.set(machine.sandboxId, connected);
    void connected.catch(() => {
      if (this.machines.get(machine.sandboxId) === connected)
        this.machines.delete(machine.sandboxId);
    });
    return connected;
  }

  contextFor(
    profileId: string,
    isolationKey?: string,
    machine?: MachineTarget,
  ): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const key = JSON.stringify(
      machine === undefined
        ? [profileId, isolationKey ?? null]
        : // Named profiles are local-only (Q2): every other tab shares the machine's one profile.
          [
            isolationKey === undefined && profileId !== INCOGNITO_BROWSER_PROFILE_ID
              ? DEFAULT_BROWSER_PROFILE_ID
              : profileId,
            isolationKey ?? null,
            machine.sandboxId,
          ],
    );
    const cached = this.contexts.get(key);
    if (cached) return cached;
    const cleared = this.clearing.get(key)?.catch(constVoid) ?? Promise.resolve();
    const pending = cleared
      .then(() =>
        machine === undefined
          ? this.createContext(profileId, isolationKey)
          : this.createMachineContext(machine, profileId, isolationKey),
      )
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
        });
        for (const page of context.pages()) await page.close().catch(constVoid);
        if (this.closing) {
          await context.close().catch(constVoid);
          throw new Error("The preview browser is closed.");
        }
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  private async createContext(profileId: string, isolationKey?: string) {
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
    if (isolationKey !== undefined || profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      const browser = await this.sharedBrowser();
      return browser.newContext(contextOptions);
    }
    const directory = this.profileDirectory(profileId);
    await NodeFSP.mkdir(directory, { recursive: true });
    const { executable, ...options } = await this.launchOptions();
    const { chromium } = loadPlaywright();
    return this.launch(executable, (executablePath) =>
      chromium.launchPersistentContext(directory, {
        ...options,
        ...contextOptions,
        executablePath,
      }),
    );
  }

  /**
   * Q2: a machine has one persistent profile, Chrome's default context. Agent and incognito tabs
   * get their own context as on a server. Spike #1 and #2 (m7-cloud-browser.md 7.4).
   */
  private async createMachineContext(
    machine: MachineTarget,
    profileId: string,
    isolationKey: string | undefined,
  ) {
    const browser = await this.machineBrowser(machine);
    if (isolationKey !== undefined || profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      return browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    }
    const context = browser.contexts()[0];
    if (!context) throw new Error("The machine's browser has no default context.");
    return context;
  }

  private profileDirectory(profileId: string) {
    const encoded = encodeURIComponent(profileId);
    return NodePath.join(
      this.options.profilesDir,
      profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
    );
  }

  /** A machine tab's scratch page runs on its machine, so the server's Chromium never starts. */
  async scratchPage(machine?: MachineTarget) {
    if (this.closing) throw new Error("The preview browser is closed.");
    const browser = await (machine === undefined
      ? this.sharedBrowser()
      : this.machineBrowser(machine));
    const context = await browser.newContext();
    const page = await context.newPage();
    page.once("close", () => void context.close().catch(constVoid));
    return page;
  }

  async connectDesktopPage(endpoint: string) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close().catch(constVoid);
      throw new Error("The desktop tab has no page.");
    }
    return { browser, page };
  }

  async clearProfile(profileId: string) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    const key = JSON.stringify([profileId, null]);
    const existing = this.clearing.get(key);
    if (existing) return existing;
    const clearing = (async () => {
      const pending = this.contexts.get(key);
      if (pending) {
        this.contexts.delete(key);
        const context = await pending.catch(() => undefined);
        await context?.close();
      }
      await NodeFSP.rm(this.profileDirectory(profileId), { recursive: true, force: true });
    })();
    this.clearing.set(key, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(key) === clearing) this.clearing.delete(key);
    }
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    await Promise.allSettled(
      [...this.contexts.values()].map(async (pending) => (await pending).close()),
    );
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close().catch(constVoid);
    // Disconnects only: a browser Playwright attached to keeps running.
    await Promise.allSettled(
      [...this.machines.values()].map(async (pending) => (await pending).close()),
    );
    this.machines.clear();
    this.contexts.clear();
  }
}
