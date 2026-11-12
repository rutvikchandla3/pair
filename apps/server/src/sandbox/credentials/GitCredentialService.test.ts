import { describe, expect, it } from "@effect/vitest";
import {
  ComputeDriverId,
  MemberId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Sandbox,
  ProjectId,
  type ProjectRoot,
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

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
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
const workspaceThread = ThreadId.make("thread-workspace");
const alice = MemberId.make("member-alice");
const bob = MemberId.make("member-bob");
const projectId = ProjectId.make("project");
const apiProjectId = ProjectId.make("project-api");
/** A workspace thread's repositories: Org/Repo and Org/Api. */
const workspaceRoots: ReadonlyArray<ProjectRoot> = [
  { projectId, name: "repo" },
  { projectId: apiProjectId, name: "api" },
];
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
  [sandboxA, [ownerThread, forkedThread, workspaceThread]],
  [sandboxB, [otherSandboxThread]],
]);
const owners = new Map([
  [ownerThread, alice],
  [forkedThread, bob],
  [otherSandboxThread, alice],
  [workspaceThread, alice],
]);

type AppOutcome = "token" | GitHubAppInstallationError["reason"];

interface Case {
  readonly app: AppOutcome | "unset";
  /** Members with their own GitHub connected, by password. */
  readonly accounts?: ReadonlyMap<MemberId, string>;
  /** The accounts are pasted tokens rather than linked sign-ins. */
  readonly pasted?: boolean;
  readonly threadId?: ThreadId;
  readonly host?: string;
  readonly protocol?: string;
  readonly path?: string;
}

const harness = (input: Case) => {
  const tokenRequests: Array<string> = [];
  const logs: Array<string> = [];
  const forkChecks: Array<{ readonly path: string; readonly bearer: string }> = [];
  const records: Array<OrchestrationV2ServerCommand> = [];
  const app = GitHubAppInstallationTokens.of({
    configured: Effect.succeed(input.app !== "unset"),
    revoke: () => Effect.void,
    readTokenFor: () => Effect.die("pull request reads never ask for a git credential"),
    tokenFor: ({ sandboxId, repository }) => {
      tokenRequests.push(`${sandboxId} ${repository}`);
      return input.app === "token"
        ? Effect.succeed({
            token: Redacted.make(`ghs_${repository}`),
            expiresAt,
            repository,
            permissions: { contents: "write" },
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
        Layer.mock(OrchestratorV2)({
          dispatch: (command) =>
            Effect.sync(() => {
              records.push(command);
              return { sequence: records.length, storedEvents: [] };
            }),
        }),
        Layer.mock(MemberGitHub)({
          enabled: true,
          credentialFor: (memberId) =>
            Effect.succeed(
              Option.fromNullishOr(input.accounts?.get(memberId)).pipe(
                Option.map((token) => ({
                  host: "github.com",
                  token: Redacted.make(token),
                  source: input.pasted === true ? ("token" as const) : ("app" as const),
                })),
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
              ...(threadId === workspaceThread ? { roots: workspaceRoots } : {}),
            } as OrchestrationV2AppThread),
        }),
        Layer.mock(ProjectStoreV2)({
          get: (id) =>
            Effect.succeed(
              id === projectId
                ? Option.some({ projectId, workspaceRoot: "/work/repo" } as ProjectRow)
                : id === apiProjectId
                  ? Option.some({
                      projectId: apiProjectId,
                      workspaceRoot: "/work/api",
                    } as ProjectRow)
                  : Option.none(),
            ),
        }),
        Layer.mock(RepositoryIdentityResolver)({
          resolve: (cwd) => {
            const name = { "/work/repo": "Repo", "/work/api": "Api" }[cwd];
            return Effect.succeed(
              name === undefined
                ? null
                : {
                    canonicalKey: `github.com/org/${name.toLowerCase()}`,
                    locator: {
                      source: "git-remote" as const,
                      remoteName: "origin",
                      remoteUrl: `https://github.com/Org/${name}.git`,
                    },
                  },
            );
          },
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
        : { refused: result.code, message: result.message },
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
  const sourceFor = GitCredentialService.GitCredentialService.pipe(
    Effect.flatMap((service) => service.sourceFor(input.threadId ?? ownerThread)),
    Effect.provide(layer),
  );
  return { answer, sourceFor, tokenRequests, forkChecks, logs, records };
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
    [
      "a workspace thread's first repository",
      { app: "token", threadId: workspaceThread },
      { password: "ghs_org/repo", expires: true },
    ],
    [
      "a workspace thread's second repository",
      { app: "token", threadId: workspaceThread, path: "Org/Api.git" },
      { password: "ghs_org/api", expires: true },
    ],
    [
      "a refusal for a repository outside a workspace thread's",
      { app: "token", threadId: workspaceThread, path: "other/repo.git" },
      {
        refused: "not-this-repository",
        message: "Cloud threads push only to org/repo, org/api and their forks.",
      },
    ],
    [
      "a refusal naming the workspace repository nobody has a credential for",
      { app: "unset", threadId: workspaceThread, path: "Org/Api.git" },
      {
        refused: "github-credential-missing",
        message: "Connect GitHub to push to org/api: Settings → Team, your row.",
      },
    ],
  ])("answers %s", ([_name, input, expected]) =>
    Effect.gen(function* () {
      const { answer, logs } = harness(input);
      expect(yield* answer).toMatchObject(expected as object);
      expect(logs.join("\n")).not.toMatch(/gh[su]_/u);
    }),
  );

  it.effect.each<[string, Case, Option.Option<string>]>([
    ["the App when its key is set", { app: "token" }, Option.some("app-installation")],
    [
      "the owner's account with no App",
      { app: "unset", accounts: aliceOnly },
      Option.some("member-account"),
    ],
    [
      "nothing when only the sandbox's owner has an account",
      { app: "unset", accounts: aliceOnly, threadId: forkedThread },
      Option.none(),
    ],
    ["nothing when nobody has a credential", { app: "unset" }, Option.none()],
  ])("reports %s as the source, without minting", ([_name, input, expected]) =>
    Effect.gen(function* () {
      const { sourceFor, tokenRequests } = harness(input);
      expect(yield* sourceFor).toEqual(expected);
      expect(tokenRequests).toEqual([]);
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

  it.effect("records each answer once per token on the asking thread, without the token", () =>
    Effect.gen(function* () {
      const { answer, records } = harness({ app: "token" });
      yield* answer;
      yield* answer;
      expect(records.map((command) => command.commandId)).toEqual([
        `sandbox-git-credential:${sandboxA}:1:${ownerThread}:org/repo:2026-11-07T13:00:00.000Z`,
        `sandbox-git-credential:${sandboxA}:1:${ownerThread}:org/repo:2026-11-07T13:00:00.000Z`,
      ]);
      expect(records[0]).toMatchObject({
        type: "sandbox.git-credential.record",
        threadId: ownerThread,
        sandboxId: sandboxA,
        source: "app-installation",
        host: "github.com",
        repository: "org/repo",
        permissions: { contents: "write" },
        expiresAt: "2026-11-07T13:00:00.000Z",
      });
      expect(JSON.stringify(records)).not.toContain("ghs_");
    }),
  );

  it.effect.each([
    ["linked account", false, "member-account"],
    ["pasted token", true, "member-token"],
  ] as const)("records the fork owner's %s on the fork's stream", ([_name, pasted, source]) =>
    Effect.gen(function* () {
      const { answer, records } = harness({
        app: "unset",
        accounts: both,
        pasted,
        threadId: forkedThread,
      });
      expect(yield* answer).toEqual({ password: "ghu_bob", expires: false });
      expect(records).toEqual([
        {
          type: "sandbox.git-credential.record",
          commandId: `sandbox-git-credential:${sandboxA}:1:${forkedThread}:org/repo:${source}`,
          threadId: forkedThread,
          sandboxId: sandboxA,
          source,
          host: "github.com",
          repository: "org/repo",
          expiresAt: null,
        },
      ]);
    }),
  );

  it.effect("never asks for a credential for another sandbox's thread", () =>
    Effect.gen(function* () {
      const { answer, tokenRequests, forkChecks, records } = harness({
        app: "token",
        threadId: otherSandboxThread,
      });
      expect(yield* answer).toMatchObject({ refused: "not-this-repository" });
      expect(tokenRequests).toEqual([]);
      expect(forkChecks).toEqual([]);
      expect(records).toEqual([]);
    }),
  );
});
