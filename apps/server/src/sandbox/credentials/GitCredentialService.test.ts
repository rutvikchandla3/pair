import { describe, expect, it } from "@effect/vitest";
import {
  ComputeDriverId,
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
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import { HttpClient, HttpClientResponse } from "effect/http";

import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { type ProjectRow, ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import { RepositoryIdentityResolver } from "../../project/RepositoryIdentityResolver.ts";
import { MemberGitHub } from "../../team/MemberGitHub.ts";
import * as GitCredentialService from "./GitCredentialService.ts";
import {
  GitHubAppInstallationError,
  GitHubAppInstallationTokens,
} from "./GitHubAppInstallationTokens.ts";

const sandboxA = SandboxId.make("sbx_000000000000000a1281");
const sandboxB = SandboxId.make("sbx_000000000000000b1281");
const ownerThread = ThreadId.make("thread-owner");
const forkedThread = ThreadId.make("thread-fork-by-bob");
const otherSandboxThread = ThreadId.make("thread-of-b");
const alice = MemberId.make("member-alice");
const bob = MemberId.make("member-bob");
const projectId = ProjectId.make("project");
const expiresAt = DateTime.makeUnsafe("2026-11-07T13:00:00.000Z");

const sandbox = (id: SandboxId, ownerThreadId: ThreadId): OrchestrationV2Sandbox => ({
  id,
  projectId,
  ownerThreadId,
  ownerMemberId: alice,
  driverId: ComputeDriverId.make("docker"),
  size: "default",
  state: "ready",
  generation: 1,
  driverRef: "ref",
  admission: null,
  runnerLostAt: null,
  sleepReason: null,
  failure: null,
  createdAt: expiresAt,
  updatedAt: expiresAt,
});

/** Sandbox A runs alice's thread and bob's fork of it; sandbox B runs a thread of its own. */
const threadsBySandbox = new Map([
  [sandboxA, [ownerThread, forkedThread]],
  [sandboxB, [otherSandboxThread]],
]);
const owners = new Map([
  [ownerThread, alice],
  [forkedThread, bob],
  [otherSandboxThread, alice],
]);

type AppOutcome = "token" | GitHubAppInstallationError["reason"];

interface Case {
  readonly app: AppOutcome | "unset";
  /** Members with their own GitHub connected, by password. */
  readonly accounts?: ReadonlyMap<MemberId, string>;
  readonly threadId?: ThreadId;
  readonly host?: string;
  readonly protocol?: string;
  readonly path?: string;
}

const harness = (input: Case) => {
  const tokenRequests: Array<string> = [];
  const logs: Array<string> = [];
  const forkChecks: Array<{ readonly path: string; readonly bearer: string }> = [];
  const app = GitHubAppInstallationTokens.of({
    configured: Effect.succeed(input.app !== "unset"),
    tokenFor: ({ sandboxId, repository }) => {
      tokenRequests.push(`${sandboxId} ${repository}`);
      return input.app === "token"
        ? Effect.succeed({
            token: Redacted.make(`ghs_${repository}`),
            expiresAt,
            repository,
          })
        : Effect.fail(
            new GitHubAppInstallationError({
              repository,
              reason: input.app === "unset" ? "not-configured" : input.app,
              detail: "test",
            }),
          );
    },
  });
  const http = HttpClient.make((request) => {
    const path = new URL(request.url).pathname;
    forkChecks.push({ path, bearer: request.headers["authorization"] ?? "" });
    const parents: Record<string, string> = {
      "/repos/alice/repo": "Org/Repo",
      "/repos/mallory/repo": "someone/else",
    };
    const parent = parents[path];
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(parent ? { parent: { full_name: parent } } : {}), {
          status: parent ? 200 : 404,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });
  const layer = GitCredentialService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(GitHubAppInstallationTokens, app),
        Layer.succeed(HttpClient.HttpClient, http),
        Layer.mock(MemberGitHub)({
          enabled: true,
          credentialFor: (memberId) =>
            Effect.succeed(
              Option.fromNullishOr(input.accounts?.get(memberId)).pipe(
                Option.map((token) => ({ host: "github.com", token: Redacted.make(token) })),
              ),
            ),
        }),
        Layer.mock(ProjectionStoreV2)({
          getSandbox: (id) =>
            Effect.succeed(
              id === sandboxA
                ? sandbox(sandboxA, ownerThread)
                : id === sandboxB
                  ? sandbox(sandboxB, otherSandboxThread)
                  : null,
            ),
          listSandboxThreads: (id) =>
            Effect.succeed(
              (threadsBySandbox.get(id) ?? []).map((threadId) => ({
                threadId,
                attachedAt: expiresAt,
                archived: false,
              })),
            ),
          getThread: (threadId) =>
            Effect.succeed({
              id: threadId,
              ownerId: owners.get(threadId),
            } as OrchestrationV2AppThread),
        }),
        Layer.mock(ProjectStoreV2)({
          get: (id) =>
            Effect.succeed(
              id === projectId
                ? Option.some({ projectId, workspaceRoot: "/work/repo" } as ProjectRow)
                : Option.none(),
            ),
        }),
        Layer.mock(RepositoryIdentityResolver)({
          resolve: (cwd) =>
            Effect.succeed(
              cwd === "/work/repo"
                ? {
                    canonicalKey: "github.com/org/repo",
                    locator: {
                      source: "git-remote" as const,
                      remoteName: "origin",
                      remoteUrl: "https://github.com/Org/Repo.git",
                    },
                  }
                : null,
            ),
        }),
      ),
    ),
  );
  const answer = GitCredentialService.GitCredentialService.pipe(
    Effect.flatMap((service) =>
      service.answer({
        sandboxId: sandboxA,
        threadId: input.threadId,
        protocol: input.protocol ?? "https",
        host: input.host ?? "github.com",
        path: input.path ?? "Org/Repo.git",
      }),
    ),
    Effect.map((result) =>
      result._tag === "Credential"
        ? {
            password: Redacted.value(result.password),
            expires: result.expiresAt !== null,
          }
        : { refused: result.code },
    ),
    Effect.provide(
      layer.pipe(
        Layer.provideMerge(
          Logger.layer(
            [
              Logger.make(
                ({ message, cause }) => void logs.push(JSON.stringify(message), String(cause)),
              ),
            ],
            { mergeWithExisting: false },
          ),
        ),
        Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Trace")),
      ),
    ),
  );
  return { answer, tokenRequests, forkChecks, logs };
};

const aliceOnly = new Map([[alice, "ghu_alice"]]);
const both = new Map([
  [alice, "ghu_alice"],
  [bob, "ghu_bob"],
]);

describe("GitCredentialService", () => {
  it.effect.each<[string, Case, unknown]>([
    ["the App's token", { app: "token" }, { password: "ghs_org/repo", expires: true }],
    [
      "the owner's account when the App is not installed",
      { app: "not-installed", accounts: aliceOnly },
      { password: "ghu_alice", expires: false },
    ],
    [
      "the owner's account when GitHub rejects the App key",
      { app: "key-rejected", accounts: aliceOnly },
      { password: "ghu_alice", expires: false },
    ],
    [
      "the owner's account with no App",
      { app: "unset", accounts: aliceOnly },
      { password: "ghu_alice", expires: false },
    ],
    [
      "the asking thread's owner, not the sandbox's",
      { app: "unset", accounts: both, threadId: forkedThread },
      { password: "ghu_bob", expires: false },
    ],
    [
      "a refusal when nobody has a credential",
      { app: "unset", accounts: new Map([[bob, "ghu_bob"]]) },
      { refused: "github-credential-missing" },
    ],
    [
      "a refusal for a thread of another sandbox",
      { app: "token", accounts: both, threadId: otherSandboxThread },
      { refused: "not-this-repository" },
    ],
    [
      "a refusal for a thread that does not exist",
      { app: "token", threadId: ThreadId.make("thread-unknown") },
      { refused: "not-this-repository" },
    ],
    [
      "a refusal for another repository",
      { app: "token", accounts: both, path: "other/repo.git" },
      { refused: "not-this-repository" },
    ],
    [
      "a refusal without a repository path",
      { app: "token", path: "" },
      { refused: "not-this-repository" },
    ],
    [
      "a fork of the project",
      { app: "not-installed", accounts: aliceOnly, path: "alice/repo.git" },
      { password: "ghu_alice", expires: false },
    ],
    [
      "a refusal for a fork of something else",
      { app: "token", path: "mallory/repo.git" },
      { refused: "not-this-repository" },
    ],
    [
      "a refusal for gitlab.com",
      { app: "token", host: "gitlab.com" },
      { refused: "unsupported-host" },
    ],
    [
      "a refusal for plain http",
      { app: "token", protocol: "http" },
      { refused: "unsupported-host" },
    ],
  ])("answers %s", ([_name, input, expected]) =>
    Effect.gen(function* () {
      const { answer, logs } = harness(input);
      expect(yield* answer).toEqual(expected);
      expect(logs.join("\n")).not.toMatch(/gh[su]_/u);
    }),
  );

  it.effect("checks a fork with the project's credential and mints only for the fork", () =>
    Effect.gen(function* () {
      const { answer, tokenRequests, forkChecks, logs } = harness({
        app: "token",
        path: "alice/repo",
      });
      expect(yield* answer).toEqual({ password: "ghs_alice/repo", expires: true });
      // The log names the source that answered, never the token.
      expect(logs.join("\n")).toContain('"source":"app-installation"');
      expect(logs.join("\n")).not.toContain("ghs_");
      expect(forkChecks).toEqual([{ path: "/repos/alice/repo", bearer: "Bearer ghs_org/repo" }]);
      expect(tokenRequests).toEqual([`${sandboxA} org/repo`, `${sandboxA} alice/repo`]);
    }),
  );

  it.effect("never asks for a credential for another sandbox's thread", () =>
    Effect.gen(function* () {
      const { answer, tokenRequests, forkChecks } = harness({
        app: "token",
        threadId: otherSandboxThread,
      });
      expect(yield* answer).toEqual({ refused: "not-this-repository" });
      expect(tokenRequests).toEqual([]);
      expect(forkChecks).toEqual([]);
    }),
  );
});
