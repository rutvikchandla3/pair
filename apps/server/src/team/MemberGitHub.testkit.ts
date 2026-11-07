import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { MemberId } from "@t3tools/contracts";
import { CLIENT_ID_VARIABLE } from "@t3tools/source-control-github/server/deviceFlow";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitHubSignIn from "./GitHubSignIn.ts";
import * as MemberGitHub from "./MemberGitHub.ts";
import * as TeamMembers from "./TeamMembers.ts";

type Reply = { readonly status?: number; readonly body: unknown };

/** A fake GitHub whose answers a test can change between steps, behind the team services. */
export function harness(options: { readonly clientId?: string } = {}) {
  const github = {
    viewer: { id: 42, login: "octocat" },
    userStatus: 200,
    /** The device-flow poll's answer; GitHub answers refusals with 200 and an `error`. */
    token: {
      body: {
        access_token: "ghu_first",
        expires_in: 8 * 3_600,
        refresh_token: "ghr_first",
        refresh_token_expires_in: 4_000 * 3_600,
      },
    } as Reply,
    refresh: { body: {} } as Reply,
    refreshTokens: [] as Array<string | null>,
  };
  const http = HttpClient.make((request) => {
    const url = new URL(request.url);
    const form = new URLSearchParams(
      request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
    );
    const reply: Reply =
      url.pathname === "/login/device/code"
        ? {
            body: {
              device_code: "device-1",
              user_code: "ABCD-1234",
              verification_uri: "https://github.com/login/device",
              expires_in: 900,
              interval: 5,
            },
          }
        : url.pathname === "/login/oauth/access_token" && form.get("grant_type") === "refresh_token"
          ? (github.refreshTokens.push(form.get("refresh_token")), github.refresh)
          : url.pathname === "/login/oauth/access_token"
            ? github.token
            : url.host === "api.github.com" && url.pathname === "/user"
              ? { status: github.userStatus, body: github.viewer }
              : { status: 404, body: {} };
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(reply.body), {
          status: reply.status ?? 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  const secrets = new Map<string, Uint8Array>();
  const secretStore = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
      set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
      create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
      getOrCreateRandom: (name, bytes) =>
        Effect.sync(() => {
          const existing = secrets.get(name);
          if (existing !== undefined) return existing;
          const created = crypto.getRandomValues(new Uint8Array(bytes));
          secrets.set(name, created);
          return created;
        }),
      remove: (name) => Effect.sync(() => void secrets.delete(name)),
    }),
  );
  const gitName = Layer.succeed(ProcessRunner.ProcessRunner, {
    run: () =>
      Effect.succeed({
        stdout: "Ada\n",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  });
  const layer = GitHubSignIn.layer.pipe(
    Layer.provideMerge(MemberGitHub.layer),
    Layer.provideMerge(TeamMembers.layer),
    Layer.provideMerge(
      EnvironmentAuth.layer.pipe(
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provideMerge(secretStore),
        Layer.provide(ServerEnvironment.layerIdentity),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-member-github-test-" })),
      ),
    ),
    Layer.provide(gitName),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(
      Layer.succeed(HostProcess.Environment, {
        [CLIENT_ID_VARIABLE]: options.clientId ?? "Iv-test-client",
      }),
    ),
  );
  const storedToken = (memberId: MemberId) => {
    const bytes = secrets.get(TeamMembers.memberGitHubSecretName(memberId));
    return bytes === undefined ? undefined : JSON.parse(new TextDecoder().decode(bytes));
  };
  const pastedToken = (memberId: MemberId) => {
    const bytes = secrets.get(TeamMembers.memberGitHubTokenSecretName(memberId));
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  };
  return { layer, github, storedToken, pastedToken };
}

export const invite = (name: string, githubLogin?: string) =>
  TeamMembers.TeamMembers.pipe(
    Effect.flatMap((team) =>
      team.invite({ name, role: "member", ...(githubLogin === undefined ? {} : { githubLogin }) }),
    ),
    Effect.map(({ member }) => member.id),
  );
