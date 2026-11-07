import { describe, expect, it } from "@effect/vitest";
import {
  ComputeDriverId,
  type GitManagerError,
  MemberId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Sandbox,
  ProjectId,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { type ProjectRow, ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import { RepositoryIdentityResolver } from "../../project/RepositoryIdentityResolver.ts";
import { MemberGitHub } from "../../team/MemberGitHub.ts";
import { GitHubAppInstallationTokens } from "./GitHubAppInstallationTokens.ts";
import * as SandboxGitHooks from "./SandboxGitHooks.ts";

const sandboxId = SandboxId.make("sbx_000000000000000a1350");
const ownerThread = ThreadId.make("thread-owner");
const forkedThread = ThreadId.make("thread-fork");
const projectId = ProjectId.make("project");
const at = DateTime.makeUnsafe("2026-11-07T12:00:00.000Z");
const ownerCheckout = `/t3-sandbox/${sandboxId}/repo`;
const forkCheckout = `/t3-sandbox/${sandboxId}/worktrees/fork`;

const sandbox: OrchestrationV2Sandbox = {
  id: sandboxId,
  projectId,
  ownerThreadId: ownerThread,
  ownerMemberId: MemberId.make("member-alice"),
  driverId: ComputeDriverId.make("docker"),
  size: "default",
  state: "ready",
  generation: 1,
  driverRef: "ref",
  admission: null,
  runnerLostAt: null,
  sleepReason: null,
  failure: null,
  createdAt: at,
  updatedAt: at,
};
const worktrees = new Map([
  [ownerThread, ownerCheckout],
  [forkedThread, forkCheckout],
]);

interface Case {
  /** Threads whose owner has their own GitHub. */
  readonly credentialFor?: ReadonlyArray<ThreadId>;
  readonly remote?: string;
}

const harness = (input: Case) => {
  const reads: Array<string> = [];
  const asked: Array<ThreadId> = [];
  const layer = SandboxGitHooks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GitHubAppInstallationTokens)({ configured: Effect.succeed(false) }),
        Layer.mock(MemberGitHub)({
          enabled: true,
          credentialFor: (memberId) =>
            Effect.sync(() => {
              const threadId = ThreadId.make(memberId.replace(/^owner-of-/u, ""));
              asked.push(threadId);
              return input.credentialFor?.includes(threadId)
                ? Option.some({
                    host: "github.com",
                    token: Redacted.make("ghu_owner"),
                    source: "app" as const,
                  })
                : Option.none();
            }),
        }),
        Layer.mock(ProjectionStoreV2)({
          getSandbox: (id) =>
            Effect.sync(() => {
              reads.push(`sandbox ${id}`);
              return id === sandboxId ? sandbox : null;
            }),
          listSandboxThreads: () =>
            Effect.succeed(
              [...worktrees.keys()].map((threadId) => ({
                threadId,
                attachedAt: at,
                archived: false,
              })),
            ),
          getThread: (threadId) =>
            Effect.succeed({
              id: threadId,
              ownerId: MemberId.make(`owner-of-${threadId}`),
              worktreePath: worktrees.get(threadId) ?? null,
            } as OrchestrationV2AppThread),
        }),
        Layer.mock(ProjectStoreV2)({
          get: () => Effect.succeedSome({ projectId, workspaceRoot: "/work" } as ProjectRow),
        }),
        Layer.mock(RepositoryIdentityResolver)({
          resolve: () =>
            Effect.succeed({
              canonicalKey: input.remote ?? "github.com/org/repo",
              locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: "x" },
            }),
        }),
      ),
    ),
  );
  const preparePush = (cwd: string, threadId?: ThreadId) =>
    SandboxGitHooks.SandboxGitHooks.pipe(
      Effect.flatMap((hooks) => hooks.preparePush({ cwd, threadId })),
      Effect.provide(layer),
    );
  return { preparePush, reads, asked };
};

const codeOf = (error: GitManagerError) => ({ code: error.code, detail: error.detail });

describe("SandboxGitHooks", () => {
  it.effect("pushes from a local checkout with no env and no projection read", () =>
    Effect.gen(function* () {
      const { preparePush, reads, asked } = harness({});
      expect(yield* preparePush("/home/alice/repo", ownerThread)).toEqual({});
      expect(reads).toEqual([]);
      expect(asked).toEqual([]);
    }),
  );

  it.effect("names the asking thread so the helper answers with its owner's credential", () =>
    Effect.gen(function* () {
      const { preparePush, asked } = harness({ credentialFor: [forkedThread] });
      expect(yield* preparePush(forkCheckout, forkedThread)).toEqual({
        T3CODE_THREAD_ID: forkedThread,
      });
      expect(asked).toEqual([forkedThread]);
    }),
  );

  it.effect("finds the thread from its checkout when the caller names none", () =>
    Effect.gen(function* () {
      const { preparePush } = harness({ credentialFor: [forkedThread] });
      expect(yield* preparePush(forkCheckout)).toEqual({ T3CODE_THREAD_ID: forkedThread });
    }),
  );

  it.effect("refuses before git runs when the thread has no credential", () =>
    Effect.gen(function* () {
      const { preparePush } = harness({ credentialFor: [ownerThread] });
      const error = yield* preparePush(forkCheckout, forkedThread).pipe(Effect.flip);
      expect(codeOf(error)).toEqual({
        code: "github-credential-missing",
        detail: "Connect GitHub to push: Settings → Team, your row.",
      });
    }),
  );

  it.effect("refuses a project hosted outside GitHub, whatever the credential", () =>
    Effect.gen(function* () {
      const { preparePush, asked } = harness({
        credentialFor: [ownerThread],
        remote: "gitlab.com/org/repo",
      });
      const error = yield* preparePush(ownerCheckout, ownerThread).pipe(Effect.flip);
      expect(codeOf(error)).toEqual({
        code: "cloud-push-unsupported-host",
        detail: "Pushing from cloud supports GitHub until a later release.",
      });
      expect(asked).toEqual([]);
    }),
  );
});
