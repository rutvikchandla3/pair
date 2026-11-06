import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthGitHubSignInError,
  AuthTokenExchangeGrantType,
  AuthEnvironmentBootstrapTokenType,
  AuthAccessTokenType,
  EnvironmentHttpApi,
  MEMBER_SCOPES,
  MemberId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Members from "../persistence/Members.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GitHubSignIn from "../team/GitHubSignIn.ts";
import * as TeamState from "../team/TeamState.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerConfig),
);
const layerGitHubSignIn = Layer.succeed(
  GitHubSignIn.GitHubSignIn,
  GitHubSignIn.GitHubSignIn.of({
    start: () =>
      Effect.succeed({
        attemptId: "attempt",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        expiresAt: 0,
        interval: 5,
      }),
    poll: () =>
      Effect.fail(
        new AuthGitHubSignInError({ reason: "not-a-member", message: "Not on the team." }),
      ),
  }),
);
const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(AuthHttp.layer),
  Layer.provide(layerGitHubSignIn),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provideMerge(layerEnvironmentAuth),
  Layer.provide(layerConfig),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
  get: () => Effect.succeedNone,
  set: () => Effect.void,
  create: () => Effect.void,
  getOrCreateRandom: () => Effect.die("Not used by these routes."),
  remove: () => Effect.void,
});
const makeRequestContext = (random: SecureRandom.SecureRandom["Service"]) =>
  Context.make(SecureRandom.SecureRandom, random).pipe(
    Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
  );

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const requestContext = makeRequestContext(yield* SecureRandom.SecureRandom);
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.promise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);

          // GitHub sign-in is how a signed-out browser gets in, and its answer carries a credential.
          const githubStart = await environmentA.handler(
            postJson("/api/auth/github/start", {}),
            requestContext,
          );
          expect(githubStart.status).toBe(200);
          expect(await githubStart.json()).toMatchObject({ userCode: "ABCD-1234" });
          const githubPoll = await environmentA.handler(
            postJson("/api/auth/github/poll", { attemptId: "attempt" }),
            requestContext,
          );
          expect(githubPoll.status).toBe(400);
          expect(await githubPoll.json()).toMatchObject({ reason: "not-a-member" });
          for (const response of [githubStart, githubPoll]) {
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(response.headers.get("pragma")).toBe("no-cache");
          }
          const retiredScopeResponse = await environmentA.handler(
            new Request("http://127.0.0.1/oauth/token", {
              method: "POST",
              body: new URLSearchParams({
                grant_type: AuthTokenExchangeGrantType,
                subject_token: DEV_TOKEN,
                subject_token_type: AuthEnvironmentBootstrapTokenType,
                requested_token_type: AuthAccessTokenType,
                scope: "review:write",
              }),
            }),
            requestContext,
          );
          expect(retiredScopeResponse.status).toBe(400);
          expect(await retiredScopeResponse.json()).toMatchObject({ reason: "invalid_scope" });

          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

interface TeamServices {
  readonly auth: EnvironmentAuth.EnvironmentAuth["Service"];
  readonly members: Members.MemberRepository["Service"];
  readonly teamState: TeamState.TeamState["Service"];
}

// The handler runs on the wall clock, so sessions issued beside it must too.
it.live("limits access management without access:write to the caller's own member", () =>
  Effect.gen(function* () {
    const requestContext = makeRequestContext(yield* SecureRandom.SecureRandom);
    let services: TeamServices | undefined;
    const layerTeamRoutes = Layer.effectDiscard(
      Effect.all({
        auth: EnvironmentAuth.EnvironmentAuth,
        members: Members.MemberRepository,
        teamState: TeamState.TeamState,
      }).pipe(Effect.tap((captured) => Effect.sync(() => (services = captured)))),
    ).pipe(Layer.provideMerge(layerRoutes));
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerTeamRoutes, { disableLogger: true })),
      (web) =>
        Effect.gen(function* () {
          const call = (path: string, token: string, body: unknown = {}) =>
            Effect.promise(() =>
              web.handler(
                postJson(path, body, { authorization: `Bearer ${token}` }),
                requestContext,
              ),
            );
          const warmup = yield* Effect.promise(() =>
            web.handler(new Request("http://127.0.0.1/api/auth/session"), requestContext),
          );
          expect(warmup.status).toBe(200);
          const { auth, members, teamState } = services!;
          const addMember = (name: string) =>
            Effect.gen(function* () {
              const id = MemberId.make(`member-${name}`);
              yield* members.insert({
                id,
                name,
                role: "member",
                gitName: null,
                gitEmail: null,
                createdAt: "2026-09-01T00:00:00.000Z",
              });
              yield* teamState.reload;
              return id;
            });
          const alice = yield* addMember("alice");
          const bob = yield* addMember("bob");
          const memberSession = (memberId: MemberId) =>
            auth.issueSession({ memberId, scopes: MEMBER_SCOPES });
          const owner = yield* auth.issueSession();
          const aliceDevice = yield* memberSession(alice);
          const aliceOther = yield* memberSession(alice);
          const bobDevice = yield* memberSession(bob);

          const added = yield* call("/api/auth/pairing-token", aliceDevice.token);
          expect(added.status).toBe(200);
          const { id: linkId } = (yield* Effect.promise(() => added.json())) as { id: string };
          const link = (yield* auth.listPairingLinks()).find(
            (candidate) => candidate.id === linkId,
          );
          expect(link?.memberId).toBe(alice);
          expect(new Set(link?.permissions)).toEqual(new Set(MEMBER_SCOPES));
          expect(
            (yield* call("/api/auth/pairing-token", aliceDevice.token, {
              scopes: ["settings:write"],
            })).status,
          ).toBe(403);

          expect(
            (yield* call("/api/auth/clients/revoke", aliceDevice.token, {
              sessionId: bobDevice.sessionId,
            })).status,
          ).toBe(403);
          const ownRevoke = yield* call("/api/auth/clients/revoke", aliceDevice.token, {
            sessionId: aliceOther.sessionId,
          });
          expect(yield* Effect.promise(() => ownRevoke.json())).toEqual({ revoked: true });

          const aliceThird = yield* memberSession(alice);
          const others = yield* call("/api/auth/clients/revoke-others", aliceDevice.token);
          expect(yield* Effect.promise(() => others.json())).toEqual({ revokedCount: 1 });
          const active = new Set((yield* auth.listSessions()).map((session) => session.sessionId));
          expect(active.has(aliceThird.sessionId)).toBe(false);
          for (const spared of [owner, aliceDevice, bobDevice]) {
            expect(active.has(spared.sessionId)).toBe(true);
          }

          const tokenResponse = yield* call("/api/auth/api-token", bobDevice.token, {
            label: "CI",
            access: "auto",
            expiresInDays: 365,
          });
          expect(tokenResponse.status).toBe(200);
          expect(tokenResponse.headers.get("cache-control")).toBe("no-store");
          const apiToken = (yield* Effect.promise(() => tokenResponse.json())) as {
            sessionId: string;
            token: string;
          };
          const bobClients = yield* auth.listClientSessions(bobDevice.sessionId, bob);
          const listed = bobClients.find((client) => client.sessionId === apiToken.sessionId);
          expect(listed).toMatchObject({ memberId: bob, subject: "mcp-client" });
          expect(listed!.client).toMatchObject({ label: "CI", deviceType: "bot" });
          expect(listed!.expiresAt.epochMilliseconds - listed!.issuedAt.epochMilliseconds).toBe(
            365 * 24 * 60 * 60 * 1000,
          );
          expect(
            (yield* call("/api/auth/api-token", bobDevice.token, {
              label: "Admin",
              access: "full-access",
            })).status,
          ).toBe(403);
          expect(
            (yield* call("/api/auth/api-token", apiToken.token, { label: "Again", access: "auto" }))
              .status,
          ).toBe(401);

          const mcpRequest = HttpServerRequest.fromWeb(
            new Request("http://127.0.0.1/mcp", {
              headers: { authorization: `Bearer ${apiToken.token}` },
            }),
          );
          expect((yield* auth.authenticateMcpClient(mcpRequest)).memberId).toBe(bob);
          const tokenRevoke = yield* call("/api/auth/clients/revoke", bobDevice.token, {
            sessionId: apiToken.sessionId,
          });
          expect(yield* Effect.promise(() => tokenRevoke.json())).toEqual({ revoked: true });
          expect(yield* Effect.exit(auth.authenticateMcpClient(mcpRequest))).toMatchObject({
            _tag: "Failure",
          });
        }),
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
