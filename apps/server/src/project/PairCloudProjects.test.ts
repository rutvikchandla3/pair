import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import {
  MemberId,
  type OrchestrationProjectShell,
  type ProjectCloneStartInput,
  ProjectId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import {
  GitHubAppInstallationError,
  GitHubAppInstallationTokens,
} from "../sandbox/credentials/GitHubAppInstallationTokens.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { MemberGitHub } from "../team/MemberGitHub.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as PairCloudProjects from "./PairCloudProjects.ts";
import type { ProjectCloneHooks } from "./ProjectCloneTracker.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const CHECKOUTS = "/state/checkouts";
const MEMBER = MemberId.make("member-alice");
const projectId = ProjectId.make("project-app");
const input: ProjectCloneStartInput = {
  projectId,
  title: "app",
  createdAt: "2026-11-09T00:00:00.000Z",
  remoteUrl: "https://github.com/acme/app",
  destinationPath: "/home/alice/anywhere",
};

const header = (token: string) =>
  `Authorization: Basic ${Base64.encode(`x-access-token:${token}`)}`;

function makeHarness(options: {
  readonly app?: string;
  readonly member?: string;
  readonly status?: number;
  readonly shells?: ReadonlyArray<OrchestrationProjectShell>;
}) {
  const started: Array<{ input: ProjectCloneStartInput; hooks: ProjectCloneHooks }> = [];
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  const gitCalls: Array<GitVcsDriver.ExecuteGitInput> = [];
  const layer = PairCloudProjects.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ServerConfig.ServerConfig, {
          cloudOnly: true,
          checkoutsDir: CHECKOUTS,
        } as ServerConfig.ServerConfig["Service"]),
        NodePath.layer,
        Layer.succeed(HostProcess.Environment, {}),
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({
          get: () => Effect.succeed(null),
          start: (startInput, hooks) =>
            Effect.sync(() => {
              started.push({ input: startInput, hooks });
              return {
                projectId: startInput.projectId,
                cwd: startInput.destinationPath ?? "",
                remoteUrl: startInput.remoteUrl ?? "",
                repository: hooks.repository ?? null,
              };
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          listShells: () => Effect.succeed(options.shells ?? []),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
        Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({}),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
        Layer.mock(MemberGitHub)({
          enabled: true,
          credentialFor: () =>
            Effect.succeed(
              options.member === undefined
                ? Option.none()
                : Option.some({
                    host: "github.com",
                    token: Redacted.make(options.member),
                    source: "token" as const,
                  }),
            ),
        }),
        Layer.mock(GitHubAppInstallationTokens)({
          readTokenFor: ({ repository }) =>
            options.app === undefined
              ? Effect.fail(
                  new GitHubAppInstallationError({
                    repository,
                    reason: "not-installed",
                    detail: "test",
                  }),
                )
              : Effect.succeed({
                  token: Redacted.make(options.app),
                  expiresAt: DateTime.makeUnsafe("2026-11-09T01:00:00.000Z"),
                  repository,
                  permissions: { contents: "read" },
                }),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          readRemoteUrl: () => Effect.succeed("https://github.com/acme/app.git"),
          execute: (call) =>
            Effect.sync(() => {
              gitCalls.push(call);
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              requests.push({ url: request.url, authorization: request.headers["authorization"] });
              return HttpClientResponse.fromWeb(
                request,
                new Response("{}", { status: options.status ?? 200 }),
              );
            }),
          ),
        ),
      ),
    ),
  );
  return { layer, started, requests, gitCalls };
}

const shellFor = (remoteUrl: string): OrchestrationProjectShell => ({
  id: ProjectId.make("project-existing"),
  title: "app",
  workspaceRoot: `${CHECKOUTS}/project-existing`,
  repositoryIdentity: {
    canonicalKey: sourceControlDefinitions.repositoryKeyFromRemote(remoteUrl),
    locator: { source: "git-remote", remoteName: "origin", remoteUrl },
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

describe("PairCloudProjects", () => {
  it.effect.each([
    { name: "an ssh URL", remoteUrl: "git@github.com:acme/app.git", reason: "unsupported-remote" },
    {
      name: "another host",
      remoteUrl: "https://gitlab.com/acme/app",
      reason: "unsupported-remote",
    },
    {
      name: "a URL with credentials",
      remoteUrl: "https://x:y@github.com/acme/app",
      reason: "unsupported-remote",
    },
    {
      name: "a repository already on Pair Cloud",
      shells: [shellFor("git@github.com:Acme/app.git")],
      reason: "already-added",
    },
    {
      name: "a repository the member can't read",
      member: "ghp_member",
      status: 404,
      reason: "no-access",
    },
    { name: "a private repository without GitHub", status: 404, reason: "github-not-connected" },
  ] as const)("refuses adding $name before any git runs", (row) => {
    const harness = makeHarness({
      ...("member" in row ? { member: row.member } : {}),
      ...("status" in row ? { status: row.status } : {}),
      ...("shells" in row ? { shells: row.shells } : {}),
    });
    return Effect.gen(function* () {
      const projects = yield* PairCloudProjects.PairCloudProjects;
      const error = yield* projects
        .add(
          { ...input, ...("remoteUrl" in row ? { remoteUrl: row.remoteUrl } : {}) },
          {
            memberId: MEMBER,
          },
        )
        .pipe(Effect.flip);
      assert.equal(error._tag === "PairCloudProjectError" ? error.reason : error._tag, row.reason);
      assert.deepStrictEqual(harness.started, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("fails closed when GitHub can't be asked", () => {
    const harness = makeHarness({ status: 502 });
    return Effect.gen(function* () {
      const projects = yield* PairCloudProjects.PairCloudProjects;
      const error = yield* projects.add(input, { memberId: null }).pipe(Effect.flip);
      assert.equal(error._tag, "SourceControlRepositoryError");
      assert.deepStrictEqual(harness.started, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("clones under the checkouts folder with the App token and hardened config", () => {
    const harness = makeHarness({ app: "ghs_app", member: "ghp_member" });
    return Effect.gen(function* () {
      const projects = yield* PairCloudProjects.PairCloudProjects;
      yield* projects.add(input, { memberId: MEMBER });

      assert.deepStrictEqual(harness.requests, [
        { url: "https://api.github.com/repos/acme/app", authorization: "Bearer ghp_member" },
      ]);
      const [start] = harness.started;
      assert.deepStrictEqual(start?.input, {
        projectId,
        title: "app",
        createdAt: input.createdAt,
        provider: SourceControlProviderKind.make("github"),
        remoteUrl: "https://github.com/acme/app.git",
        destinationPath: `${CHECKOUTS}/${projectId}`,
        protocol: "https",
      });
      const options = yield* start!.hooks.cloneOptions!;
      assert.deepStrictEqual(options.config, PairCloudProjects.HARDENED_CHECKOUT_CONFIG);
      assert.deepStrictEqual(options.env, {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
        GIT_CONFIG_VALUE_0: header("ghs_app"),
      });

      // A launch fetches the same checkout with the same credential, and nothing else.
      yield* projects.fetchCheckout({
        projectId,
        workspaceRoot: `${CHECKOUTS}/${projectId}`,
        memberId: MEMBER,
      });
      yield* projects.fetchCheckout({ projectId, workspaceRoot: "/work/app", memberId: MEMBER });
      assert.deepStrictEqual(
        harness.gitCalls.map((call) => [call.cwd, call.args, call.env?.["GIT_CONFIG_VALUE_0"]]),
        [[`${CHECKOUTS}/${projectId}`, ["fetch", "--prune", "origin"], header("ghs_app")]],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("falls back to the member's GitHub where the App isn't installed", () =>
    Effect.gen(function* () {
      const member = makeHarness({ member: "ghp_member" });
      const env = yield* Effect.gen(function* () {
        const projects = yield* PairCloudProjects.PairCloudProjects;
        return yield* projects.gitEnvFor({ repository: "acme/app", memberId: MEMBER });
      }).pipe(Effect.provide(member.layer));
      assert.equal(env["GIT_CONFIG_VALUE_0"], header("ghp_member"));

      const neither = makeHarness({});
      const publicEnv = yield* Effect.gen(function* () {
        const projects = yield* PairCloudProjects.PairCloudProjects;
        yield* projects.add(input, { memberId: null });
        return yield* neither.started[0]!.hooks.cloneOptions!;
      }).pipe(Effect.provide(neither.layer));
      assert.deepStrictEqual(neither.requests, [
        { url: "https://api.github.com/repos/acme/app", authorization: undefined },
      ]);
      assert.notProperty(publicEnv.env, "GIT_CONFIG_COUNT");
    }),
  );
});
