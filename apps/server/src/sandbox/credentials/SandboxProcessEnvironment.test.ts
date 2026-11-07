import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  ComputeDriverId,
  type OrchestrationV2Sandbox,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
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
const adaToken: SecretReference = { provider: vault, reference: "op://ada/claude" };
const secretValues: Record<string, string> = {
  [readable.reference]: "s3cret",
  [adaToken.reference]: "sk-ant-oat-ada",
};

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
              return references.map((reference) => secretValues[reference.reference]);
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
  describe("forProviderSession", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    const codex = ProviderDriverKind.make("codex");
    const ada = ProviderInstanceId.make("claude_member-ada");
    const sensitive = (name: string, value: string | SecretReference) => ({
      name,
      value,
      sensitive: true,
    });
    const { reads, layer } = layerWith({
      sandbox: {
        drivers: [],
        env: [
          { name: "TEAM_ONLY", value: "team", sensitive: false },
          // Hand-edited past the write refusal: a team entry never acts as an account's credential.
          sensitive("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-team"),
          sensitive("ACCESS_TOKEN", "team-access"),
          { name: "DB_PASSWORD", value: readable, sensitive: true },
        ],
      },
      providerInstances: {
        [ada]: {
          driver: claude,
          environment: [
            sensitive("CLAUDE_CODE_OAUTH_TOKEN", adaToken),
            { name: "HTTPS_PROXY", value: "http://proxy:3128", sensitive: false },
            {
              name: "CLAUDE_CONFIG_DIR",
              value: "/server/state/providers/claude/ada",
              sensitive: false,
            },
            sensitive("ANTHROPIC_API_KEY", "sk-ant-api-ada"),
            sensitive("ANTHROPIC_BASE_URL", "https://gateway.example"),
          ],
        },
        [ProviderInstanceId.make("claude_member-bob")]: {
          driver: claude,
          environment: [sensitive("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-bob")],
        },
        [ProviderInstanceId.make("claude_empty")]: {
          driver: claude,
          environment: [sensitive("CLAUDE_CODE_OAUTH_TOKEN", "")],
        },
        [ProviderInstanceId.make("codex_member-ada")]: {
          driver: codex,
          config: { setupMode: "managed" },
          environment: [
            sensitive("OPENAI_API_KEY", "sk-proj-ada"),
            sensitive("ACCESS_TOKEN", "instance-access"),
            { name: "CODEX_HOME", value: "/server/codex", sensitive: false },
          ],
        },
        [ProviderInstanceId.make("codex_api")]: {
          driver: codex,
          environment: [
            sensitive("OPENAI_API_KEY", "sk-proj-api"),
            { name: "OPENAI_BASE_URL", value: "https://openai.example/v1", sensitive: false },
          ],
        },
      },
    });
    const sessionEnvironment = (instanceId: string, threadId?: string) =>
      Effect.gen(function* () {
        const service = yield* SandboxProcessEnvironment.SandboxProcessEnvironment;
        return yield* service.forProviderSession({
          host: yield* sandboxHost,
          instanceId: ProviderInstanceId.make(instanceId),
          threadId,
        });
      });
    const base = {
      PATH: "/opt/pair-runner/build:/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/t3",
      SHELL: "/bin/bash",
      USER: "t3",
      LANG: "C.UTF-8",
      TERM: "xterm-256color",
      IMAGE_TOOL: "1",
      TEAM_ONLY: "team",
      DB_PASSWORD: "s3cret",
      GIT_COMMITTER_NAME: "Ada Lovelace",
      GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
    };

    it.effect("gives a process its own account's one headless credential and nothing else", () =>
      Effect.gen(function* () {
        reads.length = 0;
        expect(yield* sessionEnvironment(ada, "thread-a")).toEqual({
          ...base,
          ACCESS_TOKEN: "team-access",
          HTTPS_PROXY: "http://proxy:3128",
          CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-ada",
          T3CODE_THREAD_ID: "thread-a",
        });
        // The account's token is read with the team's references, in one batch.
        expect(reads).toEqual([[readable, adaToken]]);

        // Managed Codex: no key, and nothing that would redirect the broker's token.
        expect(yield* sessionEnvironment("codex_member-ada")).toEqual(base);

        expect(yield* sessionEnvironment("codex_api")).toEqual({
          ...base,
          ACCESS_TOKEN: "team-access",
          OPENAI_API_KEY: "sk-proj-api",
          OPENAI_BASE_URL: "https://openai.example/v1",
        });
      }).pipe(Effect.provide(layer)),
    );

    it.effect("refuses an account that signs in on this server only", () =>
      Effect.gen(function* () {
        reads.length = 0;
        const refusal = (instanceId: string) =>
          sessionEnvironment(instanceId, "thread-a").pipe(Effect.flip);

        const login = yield* refusal("claudeAgent");
        expect(login._tag).toBe("ProviderCloudLocalOnlyError");
        expect(login.message).toBe(
          "Claude signs in on this server only. Add a setup token or API key to use it in cloud.",
        );
        expect((yield* refusal("codex")).message).toBe(
          "This Codex account signs in on this server only. Use a managed ChatGPT account or an API key in cloud.",
        );
        // Refused before any secret is read.
        expect(reads).toEqual([]);
        expect((yield* refusal("claude_empty")).message).toBe(
          "CLAUDE_CODE_OAUTH_TOKEN is empty on this account. Set it to use it in cloud.",
        );
        expect((yield* refusal("cursor")).message).toBe(
          "cursor is not supported in cloud yet. Pick Claude or Codex.",
        );
      }).pipe(Effect.provide(layer)),
    );
  });
});
