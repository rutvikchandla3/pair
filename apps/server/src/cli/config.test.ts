// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import packageJson from "../../package.json" with { type: "json" };
import { ServiceLauncherHostProcess } from "../cloud/serviceLauncherClient.ts";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
} from "../cloud/serviceProtocol.ts";
import { deriveServerPaths } from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { acquireServerOwnership } from "../serverOwnership.ts";
import { releasePairBuilderSecrets, resolveServerConfig } from "./config.ts";

const deriveExplicitServerPaths = (baseDir: string, devUrl: URL | undefined) =>
  deriveServerPaths(baseDir, devUrl, { baseDirIsExplicit: true });

const minimalDesktopFlags = (baseDir: string) => ({
  mode: Option.some("desktop" as const),
  port: Option.some(4888),
  host: Option.none<string>(),
  baseDir: Option.some(baseDir),
  cwd: Option.none<string>(),
  devUrl: Option.none<URL>(),
  publicUrl: Option.none<URL>(),
  noBrowser: Option.none<boolean>(),
  bootstrapFd: Option.none<number>(),
  autoBootstrapProjectFromCwd: Option.none<boolean>(),
  logWebSocketEvents: Option.none<boolean>(),
  tailscaleServeEnabled: Option.none<boolean>(),
  tailscaleServePort: Option.none<number>(),
  lan: Option.none<boolean>(),
  restoreMode: Option.none<boolean>(),
  cloudOnly: Option.none<boolean>(),
  runnerHost: Option.none<string>(),
  runnerPort: Option.none<number>(),
});

const encodeDesktopBootstrap = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const makeDesktopBootstrap = (
  overrides: Partial<DesktopBackendBootstrapValue> = {},
): DesktopBackendBootstrapValue => ({
  mode: "desktop",
  noBrowser: true,
  port: 4888,
  t3Home: "/tmp/t3-bootstrap-home",
  host: "127.0.0.1",
  desktopBootstrapToken: "desktop-bootstrap-token",
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
  ...overrides,
});

const liveProcess = Effect.acquireRelease(
  Effect.promise(async () => {
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    await NodeEvents.EventEmitter.once(child, "spawn");
    return child;
  }),
  (child) =>
    Effect.promise(async () => {
      const exited = NodeEvents.EventEmitter.once(child, "exit");
      child.kill();
      await exited;
    }),
);

it.layer(NodeServices.layer)("cli config resolution", (it) => {
  const defaultObservabilityConfig = {
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 1_000,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
    otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
    otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
    otelEnvironment: OtelEnvironment.none,
    devAllowedOrigins: [],
  } as const;

  const openBootstrapFd = Effect.fn(function* (payload: DesktopBackendBootstrapValue) {
    const fs = yield* FileSystem.FileSystem;
    const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-", suffix: ".ndjson" });
    const encoded = yield* encodeDesktopBootstrap(payload);
    yield* fs.writeFileString(filePath, `${encoded}\n`);
    return yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.openSync(filePath, "r")),
      // Windows cannot reopen the fd through /proc or /dev/fd, so the reader closes it.
      (fd) =>
        Effect.sync(() => {
          try {
            NodeFS.closeSync(fd);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
          }
        }),
    );
  });

  it.effect("keeps stale records and supervised startup out of the manual launch preflight", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-preflight-" });
      const child = yield* liveProcess;
      assert(child.pid !== undefined);
      for (const [name, pid, mode, rejectRunningServer] of [
        ["stale", 2_147_483_647, "web", true],
        ["own-pid", process.pid, "web", true],
        ["desktop", child.pid, "desktop", true],
        ["serve", child.pid, "web", false],
      ] as const) {
        const baseDir = path.join(root, name);
        const stateDir = path.join(baseDir, "userdata");
        yield* fs.makeDirectory(stateDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(stateDir, "server-runtime.json"),
          yield* encodeUnknownJson({
            version: 1,
            pid,
            port: 3773,
            origin: "http://127.0.0.1:3773",
            startedAt: "2026-10-01T00:00:00.000Z",
          }),
        );
        const cwd = path.join(root, `${name}-project`);
        const configResult = yield* resolveServerConfig(
          {
            ...minimalWebFlags(baseDir),
            mode: Option.some(mode),
            port: Option.some(8788),
            cwd: Option.some(cwd),
          },
          Option.none(),
          { rejectRunningServer },
        ).pipe(
          Effect.provide(
            Layer.merge(
              NetService.layer,
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            ),
          ),
          Effect.result,
        );
        assert(Result.isSuccess(configResult));
        expect(configResult.success.cwd).toBe(cwd);
        expect(yield* fs.exists(cwd)).toBe(true);
      }
    }),
  );

  const acquireOwnership = (baseDir: string) =>
    acquireServerOwnership(NodePath.join(baseDir, "userdata", "server-runtime.json")).pipe(
      Effect.provide(Layer.merge(ProcessRunner.layer, NodeCrypto.layer)),
      Effect.provideService(HostProcess.HomeDirectory, baseDir),
      Effect.provideService(HostProcess.Environment, {}),
    );

  const resolveManualWebLaunch = (baseDir: string, cwd: string) =>
    resolveServerConfig({ ...minimalWebFlags(baseDir), cwd: Option.some(cwd) }, Option.none(), {
      rejectRunningServer: true,
    }).pipe(
      Effect.provide(
        Layer.merge(NetService.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      ),
      Effect.mapError(String),
      Effect.result,
    );

  it.effect("refuses a manual web launch while a lock-aware server owns the T3 home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-preflight-live-" });
      const child = yield* liveProcess;
      assert(child.pid !== undefined);
      const owner = yield* acquireOwnership(baseDir);
      yield* owner.publish({
        version: 1,
        pid: child.pid,
        port: 3773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-10-01T00:00:00.000Z",
      });
      const cwd = path.join(baseDir, "project");
      const result = yield* resolveManualWebLaunch(baseDir, cwd);
      assert(Result.isFailure(result));
      expect(result.failure).toContain("A Pair server is already running");
      expect(result.failure).toContain(`pid ${child.pid}`);
      expect(yield* fs.exists(cwd)).toBe(false);
    }),
  );

  it.effect("refuses a manual web launch when a pre-lock record belongs to a live process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-preflight-legacy-" });
      const child = yield* liveProcess;
      assert(child.pid !== undefined);
      const stateDir = path.join(baseDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        yield* encodeUnknownJson({
          version: 1,
          pid: child.pid,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: "2026-10-01T00:00:00.000Z",
        }),
      );
      const cwd = path.join(baseDir, "project");
      const result = yield* resolveManualWebLaunch(baseDir, cwd);
      assert(Result.isFailure(result));
      expect(result.failure).toContain(`pid ${child.pid}`);
      expect(yield* fs.exists(cwd)).toBe(false);
    }),
  );

  it.effect(
    "allows a manual web launch when a lock-aware record's PID was reused by an unrelated process",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-preflight-reused-" });
        const child = yield* liveProcess;
        assert(child.pid !== undefined);
        // The killed server's lock file stays behind, released.
        yield* Effect.scoped(acquireOwnership(baseDir));
        yield* fs.writeFileString(
          path.join(baseDir, "userdata", "server-runtime.json"),
          yield* encodeUnknownJson({
            version: 1,
            pid: child.pid,
            ownerId: "4ec9f94a-0000-4000-8000-000000000000",
            port: 3773,
            origin: "http://127.0.0.1:3773",
            startedAt: "2026-10-01T00:00:00.000Z",
          }),
        );
        const cwd = path.join(baseDir, "project");
        const result = yield* resolveManualWebLaunch(baseDir, cwd);
        expect(result).toEqual(Result.succeed(expect.objectContaining({ cwd })));
      }),
  );

  it.effect("names the pair command for the refused server's home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const child = yield* liveProcess;
      assert(child.pid !== undefined);
      for (const source of ["flag", "T3CODE_HOME", "default"] as const) {
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-preflight-pair-" });
        const baseDir = source === "default" ? path.join(home, ".t3") : home;
        const stateDir = path.join(baseDir, "userdata");
        yield* fs.makeDirectory(stateDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(stateDir, "server-runtime.json"),
          yield* encodeUnknownJson({
            version: 1,
            pid: child.pid,
            port: 3773,
            origin: "http://127.0.0.1:3773",
            startedAt: "2026-10-01T00:00:00.000Z",
          }),
        );
        const error = yield* resolveServerConfig(
          {
            ...minimalWebFlags(baseDir),
            baseDir: source === "flag" ? Option.some(baseDir) : Option.none(),
            cwd: Option.some(path.join(home, "project")),
          },
          Option.none(),
          { rejectRunningServer: true },
        ).pipe(
          Effect.provide(
            Layer.merge(
              NetService.layer,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: source === "T3CODE_HOME" ? { T3CODE_HOME: baseDir } : {},
                }),
              ),
            ),
          ),
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.flip,
        );
        // A temp dir with spaces or backslashes is single-quoted for the shell.
        const homePattern = baseDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        expect(String(error)).toMatch(
          new RegExp(`pair --base-dir (${homePattern}|'${homePattern}')`),
        );
      }
    }),
  );

  it.effect("enables a trimmed reusable auth token only for web dev mode", () =>
    Effect.gen(function* () {
      const baseDir = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-cli-dev-auth-" })),
      );
      const flags = {
        mode: Option.some("web" as const),
        port: Option.some(8788),
        host: Option.none<string>(),
        baseDir: Option.some(baseDir),
        cwd: Option.none<string>(),
        devUrl: Option.some(new URL("http://127.0.0.1:5173")),
        publicUrl: Option.none<URL>(),
        noBrowser: Option.none<boolean>(),
        bootstrapFd: Option.none<number>(),
        autoBootstrapProjectFromCwd: Option.none<boolean>(),
        logWebSocketEvents: Option.none<boolean>(),
        tailscaleServeEnabled: Option.none<boolean>(),
        tailscaleServePort: Option.none<number>(),
        lan: Option.none<boolean>(),
        restoreMode: Option.none<boolean>(),
        cloudOnly: Option.none<boolean>(),
        runnerHost: Option.none<string>(),
        runnerPort: Option.none<number>(),
      };
      const layerConfig = ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_DEV_AUTH_TOKEN: "  reusable-dev-auth-token-that-is-long-enough  ",
          },
        }),
      );
      const web = yield* resolveServerConfig(flags, Option.none()).pipe(
        Effect.provide(Layer.mergeAll(layerConfig, NetService.layer)),
      );
      const desktop = yield* resolveServerConfig(
        { ...flags, mode: Option.some("desktop" as const) },
        Option.none(),
      ).pipe(Effect.provide(Layer.mergeAll(layerConfig, NetService.layer)));

      expect(web.devAuthToken).toBeDefined();
      if (web.devAuthToken === undefined) {
        return yield* Effect.die("Expected reusable dev auth token.");
      }
      expect(Redacted.value(web.devAuthToken)).toBe("reusable-dev-auth-token-that-is-long-enough");
      expect(desktop.devAuthToken).toBeUndefined();
    }),
  );

  it.effect("reads Pair Builder host mode from its environment and refuses a broken one", () =>
    Effect.gen(function* () {
      const baseDir = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-cli-pair-builder-" })),
      );
      const flags = {
        ...minimalDesktopFlags(baseDir),
        mode: Option.some("web" as const),
        autoBootstrapProjectFromCwd: Option.some(true),
      };
      const secret = "ingress-secret-value";
      const resolve = (env: Record<string, string>) =>
        resolveServerConfig(flags, Option.none()).pipe(
          Effect.provide(
            Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), NetService.layer),
          ),
        );
      const host = {
        PAIR_BUILDER_INGRESS_TOKEN: ` ${secret} `,
        PAIR_BUILDER_SANDBOX_ID: "sandbox-1",
        PAIR_BUILDER_WORKSPACE_ROOT: "/projects/challenge/",
        PAIR_BUILDER_EVENTS_URL: "http://builder:8080/events",
        PAIR_BUILDER_EVENTS_TOKEN: "events-secret-value",
        PAIR_BUILDER_TASK: JSON.stringify({ key: "PAIR-12", title: "Fix login", space: "s" }),
      };

      const resolved = yield* resolve(host);
      expect(resolved.autoBootstrapProjectFromCwd).toBe(false);
      expect(resolved.pairBuilder).toMatchObject({
        sandboxId: "sandbox-1",
        workspaceRoot: "/projects/challenge",
        workspaceTitle: "PAIR-12: Fix login",
      });
      expect(Redacted.value(resolved.pairBuilder!.ingressToken)).toBe(secret);
      expect(resolved.pairBuilder?.events?.url.href).toBe("http://builder:8080/events");
      expect(
        (yield* resolve({ ...host, PAIR_BUILDER_TASK: JSON.stringify({ title: "Fix login" }) }))
          .pairBuilder?.workspaceTitle,
      ).toBe("Fix login");

      const { PAIR_BUILDER_EVENTS_URL: _url, PAIR_BUILDER_TASK: _task, ...minimal } = host;
      expect((yield* resolve(minimal)).pairBuilder).toMatchObject({
        events: undefined,
        workspaceTitle: undefined,
      });
      const off = yield* resolve({ ...host, PAIR_BUILDER_INGRESS_TOKEN: " " });
      expect(off.pairBuilder).toBeUndefined();
      expect(off.autoBootstrapProjectFromCwd).toBe(true);

      for (const broken of [
        { PAIR_BUILDER_WORKSPACE_ROOT: "" },
        { PAIR_BUILDER_WORKSPACE_ROOT: "projects/challenge" },
        { PAIR_BUILDER_EVENTS_URL: "builder:8080/events" },
        { PAIR_BUILDER_EVENTS_URL: "ftp://builder/events" },
        { PAIR_BUILDER_EVENTS_TOKEN: "" },
        { PAIR_BUILDER_TASK: `{"key": "${secret}"` },
      ]) {
        const error = yield* Effect.flip(resolve({ ...host, ...broken }));
        expect(String(error)).toContain("PAIR_BUILDER_");
        expect(String(error)).not.toContain(secret);
      }
    }),
  );

  it.effect("drops the host-mode secrets from the environment children inherit", () =>
    Effect.gen(function* () {
      const environment: NodeJS.ProcessEnv = {
        PATH: "/usr/bin",
        PAIR_BUILDER_INGRESS_TOKEN: "ingress-secret-value",
        PAIR_BUILDER_EVENTS_TOKEN: "events-secret-value",
        PAIR_BUILDER_SANDBOX_ID: "sandbox-1",
      };
      yield* releasePairBuilderSecrets().pipe(
        Effect.provideService(HostProcess.Environment, environment),
      );
      expect(environment).toEqual({ PATH: "/usr/bin", PAIR_BUILDER_SANDBOX_ID: "sandbox-1" });
    }),
  );

  it.effect("does not expose an invalid reusable auth token", () =>
    Effect.gen(function* () {
      const secret = "short-secret";
      const baseDir = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-cli-dev-auth-invalid-" })),
      );
      const flags = {
        mode: Option.some("web" as const),
        port: Option.some(8788),
        host: Option.none<string>(),
        baseDir: Option.some(baseDir),
        cwd: Option.none<string>(),
        devUrl: Option.some(new URL("http://127.0.0.1:5173")),
        publicUrl: Option.none<URL>(),
        noBrowser: Option.none<boolean>(),
        bootstrapFd: Option.none<number>(),
        autoBootstrapProjectFromCwd: Option.none<boolean>(),
        logWebSocketEvents: Option.none<boolean>(),
        tailscaleServeEnabled: Option.none<boolean>(),
        tailscaleServePort: Option.none<number>(),
        lan: Option.none<boolean>(),
        restoreMode: Option.none<boolean>(),
        cloudOnly: Option.none<boolean>(),
        runnerHost: Option.none<string>(),
        runnerPort: Option.none<number>(),
      };
      const layerConfig = ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { T3CODE_DEV_AUTH_TOKEN: secret } }),
      );
      const error = yield* resolveServerConfig(flags, Option.none()).pipe(
        Effect.provide(Layer.mergeAll(layerConfig, NetService.layer)),
        Effect.flip,
      );
      const desktop = yield* resolveServerConfig(
        { ...flags, mode: Option.some("desktop" as const) },
        Option.none(),
      ).pipe(Effect.provide(Layer.mergeAll(layerConfig, NetService.layer)));
      const staticWeb = yield* resolveServerConfig(
        { ...flags, devUrl: Option.none() },
        Option.none(),
      ).pipe(Effect.provide(Layer.mergeAll(layerConfig, NetService.layer)));

      expect(String(error)).not.toContain(secret);
      const serialized = yield* encodeUnknownJson(error);
      expect(serialized).not.toContain(secret);
      expect(desktop.devAuthToken).toBeUndefined();
      expect(staticWeb.devAuthToken).toBeUndefined();
    }),
  );

  it.effect("preserves explicit false CLI boolean flags over env and bootstrap values", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-false-flags");
      const fd = yield* openBootstrapFd(
        makeDesktopBootstrap({
          noBrowser: true,
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        }),
      );
      const derivedPaths = yield* deriveExplicitServerPaths(
        baseDir,
        new URL("http://127.0.0.1:4173"),
      );

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          publicUrl: Option.none<URL>(),
          noBrowser: Option.some(false),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.some(false),
          logWebSocketEvents: Option.some(false),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
          lan: Option.none(),
          restoreMode: Option.none(),
          cloudOnly: Option.none(),
          runnerHost: Option.none(),
          runnerPort: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_BOOTSTRAP_FD: String(fd),
                  T3CODE_NO_BROWSER: "true",
                  T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                  T3CODE_LOG_WS_EVENTS: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Info",
        ...defaultObservabilityConfig,
        mode: "web",
        port: 8788,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        noBrowser: false,
        startupPresentation: "browser",
        desktopBootstrapToken: "desktop-bootstrap-token",
        autoBootstrapProjectFromCwd: false,
        cloudOnly: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      });
    }),
  );

  it.effect("applies flag then env precedence over bootstrap envelope values", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-env-wins");
      const fd = yield* openBootstrapFd(
        makeDesktopBootstrap({
          port: 4888,
          host: "127.0.0.2",
          t3Home: "/tmp/t3-bootstrap-home",
          noBrowser: false,
          desktopBootstrapToken: "desktop-token",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        }),
      );
      const derivedPaths = yield* deriveExplicitServerPaths(
        baseDir,
        new URL("http://127.0.0.1:4173"),
      );

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.none(),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          baseDir: Option.none(),
          cwd: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          publicUrl: Option.none<URL>(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
          lan: Option.none(),
          restoreMode: Option.none(),
          cloudOnly: Option.some(false),
          runnerHost: Option.none(),
          runnerPort: Option.none(),
        },
        Option.some("Debug"),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_MODE: "web",
                  T3CODE_BOOTSTRAP_FD: String(fd),
                  T3CODE_HOME: baseDir,
                  T3CODE_NO_BROWSER: "true",
                  T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                  T3CODE_LOG_WS_EVENTS: "true",
                  T3CODE_CLOUD_ONLY: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Debug",
        ...defaultObservabilityConfig,
        mode: "web",
        port: 8788,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        noBrowser: true,
        startupPresentation: "browser",
        desktopBootstrapToken: "desktop-token",
        autoBootstrapProjectFromCwd: true,
        cloudOnly: false,
        logWebSocketEvents: true,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      });
    }),
  );

  it.effect("refuses cloud-only in desktop mode and never bootstraps a cwd project", () =>
    Effect.gen(function* () {
      const baseDir = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-cli-cloud-only-" })),
      );
      const provideEnv = (env: Record<string, string>) =>
        Effect.provide(
          Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), NetService.layer),
        );

      const desktopError = yield* resolveServerConfig(
        { ...minimalDesktopFlags(baseDir), cloudOnly: Option.some(true) },
        Option.none(),
      ).pipe(provideEnv({}), Effect.flip);
      const web = yield* resolveServerConfig(
        {
          ...minimalDesktopFlags(baseDir),
          mode: Option.some("web" as const),
          autoBootstrapProjectFromCwd: Option.some(true),
        },
        Option.none(),
        { forceAutoBootstrapProjectFromCwd: true },
      ).pipe(provideEnv({ T3CODE_CLOUD_ONLY: "true" }));

      assert(desktopError._tag === "UserError");
      expect(desktopError.message).toContain("Cloud-only mode is for Pair Cloud servers");
      expect(web.cloudOnly).toBe(true);
      expect(web.autoBootstrapProjectFromCwd).toBe(false);
    }),
  );

  it.effect("reports the desktop bootstrap as the source of endpoints it supplied", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-cli-config-otlp-bootstrap-",
      });
      const fd = yield* openBootstrapFd(
        makeDesktopBootstrap({
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
          otlpLogsUrl: "http://localhost:4318/v1/logs",
        }),
      );

      const resolved = yield* resolveServerConfig(
        { ...minimalDesktopFlags(baseDir), bootstrapFd: Option.some(fd) },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toMatchObject({
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpTracesSource: "bootstrap",
        otlpMetricsSource: "bootstrap",
        otlpLogsSource: "bootstrap",
      });
    }),
  );

  it.effect("reports saved settings as the source of endpoints read from settings.json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-config-otlp-settings-" });
      const derivedPaths = yield* deriveExplicitServerPaths(baseDir, undefined);
      yield* fs.makeDirectory(path.dirname(derivedPaths.settingsPath), { recursive: true });
      yield* fs.writeFileString(
        derivedPaths.settingsPath,
        `${JSON.stringify({
          observability: {
            otlpTracesUrl: "http://localhost:4318/v1/traces",
            otlpMetricsUrl: "http://localhost:4318/v1/metrics",
            otlpLogsUrl: "http://localhost:4318/v1/logs",
          },
        })}\n`,
      );

      const resolved = yield* resolveServerConfig(minimalDesktopFlags(baseDir), Option.none()).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toMatchObject({
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpTracesSource: "settings",
        otlpMetricsSource: "settings",
        otlpLogsSource: "settings",
      });
    }),
  );

  it.effect("zeroes an endpoint stored in Settings when the SDK is disabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-config-otel-off-" });
      const derivedPaths = yield* deriveExplicitServerPaths(baseDir, undefined);
      yield* fs.makeDirectory(path.dirname(derivedPaths.settingsPath), { recursive: true });
      yield* fs.writeFileString(
        derivedPaths.settingsPath,
        `${JSON.stringify({
          observability: {
            otlpTracesUrl: "http://localhost:4318/v1/traces",
            otlpMetricsUrl: "http://localhost:4318/v1/metrics",
            otlpLogsUrl: "http://localhost:4318/v1/logs",
          },
        })}\n`,
      );

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("desktop"),
          port: Option.some(4888),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.none(),
          publicUrl: Option.none<URL>(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
          lan: Option.none(),
          restoreMode: Option.none(),
          cloudOnly: Option.none(),
          runnerHost: Option.none(),
          runnerPort: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { OTEL_SDK_DISABLED: "true" } })),
            NetService.layer,
          ),
        ),
      );

      expect(resolved.otlpTracesUrl).toBeUndefined();
      expect(resolved.otlpMetricsUrl).toBeUndefined();
      expect(resolved.otlpLogsUrl).toBeUndefined();
      expect(resolved.otelEnvironment.disabled).toBe(true);
    }),
  );

  it.effect("lets T3CODE_OTEL_SDK_DISABLED=false override an ambient OTEL_SDK_DISABLED=true", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-config-otel-on-" });
      const derivedPaths = yield* deriveExplicitServerPaths(baseDir, undefined);
      yield* fs.makeDirectory(path.dirname(derivedPaths.settingsPath), { recursive: true });
      yield* fs.writeFileString(
        derivedPaths.settingsPath,
        `${JSON.stringify({
          observability: {
            otlpTracesUrl: "http://localhost:4318/v1/traces",
          },
        })}\n`,
      );

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("desktop"),
          port: Option.some(4888),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.none(),
          publicUrl: Option.none<URL>(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
          lan: Option.none(),
          restoreMode: Option.none(),
          cloudOnly: Option.none(),
          runnerHost: Option.none(),
          runnerPort: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { T3CODE_OTEL_SDK_DISABLED: "false", OTEL_SDK_DISABLED: "true" },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved.otelEnvironment.disabled).toBe(false);
      expect(resolved.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
    }),
  );

  it.effect("forces noBrowser and disables auto-bootstrap for headless startup presentation", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-headless-base");
      const derivedPaths = yield* deriveExplicitServerPaths(baseDir, undefined);

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(3773),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.none(),
          publicUrl: Option.none<URL>(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
          lan: Option.none(),
          restoreMode: Option.none(),
          cloudOnly: Option.none(),
          runnerHost: Option.none(),
          runnerPort: Option.none(),
        },
        Option.none(),
        {
          startupPresentation: "headless",
        },
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_NO_BROWSER: "false",
                  T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Info",
        ...defaultObservabilityConfig,
        mode: "web",
        port: 3773,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: undefined,
        staticDir: resolved.staticDir,
        devUrl: undefined,
        noBrowser: true,
        startupPresentation: "headless",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: false,
        cloudOnly: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      });
    }),
  );

  it.effect("keeps whitespace-separated pairs and literal equals signs in OTLP headers", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-otlp-headers-loose-base");

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(3773),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.none(),
          publicUrl: Option.none<URL>(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
          lan: Option.none(),
          restoreMode: Option.none(),
          cloudOnly: Option.none(),
          runnerHost: Option.none(),
          runnerPort: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_OTLP_HEADERS: "authorization=Bearer abc==, x-tenant=t3",
                  T3CODE_OTLP_TRACES_URL: "http://collector.internal:4318",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved.otlpTracesExport.headers).toEqual({
        authorization: "Bearer abc==",
        "x-tenant": "t3",
      });
      expect(resolved.otlpTracesUrl).toBe("http://collector.internal:4318");
    }),
  );

  const minimalWebFlags = (baseDir: string) => ({
    mode: Option.some("web" as const),
    port: Option.some(3773),
    host: Option.none<string>(),
    baseDir: Option.some(baseDir),
    cwd: Option.none<string>(),
    devUrl: Option.none<URL>(),
    publicUrl: Option.none<URL>(),
    noBrowser: Option.none<boolean>(),
    bootstrapFd: Option.none<number>(),
    autoBootstrapProjectFromCwd: Option.none<boolean>(),
    logWebSocketEvents: Option.none<boolean>(),
    tailscaleServeEnabled: Option.none<boolean>(),
    tailscaleServePort: Option.none<number>(),
    lan: Option.none<boolean>(),
    restoreMode: Option.none<boolean>(),
    cloudOnly: Option.none<boolean>(),
    runnerHost: Option.none<string>(),
    runnerPort: Option.none<number>(),
  });

  it.effect("uses the automatic port selector only when no port is configured", () =>
    Effect.gen(function* () {
      const baseDir = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-cli-auto-port-" })),
      );
      const selected: number[] = [];
      const selectAutomaticPort = (preferred: number) =>
        Effect.sync(() => {
          selected.push(preferred);
          return 50_123;
        });
      const resolvePort = (flags: {
        readonly mode?: Option.Option<"web" | "desktop">;
        readonly port: Option.Option<number>;
      }) =>
        resolveServerConfig({ ...minimalWebFlags(baseDir), ...flags }, Option.none(), {
          selectAutomaticPort,
        }).pipe(
          Effect.map((config) => config.port),
          Effect.provide(
            Layer.merge(
              NetService.layer,
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            ),
          ),
        );

      expect(yield* resolvePort({ port: Option.none() })).toBe(50_123);
      expect(selected).toEqual([3773]);
      expect(yield* resolvePort({ port: Option.some(8788) })).toBe(8788);
      expect(
        yield* resolvePort({ mode: Option.some("desktop" as const), port: Option.none() }),
      ).toBe(3773);
      expect(selected).toEqual([3773]);
    }),
  );

  it.effect(
    "takes an origin from --public-url over T3CODE_PUBLIC_URL and refuses anything else",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* FileSystem.FileSystem.pipe(
          Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-cli-public-url-" })),
        );
        const resolvePublicUrl = (flag: string | undefined, env: Record<string, string> = {}) =>
          resolveServerConfig(
            {
              ...minimalWebFlags(baseDir),
              port: Option.some(8788),
              publicUrl: Option.fromUndefinedOr(flag).pipe(Option.map((url) => new URL(url))),
            },
            Option.none(),
          ).pipe(
            Effect.map((config) => config.publicUrl?.href),
            Effect.provide(
              Layer.merge(NetService.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
            ),
          );

        const env = { T3CODE_PUBLIC_URL: "https://env.example.com" };
        expect(yield* resolvePublicUrl("https://pair.example.com", env)).toBe(
          "https://pair.example.com/",
        );
        expect(yield* resolvePublicUrl(undefined, env)).toBe("https://env.example.com/");
        expect(yield* resolvePublicUrl(undefined)).toBeUndefined();
        for (const url of [
          "https://x/path",
          "https://x/?a=1",
          "https://x/#a",
          "https://user:pass@x",
          "ftp://x",
        ]) {
          const error = yield* resolvePublicUrl(url).pipe(Effect.flip);
          expect(String(error.cause), url).toBe(
            "--public-url must be an origin, like https://pair.example.com.",
          );
        }
      }),
  );

  it.effect("takes a runner listener only as a named address and a port of its own", () =>
    Effect.gen(function* () {
      const baseDir = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-cli-runner-listener-" })),
      );
      const resolveRunnerListener = (
        flags: { readonly host?: string; readonly port?: number },
        env: Record<string, string> = {},
      ) =>
        resolveServerConfig(
          {
            ...minimalWebFlags(baseDir),
            runnerHost: Option.fromUndefinedOr(flags.host),
            runnerPort: Option.fromUndefinedOr(flags.port),
          },
          Option.none(),
        ).pipe(
          Effect.map((config) => config.runnerListener),
          Effect.provide(
            Layer.merge(NetService.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
          ),
        );
      const refusal = (
        flags: { readonly host?: string; readonly port?: number },
        env?: Record<string, string>,
      ) =>
        resolveRunnerListener(flags, env).pipe(
          Effect.flip,
          Effect.map((error) => String(error.cause)),
        );

      expect(yield* resolveRunnerListener({})).toBeUndefined();
      expect(yield* resolveRunnerListener({ host: "10.0.0.2", port: 3774 })).toEqual({
        host: "10.0.0.2",
        port: 3774,
      });
      expect(
        yield* resolveRunnerListener(
          {},
          { T3CODE_RUNNER_HOST: "10.0.0.2", T3CODE_RUNNER_PORT: "3774" },
        ),
      ).toEqual({ host: "10.0.0.2", port: 3774 });
      expect(yield* refusal({ host: "10.0.0.2" })).toBe(
        "Set --runner-host and --runner-port together, or neither.",
      );
      expect(yield* refusal({}, { T3CODE_RUNNER_PORT: "3774" })).toBe(
        "Set --runner-host and --runner-port together, or neither.",
      );
      for (const host of ["0.0.0.0", "::", "[::]"]) {
        expect(yield* refusal({ host, port: 3774 }), host).toBe(
          "Name the address your machines reach for --runner-host, not every interface.",
        );
      }
      expect(yield* refusal({ host: "10.0.0.2", port: 3773 })).toBe(
        "--runner-port must differ from the server's own port, 3773.",
      );
    }),
  );

  it.effect(
    "resolves each signal's endpoint through T3CODE_OTLP_*_URL, an OTEL endpoint, the bootstrap envelope, and persisted Settings, in that order",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-cli-config-otel-precedence-",
        });
        const derivedPaths = yield* deriveExplicitServerPaths(baseDir, undefined);
        yield* fs.makeDirectory(path.dirname(derivedPaths.settingsPath), { recursive: true });
        yield* fs.writeFileString(
          derivedPaths.settingsPath,
          `${JSON.stringify({ observability: { otlpLogsUrl: "http://settings:4318/v1/logs" } })}\n`,
        );

        const fd = yield* openBootstrapFd(
          makeDesktopBootstrap({
            otlpMetricsUrl: "http://bootstrap:4318/v1/metrics",
            otlpLogsUrl: "",
          }),
        );

        const resolved = yield* resolveServerConfig(
          {
            ...minimalWebFlags(baseDir),
            mode: Option.some("desktop"),
            port: Option.some(4888),
            bootstrapFd: Option.some(fd),
          },
          Option.none(),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: {
                    T3CODE_OTLP_TRACES_URL: "http://t3:4318/v1/traces",
                    T3CODE_OTLP_HEADERS: "x-key=secret",
                    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://otel-traces:4318/custom",
                    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://otel-metrics:4318/custom",
                    OTEL_EXPORTER_OTLP_HEADERS: "x-key=otel",
                  },
                }),
              ),
              NetService.layer,
            ),
          ),
        );

        expect(resolved.otlpTracesUrl).toBe("http://t3:4318/v1/traces");
        expect(resolved.otlpTracesExport.headers).toEqual({ "x-key": "secret" });
        expect(resolved.otlpMetricsUrl).toBe("http://otel-metrics:4318/custom");
        expect(resolved.otlpMetricsExport).toEqual({
          ...DEFAULT_SIGNAL_EXPORT,
          protocol: "http/protobuf",
          headers: { "x-key": "otel" },
        });
        expect(resolved.otlpLogsUrl).toBe("http://settings:4318/v1/logs");
        expect(resolved.otlpLogsExport.headers).toEqual({ "x-key": "secret" });
        expect(resolved).toMatchObject({
          otlpTracesVariable: "T3CODE_OTLP_TRACES_URL",
          otlpMetricsVariable: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
        });
        expect(resolved.otlpLogsVariable).toBeUndefined();
      }),
  );

  it.effect(
    "exports nothing for a signal an OTEL endpoint claimed with a protocol or headers that do not read",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-cli-config-otel-off-",
        });
        const derivedPaths = yield* deriveExplicitServerPaths(baseDir, undefined);
        yield* fs.makeDirectory(path.dirname(derivedPaths.settingsPath), { recursive: true });
        yield* fs.writeFileString(
          derivedPaths.settingsPath,
          `${JSON.stringify({ observability: { otlpLogsUrl: "http://settings:4318/v1/logs" } })}\n`,
        );

        const fd = yield* openBootstrapFd(
          makeDesktopBootstrap({ otlpMetricsUrl: "http://bootstrap:4318/v1/metrics" }),
        );

        const resolved = yield* resolveServerConfig(
          {
            ...minimalWebFlags(baseDir),
            mode: Option.some("desktop"),
            port: Option.some(4888),
            bootstrapFd: Option.some(fd),
          },
          Option.none(),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: {
                    T3CODE_OTLP_TRACES_URL: "http://t3:4318/v1/traces",
                    OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318",
                    OTEL_EXPORTER_OTLP_HEADERS: "x-key=%zz",
                  },
                }),
              ),
              NetService.layer,
            ),
          ),
        );

        expect(resolved.otlpTracesUrl).toBe("http://t3:4318/v1/traces");
        expect(resolved.otlpMetricsUrl).toBeUndefined();
        expect(resolved.otlpLogsUrl).toBeUndefined();
      }),
  );

  it.effect("listens on private networks per T3CODE_LAN, else under the service launcher", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-service-host");
      const resolveHost = (input: {
        readonly connected: boolean;
        readonly env?: Record<string, string>;
      }) =>
        resolveServerConfig(minimalWebFlags(baseDir), Option.none()).pipe(
          Effect.map(({ host, privateNetworkOnly }) => ({ host, privateNetworkOnly })),
          Effect.provide(
            Layer.mergeAll(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env ?? {} })),
              NetService.layer,
            ),
          ),
          Effect.provideService(HostProcess.Environment, {
            [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify({
              protocol: SERVICE_LAUNCHER_PROTOCOL,
              childVersion: packageJson.version,
            }),
          }),
          Effect.provideService(ServiceLauncherHostProcess, {
            connected: input.connected,
            send: () => false,
            on: () => undefined,
            off: () => undefined,
          }),
        );

      // A service installed before T3CODE_LAN existed.
      expect(yield* resolveHost({ connected: true })).toEqual({
        host: "0.0.0.0",
        privateNetworkOnly: true,
      });
      // `service.env` reaches the server as its environment.
      expect(yield* resolveHost({ connected: true, env: { T3CODE_HOST: "127.0.0.1" } })).toEqual({
        host: "127.0.0.1",
        privateNetworkOnly: undefined,
      });
      expect(yield* resolveHost({ connected: true, env: { T3CODE_LAN: "false" } })).toEqual({
        host: undefined,
        privateNetworkOnly: undefined,
      });
      expect(yield* resolveHost({ connected: false, env: { T3CODE_LAN: "true" } })).toEqual({
        host: "0.0.0.0",
        privateNetworkOnly: true,
      });
      // Without the launcher's IPC channel the context was inherited, e.g. by
      // `t3 serve` started from an agent inside the service.
      expect(yield* resolveHost({ connected: false })).toEqual({
        host: undefined,
        privateNetworkOnly: undefined,
      });
    }),
  );
});
