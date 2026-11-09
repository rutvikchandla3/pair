import {
  SourceControlProviderKind,
  SourceControlSignInError,
  type SourceControlSignInFailure,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/**
 * The public client ID of the GitHub App the device flow signs in with (no secret).
 * Unset turns the app sign-in off: no app tokens, no sign-in, nothing for clients to show.
 */
export const CLIENT_ID_VARIABLE = "T3CODE_GITHUB_APP_CLIENT_ID";

const KIND = SourceControlProviderKind.make("github");
const REQUEST_TIMEOUT = Duration.seconds(15);
const isOk = (status: number) => status >= 200 && status < 300;

export const GitHubAppSession = Schema.Struct({
  accessToken: Schema.String,
  /** Null when the app hands out tokens that do not expire. */
  accessTokenExpiresAt: Schema.NullOr(Schema.Number),
  refreshToken: Schema.NullOr(Schema.String),
  refreshTokenExpiresAt: Schema.NullOr(Schema.Number),
});
export type GitHubAppSession = typeof GitHubAppSession.Type;

const GitHubAppSessionJson = Schema.fromJsonString(GitHubAppSession);
export const decodeSession = Schema.decodeUnknownOption(GitHubAppSessionJson);
export const encodeSession = Schema.encodeSync(GitHubAppSessionJson);

// GitHub answers both token grants with HTTP 200 and puts refusals in `error`.
const TokenResponse = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  refresh_token: Schema.optional(Schema.String),
  refresh_token_expires_in: Schema.optional(Schema.Number),
  interval: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

const DeviceCodeResponse = Schema.Struct({
  device_code: Schema.optional(Schema.String),
  user_code: Schema.optional(Schema.String),
  verification_uri: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  interval: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

const ViewerResponse = Schema.Struct({ id: Schema.Int, login: Schema.String });

/** The account a token acts as. `id` survives login renames. */
export interface GitHubViewer {
  readonly id: number;
  readonly login: string;
}

export interface DeviceCode {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: number;
  /** Seconds between polls. */
  readonly interval: number;
}

export type RefreshOutcome =
  | { readonly _tag: "refreshed"; readonly session: GitHubAppSession }
  /** Final: the user revoked the app, or the refresh token lapsed. */
  | { readonly _tag: "revoked" };

export class GitHubDeviceFlowError extends Schema.TaggedError<GitHubDeviceFlowError>()(
  "GitHubDeviceFlowError",
  { host: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `GitHub did not answer the request for ${this.host}.`;
  }
}

export const signInError = (host: string, reason: SourceControlSignInFailure, detail: string) =>
  new SourceControlSignInError({ provider: KIND, host, reason, detail });

/** The GitHub App device-flow protocol, without storage: callers keep the sessions it returns. */
export const make = (options: {
  readonly httpClient: HttpClient.HttpClient;
  readonly clientId: string;
}) => {
  const { httpClient, clientId } = options;

  const postForm = <S extends Schema.Top>(
    host: string,
    path: string,
    body: Record<string, string>,
    schema: S,
    accepts: (status: number) => boolean = isOk,
  ) =>
    httpClient
      .execute(
        HttpClientRequest.post(`https://${host}${path}`).pipe(
          HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": "t3code" }),
          HttpClientRequest.bodyUrlParams(body),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatus(accepts)),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        Effect.timeout(REQUEST_TIMEOUT),
      );

  const sessionFrom = (
    now: number,
    response: typeof TokenResponse.Type & { readonly access_token: string },
  ): GitHubAppSession => ({
    accessToken: response.access_token,
    accessTokenExpiresAt:
      response.expires_in === undefined ? null : now + response.expires_in * 1_000,
    refreshToken: response.refresh_token ?? null,
    refreshTokenExpiresAt:
      response.refresh_token_expires_in === undefined
        ? null
        : now + response.refresh_token_expires_in * 1_000,
  });

  const requestCode = Effect.fn("GitHubDeviceFlow.requestCode")(function* (host: string) {
    const code = yield* postForm(
      host,
      "/login/device/code",
      { client_id: clientId },
      DeviceCodeResponse,
      // Unlike the token grants, GitHub refuses a code with a 4xx whose JSON body says why.
      (status) => status < 500,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SourceControlSignInError({
            provider: KIND,
            host,
            reason: "failed",
            detail: "The server could not reach GitHub to start the sign-in.",
            cause,
          }),
      ),
    );
    if (code.error === "device_flow_disabled") {
      return yield* signInError(
        host,
        "failed",
        "This server's GitHub App has Device Flow off. An admin can tick Enable Device Flow in the App's settings on GitHub, then try again.",
      );
    }
    if (
      code.device_code === undefined ||
      code.user_code === undefined ||
      code.verification_uri === undefined ||
      code.expires_in === undefined
    ) {
      return yield* signInError(
        host,
        "failed",
        code.error_description ??
          `GitHub would not start the sign-in (${code.error ?? "no reason given"}).`,
      );
    }
    return {
      deviceCode: code.device_code,
      userCode: code.user_code,
      verificationUri: code.verification_uri,
      expiresAt: (yield* Clock.currentTimeMillis) + code.expires_in * 1_000,
      interval: code.interval ?? 5,
    } satisfies DeviceCode;
  });

  /** Polls until the user approves the code, then returns the new session. */
  const pollForToken = Effect.fn("GitHubDeviceFlow.pollForToken")(function* (
    host: string,
    code: DeviceCode,
  ) {
    let interval = code.interval;
    while (true) {
      yield* Effect.sleep(Duration.seconds(interval));
      const now = yield* Clock.currentTimeMillis;
      if (now >= code.expiresAt) {
        return yield* signInError(host, "expired", "The sign-in code expired. Start again.");
      }
      const answer = yield* postForm(
        host,
        "/login/oauth/access_token",
        {
          client_id: clientId,
          device_code: code.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
        TokenResponse,
      ).pipe(Effect.option);
      // A dropped poll is retried on the next tick; the code stays valid until it expires.
      if (Option.isNone(answer)) continue;
      const response = answer.value;
      if (response.access_token !== undefined) {
        const accessToken = response.access_token;
        return sessionFrom(yield* Clock.currentTimeMillis, {
          ...response,
          access_token: accessToken,
        });
      }
      switch (response.error) {
        case "authorization_pending":
          continue;
        case "slow_down":
          interval = response.interval ?? interval + 5;
          continue;
        case "expired_token":
          return yield* signInError(host, "expired", "The sign-in code expired. Start again.");
        case "access_denied":
          return yield* signInError(host, "denied", "The sign-in was cancelled on GitHub.");
        default:
          return yield* signInError(
            host,
            "failed",
            response.error_description ??
              `GitHub refused the sign-in (${response.error ?? "no reason given"}).`,
          );
      }
    }
  });

  const refresh = Effect.fn("GitHubDeviceFlow.refresh")(function* (
    host: string,
    session: GitHubAppSession,
  ): Effect.fn.Return<RefreshOutcome, GitHubDeviceFlowError> {
    const now = yield* Clock.currentTimeMillis;
    if (
      session.refreshToken === null ||
      (session.refreshTokenExpiresAt !== null && session.refreshTokenExpiresAt <= now)
    ) {
      return { _tag: "revoked" };
    }
    const response = yield* postForm(
      host,
      "/login/oauth/access_token",
      {
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
      },
      TokenResponse,
    ).pipe(Effect.mapError((cause) => new GitHubDeviceFlowError({ host, cause })));
    if (response.error === "bad_refresh_token") {
      yield* Effect.logWarning("GitHub refused the app sign-in refresh.", { host });
      return { _tag: "revoked" };
    }
    if (response.access_token === undefined) {
      return yield* new GitHubDeviceFlowError({
        host,
        cause: new Error(`GitHub did not refresh the sign-in (${response.error ?? "no token"}).`),
      });
    }
    return {
      _tag: "refreshed",
      session: sessionFrom(now, { ...response, access_token: response.access_token }),
    };
  });

  /** The account `token` acts as, or null when GitHub refuses the token. App hosts are github.com. */
  const viewer = Effect.fn("GitHubDeviceFlow.viewer")(
    function* (host: string, token: string) {
      const response = yield* httpClient
        .execute(
          HttpClientRequest.get(`https://api.${host}/user`).pipe(
            HttpClientRequest.setHeaders({
              accept: "application/vnd.github+json",
              authorization: `Bearer ${token}`,
              "user-agent": "t3code",
            }),
          ),
        )
        .pipe(Effect.timeout(REQUEST_TIMEOUT));
      if (response.status === 401) return null;
      const user = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ViewerResponse)),
      );
      return { id: user.id, login: user.login } satisfies GitHubViewer;
    },
    (effect, host) =>
      Effect.mapError(effect, (cause) => new GitHubDeviceFlowError({ host, cause })),
  );

  return { requestCode, pollForToken, refresh, viewer };
};

export type GitHubDeviceFlow = ReturnType<typeof make>;
