// @effect-diagnostics nodeBuiltinImport:off -- node:crypto converts GitHub's PKCS#1 key to the PKCS#8 that Jwk imports.
import * as NodeCrypto from "node:crypto";

import { isSecretReference, type SandboxId, settingsSecretLiteral } from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as GitHubDefinition from "@t3tools/source-control-github/shared/definition";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Jwk from "effect/jose/Jwk";
import * as Jwt from "effect/jose/Jwt";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

const API = "https://api.github.com";
const REQUEST_TIMEOUT = Duration.seconds(15);
/** A cached token is handed out only while it has at least this long left. */
const REFRESH_MARGIN = Duration.minutes(5);
/** Never `workflows`: an agent must not rewrite CI (06 §5). */
const INSTALLATION_TOKEN_PERMISSIONS = {
  contents: "write",
  metadata: "read",
  pull_requests: "write",
} as const;

export class GitHubAppInstallationError extends Schema.TaggedError<GitHubAppInstallationError>()(
  "GitHubAppInstallationError",
  {
    repository: Schema.String,
    reason: Schema.Literals(["not-configured", "not-installed", "key-rejected", "failed"]),
    /** Never a response body or request: those carry tokens. */
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `The GitHub App gave no token for ${this.repository} (${this.reason}): ${this.detail}`;
  }
}

export interface InstallationToken {
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: DateTime.Utc;
  /** `owner/name`, lower case. */
  readonly repository: string;
}

export class GitHubAppInstallationTokens extends Context.Service<
  GitHubAppInstallationTokens,
  {
    /** False when the App ID or key is unset; callers skip to the owner's credential. */
    readonly configured: Effect.Effect<boolean>;
    /** One-repository token, cached per (sandbox, repository) until 5 minutes before expiry. */
    readonly tokenFor: (input: {
      readonly sandboxId: SandboxId;
      readonly repository: string;
    }) => Effect.Effect<InstallationToken, GitHubAppInstallationError>;
  }
>()("t3/sandbox/credentials/GitHubAppInstallationTokens") {}

const AppClaims = Schema.Struct({ iat: Schema.Number, exp: Schema.Number, iss: Schema.String });
const InstallationResponse = Schema.Struct({ id: Schema.Number });
const AccessTokenResponse = Schema.Struct({ token: Schema.String, expires_at: Schema.String });

const FLATTENED_PEM = /^(-----BEGIN [A-Z ]+-----)\s*([\s\S]*?)\s*(-----END [A-Z ]+-----)$/u;

/** A password field drops a pasted PEM's line breaks, as web's `restorePemLineBreaks` restores. */
const restorePemLineBreaks = (pasted: string) => {
  const trimmed = pasted.trim();
  const match = FLATTENED_PEM.exec(trimmed);
  return match ? `${match[1]}\n${match[2]}\n${match[3]}` : trimmed;
};

const readAppSettings = (settings: { readonly sourceControlHosts: Record<string, unknown> }) =>
  readSourceControlHostSettings(
    GitHubDefinition.settings,
    settings.sourceControlHosts[GitHubDefinition.definition.kind],
  );

const make = Effect.gen(function* () {
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const httpClient = yield* HttpClient.HttpClient;
  const signature = yield* Signature.Signature;
  const cache = yield* Ref.make<ReadonlyMap<string, InstallationToken>>(new Map());
  const mintLocks = yield* KeyedLock.make<string>();

  const configured = sourceControlHost.settings.get.pipe(
    Effect.map((settings) => {
      const { appId, appPrivateKey } = readAppSettings(settings);
      return appId !== "" && (isSecretReference(appPrivateKey) || appPrivateKey !== "");
    }),
    Effect.orElseSucceed(() => false),
  );

  const signAppJwt = Effect.fn("GitHubAppInstallationTokens.signAppJwt")(function* (
    repository: string,
  ) {
    const fail = (reason: GitHubAppInstallationError["reason"], detail: string) =>
      new GitHubAppInstallationError({ repository, reason, detail });
    const settings = yield* sourceControlHost.settings
      .getWithSecrets(GitHubDefinition.definition.kind)
      .pipe(Effect.mapError(() => fail("failed", "could not read the App key setting")));
    const { appId, appPrivateKey } = readAppSettings(settings);
    const pem = restorePemLineBreaks(settingsSecretLiteral(appPrivateKey));
    if (appId === "" || pem === "") return yield* fail("not-configured", "no App ID or key");
    // GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY"); Jwk.importPkcs8 wants PKCS#8.
    const pkcs8 = yield* Effect.try({
      try: () =>
        NodeCrypto.createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString(),
      catch: () => fail("key-rejected", "the private key is not a PEM RSA key"),
    });
    const key = yield* Jwk.importPkcs8(Redacted.make(pkcs8), "RS256").pipe(
      Effect.mapError(() => fail("key-rejected", "the private key is not a usable RS256 key")),
    );
    const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
    // Backdated a minute for clock drift; GitHub refuses an App JWT that lives over ten minutes.
    return yield* Jwt.sign(AppClaims, { iat: now - 60, exp: now + 540, iss: appId }, key).pipe(
      Effect.provideService(Signature.Signature, signature),
      Effect.mapError(() => fail("key-rejected", "could not sign the App JWT")),
    );
  });

  const send = (
    repository: string,
    jwt: Redacted.Redacted<string>,
    request: HttpClientRequest.HttpClientRequest,
  ) =>
    httpClient
      .execute(
        request.pipe(
          HttpClientRequest.setHeaders({
            accept: "application/vnd.github+json",
            authorization: `Bearer ${Redacted.value(jwt)}`,
            "user-agent": "t3code",
            "x-github-api-version": "2022-11-28",
          }),
        ),
      )
      .pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError(
          () =>
            new GitHubAppInstallationError({
              repository,
              reason: "failed",
              detail: `${request.method} ${new URL(request.url).pathname} did not answer`,
            }),
        ),
      );

  const expectStatus = (
    repository: string,
    response: HttpClientResponse.HttpClientResponse,
    ok: number,
  ) => {
    if (response.status === ok) return Effect.void;
    const step = `${response.request.method} ${new URL(response.request.url).pathname}`;
    return Effect.fail(
      new GitHubAppInstallationError({
        repository,
        reason:
          response.status === 404
            ? "not-installed"
            : response.status === 401 || response.status === 403
              ? "key-rejected"
              : "failed",
        detail: `${step} answered ${response.status}`,
      }),
    );
  };

  const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
    repository: string,
    response: HttpClientResponse.HttpClientResponse,
    schema: S,
  ) =>
    response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      // The issue would quote the body, which holds the token.
      Effect.mapError(
        () =>
          new GitHubAppInstallationError({
            repository,
            reason: "failed",
            detail: "GitHub sent an unexpected response",
          }),
      ),
    );

  const mint = Effect.fn("GitHubAppInstallationTokens.mint")(function* (
    sandboxId: SandboxId,
    repository: string,
  ) {
    const jwt = yield* signAppJwt(repository);
    const [owner, name] = repository.split("/");
    const installation = yield* send(
      repository,
      jwt,
      HttpClientRequest.get(`${API}/repos/${owner}/${name}/installation`),
    );
    yield* expectStatus(repository, installation, 200);
    const { id } = yield* decode(repository, installation, InstallationResponse);
    const minted = yield* send(
      repository,
      jwt,
      HttpClientRequest.post(`${API}/app/installations/${id}/access_tokens`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          repositories: [name],
          permissions: INSTALLATION_TOKEN_PERMISSIONS,
        }),
      ),
    );
    yield* expectStatus(repository, minted, 201);
    const body = yield* decode(repository, minted, AccessTokenResponse);
    const parsed = DateTime.make(body.expires_at);
    if (Option.isNone(parsed)) {
      return yield* new GitHubAppInstallationError({
        repository,
        reason: "failed",
        detail: "GitHub sent no token expiry",
      });
    }
    const expiresAt = DateTime.toUtc(parsed.value);
    yield* Effect.logInfo("minted a GitHub App installation token", {
      sandboxId,
      repository,
      expiresAt: DateTime.formatIso(expiresAt),
    });
    return { token: Redacted.make(body.token), expiresAt, repository } satisfies InstallationToken;
  });

  const tokenFor: GitHubAppInstallationTokens["Service"]["tokenFor"] = Effect.fn(
    "GitHubAppInstallationTokens.tokenFor",
  )(function* (input) {
    const repository = input.repository.toLowerCase();
    const key = `${input.sandboxId}\u0000${repository}`;
    const fresh = Effect.gen(function* () {
      const cached = (yield* Ref.get(cache)).get(key);
      const now = yield* DateTime.now;
      return cached !== undefined &&
        DateTime.isLessThan(now, DateTime.subtractDuration(cached.expiresAt, REFRESH_MARGIN))
        ? cached
        : undefined;
    });
    const hit = yield* fresh;
    if (hit !== undefined) return hit;
    // Two git calls for one repository mint once.
    return yield* mintLocks.withLock(
      key,
      Effect.gen(function* () {
        const raced = yield* fresh;
        if (raced !== undefined) return raced;
        const token = yield* mint(input.sandboxId, repository);
        const now = yield* DateTime.now;
        yield* Ref.update(cache, (current) => {
          const next = new Map<string, InstallationToken>();
          for (const [entryKey, entry] of current) {
            if (DateTime.isLessThan(now, entry.expiresAt)) next.set(entryKey, entry);
          }
          next.set(key, token);
          return next;
        });
        return token;
      }),
    );
  });

  return GitHubAppInstallationTokens.of({ configured, tokenFor });
});

export const layer = Layer.effect(GitHubAppInstallationTokens, make);
