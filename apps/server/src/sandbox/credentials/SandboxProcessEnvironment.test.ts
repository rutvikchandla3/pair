import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  ComputeDriverId,
  type OrchestrationV2Sandbox,
  ProjectId,
  SandboxId,
  type SecretReference,
  SecretProviderId,
  ThreadId,
} from "@t3tools/contracts";
import { RUNNER_PROTOCOL_VERSION, type RunnerInfo } from "@t3tools/contracts/runner";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ServerSettings from "../../serverSettings.ts";
import type { WorkspaceHost, WorkspaceHostId } from "../../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";
import * as WorkspaceHostTesting from "../../workspaceHost/WorkspaceHostTesting.ts";
import * as SandboxProcessEnvironment from "./SandboxProcessEnvironment.ts";

const sandboxId = SandboxId.make("sbx_0000000000000000000a");
const projectId = ProjectId.make("project-a");
const vault = SecretProviderId.make("vault");
const readable: SecretReference = { provider: vault, reference: "op://team/db/password" };
const locked: SecretReference = { provider: vault, reference: "op://team/locked/password" };

const runnerInfo: RunnerInfo = {
  runnerBootId: "runner-boot",
  runnerBuildId: "build",
  protocolVersion: RUNNER_PROTOCOL_VERSION,
  arch: "x64",
  cpus: 2,
  memoryBytes: 1024,
  agent: { uid: 1000, homeDirectory: "/home/t3", shell: "/bin/bash" },
  tmpDirectory: "/tmp",
  bundleDirectory: "/opt/pair-runner/build",
  imageEnvironment: {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    IMAGE_TOOL: "1",
    HOME: "/root",
    PWD: "/",
    T3CODE_PORT: "3773",
    CLAUDE_CONFIG_DIR: "/image/claude",
  },
  handles: [],
};

const record: OrchestrationV2Sandbox = {
  id: sandboxId,
  projectId,
  ownerThreadId: ThreadId.make("thread-a"),
  ownerMemberId: null,
  driverId: ComputeDriverId.make("docker"),
  size: "default",
  state: "ready",
  generation: 1,
  driverRef: "ref",
  admission: null,
  runnerLostAt: null,
  sleepReason: null,
  failure: null,
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(0),
};

const sandboxHost = Effect.gen(function* () {
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  return {
    ...hosts.local,
    id: sandboxId as string as WorkspaceHostId,
    kind: "sandbox",
    info: Effect.succeed({
      platform: "linux",
      architecture: "x64",
      homeDirectory: "/home/t3",
      environment: SandboxProcessEnvironment.sandboxBaseEnvironment(runnerInfo),
      userId: 1000,
      executablePath: "/opt/pair-runner/build/t3",
    }),
  } satisfies WorkspaceHost;
}).pipe(Effect.provide(WorkspaceHostTesting.layerFromContext));

/** `reads` records every batch the resolver saw, so a test can check one read per process start. */
const layerWith = (settings: Parameters<typeof ServerSettings.layerTest>[0]) => {
  const reads: Array<ReadonlyArray<SecretReference>> = [];
  const layer = SandboxProcessEnvironment.layer.pipe(
    Layer.provide(ServerSettings.layerTest(settings)),
    Layer.provide(
      Layer.succeed(
        SecretResolver.SecretResolver,
        SecretResolver.SecretResolver.of({
          read: (references) =>
            Effect.sync(() => {
              reads.push(references);
              return references.map((reference) =>
                reference.reference === readable.reference ? "s3cret" : undefined,
              );
            }),
          invalidate: () => Effect.void,
        }),
      ),
    ),
    Layer.provide(
      Layer.mock(ProjectionStoreV2)({
        getSandbox: (id) => Effect.succeed(id === sandboxId ? record : null),
      }),
    ),
    // The server's own git identity; the sandbox has none.
    Layer.provide(
      Layer.mock(ProcessRunner.ProcessRunner)({
        run: (input) =>
          Effect.succeed({
            stdout: input.args.includes("user.name") ? "Ada Lovelace\n" : "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(input.args.includes("user.name") ? 0 : 1),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
      }),
    ),
  );
  return { reads, layer };
};

describe("SandboxProcessEnvironment", () => {
  it.effect("layers image < team < project, drops reserved names and never the server env", () => {
    const { reads, layer } = layerWith({
      sandbox: {
        drivers: [],
        env: [
          { name: "SHARED", value: "team", sensitive: false },
          { name: "TEAM_ONLY", value: "team", sensitive: false },
          { name: "IMAGE_TOOL", value: "team", sensitive: false },
          { name: "DB_PASSWORD", value: readable, sensitive: true },
          // Hand-edited past the write refusal: dropped at spawn too.
          { name: "GH_TOKEN", value: "team-gh", sensitive: true },
          { name: "PATH", value: "/evil", sensitive: false },
          { name: "T3CODE_THREAD_ID", value: "spoofed", sensitive: false },
        ],
      },
      projectSettingsOverrides: {
        [projectId]: {
          sandboxEnv: [
            { name: "SHARED", value: "project", sensitive: false },
            { name: "HOME", value: "/evil", sensitive: false },
          ],
        },
        [ProjectId.make("project-b")]: {
          sandboxEnv: [{ name: "OTHER_PROJECT", value: "b", sensitive: false }],
        },
      },
    });
    vi.stubEnv("SANDBOX_TEST_SERVER_ONLY", "server-secret");
    return Effect.gen(function* () {
      const service = yield* SandboxProcessEnvironment.SandboxProcessEnvironment;
      const env = yield* service.forProcess(yield* sandboxHost, "thread-a");

      expect(env).toEqual({
        IMAGE_TOOL: "team",
        PATH: "/opt/pair-runner/build:/usr/local/bin:/usr/bin:/bin",
        HOME: "/home/t3",
        SHELL: "/bin/bash",
        USER: "t3",
        LANG: "C.UTF-8",
        TERM: "xterm-256color",
        SHARED: "project",
        TEAM_ONLY: "team",
        DB_PASSWORD: "s3cret",
        // No user.email on the server: the checkpoint committer's.
        GIT_COMMITTER_NAME: "Ada Lovelace",
        GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
        T3CODE_THREAD_ID: "thread-a",
      });
      expect(Object.values(env)).not.toContain("server-secret");
      expect(reads).toEqual([[readable]]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
  });

  it.effect("fails with the secret provider's message when a reference cannot be read", () => {
    const { layer } = layerWith({
      sandbox: {
        drivers: [],
        env: [
          { name: "DB_PASSWORD", value: readable, sensitive: true },
          { name: "API_TOKEN", value: locked, sensitive: true },
        ],
      },
    });
    return Effect.gen(function* () {
      const service = yield* SandboxProcessEnvironment.SandboxProcessEnvironment;
      const error = yield* service.forProcess(yield* sandboxHost, undefined).pipe(Effect.flip);

      expect(error._tag).toBe("SandboxEnvironmentError");
      expect(error.sandboxId).toBe(sandboxId);
      expect(error.message).toBe(
        'Could not read the credential from the secret provider "vault". Unlock or fix it in Settings, then try again.',
      );
      expect(error.message).not.toContain("s3cret");
    }).pipe(Effect.provide(layer));
  });
});
