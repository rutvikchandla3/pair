// @effect-diagnostics nodeBuiltinImport:off -- the test generates a PKCS#1 key the way GitHub hands one out.
import * as NodeCrypto from "node:crypto";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, SandboxId } from "@t3tools/contracts";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Jwk from "effect/jose/Jwk";
import * as Jwt from "effect/jose/Jwt";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import * as GitHubAppInstallationTokens from "./GitHubAppInstallationTokens.ts";

const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
// A password field drops the line breaks; the server restores them.
const pastedKey = privateKey.replace(/\n/gu, "");
const sandboxA = SandboxId.make("sbx_000000000000000a1280");
const sandboxB = SandboxId.make("sbx_000000000000000b1280");

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly bearer: string;
}

/** A fake GitHub: `org/repo` is installed (id 7), anything else is not; tokens live an hour. */
const harness = (
  github: { readonly appId: string; readonly appPrivateKey: string },
  revokeStatus = 204,
) => {
  const sent: Array<Sent> = [];
  const logs: Array<string> = [];
  let minted = 0;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      sent.push({
        method: request.method,
        path: url.pathname,
        body:
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : null,
        bearer: request.headers["authorization"]?.replace(/^Bearer /u, "") ?? "",
      });
      const now = yield* DateTime.now;
      const reply =
        url.pathname === "/installation/token" && request.method === "DELETE"
          ? { status: revokeStatus, body: {} }
          : url.pathname === "/repos/org/repo/installation"
            ? { status: 200, body: { id: 7 } }
            : url.pathname === "/app/installations/7/access_tokens"
              ? {
                  status: 201,
                  body: {
                    token: `ghs_minted_${++minted}`,
                    expires_at: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
                    permissions: { contents: "write" },
                  },
                }
              : { status: 404, body: { message: "Not Found" } };
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    sourceControlHosts: { github: { tokens: {}, ...github } },
  };
  const logger = Logger.make(({ message, cause }) => {
    logs.push(JSON.stringify(message), Cause.pretty(cause));
  });
  const layer = GitHubAppInstallationTokens.layer.pipe(
    Layer.provide(TestSourceControlHost.layer({ settings })),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provideMerge(NodeCryptoLayer.layer),
    Layer.provideMerge(Logger.layer([logger], { mergeWithExisting: false })),
    Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Trace")),
  );
  return { sent, logs, layer };
};

describe("GitHubAppInstallationTokens", () => {
  it.effect("mints a one-repository token with a JWT the App's key signed, and caches it", () => {
    const { sent, logs, layer } = harness({ appId: "12345", appPrivateKey: pastedKey });
    return Effect.gen(function* () {
      const tokens = yield* GitHubAppInstallationTokens.GitHubAppInstallationTokens;
      expect(yield* tokens.configured).toBe(true);

      const first = yield* tokens.tokenFor({ sandboxId: sandboxA, repository: "Org/Repo" });
      expect(Redacted.value(first.token)).toBe("ghs_minted_1");
      expect(first.repository).toBe("org/repo");
      expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([
        "GET /repos/org/repo/installation",
        "POST /app/installations/7/access_tokens",
      ]);
      // Exactly one repository and never `workflows`.
      expect(sent[1]?.body).toEqual({
        repositories: ["repo"],
        permissions: { contents: "write", metadata: "read", pull_requests: "write" },
      });
      const jwt = sent[0]?.bearer ?? "";
      expect(sent[1]?.bearer).toBe(jwt);
      const verified = yield* Jwt.verify(
        Schema.Struct({ iss: Schema.String, iat: Schema.Number, exp: Schema.Number }),
        jwt,
        yield* Jwk.importSpki(publicKey, "RS256"),
      );
      expect(verified.claims.iss).toBe("12345");
      expect(verified.claims.exp - verified.claims.iat).toBe(600);

      // Inside the window: no request. Another sandbox gets its own token.
      yield* TestClock.adjust(Duration.minutes(54));
      expect(
        Redacted.value(
          (yield* tokens.tokenFor({ sandboxId: sandboxA, repository: "org/repo" })).token,
        ),
      ).toBe("ghs_minted_1");
      expect(sent).toHaveLength(2);
      expect(
        Redacted.value(
          (yield* tokens.tokenFor({ sandboxId: sandboxB, repository: "org/repo" })).token,
        ),
      ).toBe("ghs_minted_2");

      // Within five minutes of expiry it mints again.
      yield* TestClock.adjust(Duration.minutes(2));
      expect(
        Redacted.value(
          (yield* tokens.tokenFor({ sandboxId: sandboxA, repository: "org/repo" })).token,
        ),
      ).toBe("ghs_minted_3");

      // One line per mint, and nothing secret anywhere in the log.
      const text = logs.join("\n");
      expect(text.match(/minted a GitHub App installation token/gu)).toHaveLength(3);
      for (const secret of ["ghs_minted", jwt, "PRIVATE KEY", pastedKey.slice(40, 80)]) {
        expect(text).not.toContain(secret);
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    ["GitHub revokes it", 204],
    ["GitHub fails to revoke it", 500],
  ] as const)("forgets only that sandbox's tokens when %s", ([_name, revokeStatus]) => {
    const { sent, logs, layer } = harness(
      { appId: "12345", appPrivateKey: pastedKey },
      revokeStatus,
    );
    return Effect.gen(function* () {
      const tokens = yield* GitHubAppInstallationTokens.GitHubAppInstallationTokens;
      const token = (sandboxId: SandboxId) =>
        tokens
          .tokenFor({ sandboxId, repository: "org/repo" })
          .pipe(Effect.map((minted) => Redacted.value(minted.token)));
      expect(yield* token(sandboxA)).toBe("ghs_minted_1");
      expect(yield* token(sandboxB)).toBe("ghs_minted_2");
      sent.length = 0;

      yield* tokens.revoke(sandboxA);
      expect(sent.map(({ method, path, bearer }) => `${method} ${path} ${bearer}`)).toEqual([
        "DELETE /installation/token ghs_minted_1",
      ]);
      // A second revoke has nothing left to send.
      yield* tokens.revoke(sandboxA);
      expect(sent).toHaveLength(1);

      expect(yield* token(sandboxB)).toBe("ghs_minted_2");
      expect(sent).toHaveLength(1);
      expect(yield* token(sandboxA)).toBe("ghs_minted_3");
      expect(logs.join("\n")).not.toContain("ghs_minted");
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    [
      "a repository the App is not installed on",
      { appId: "12345", appPrivateKey: privateKey },
      { reason: "not-installed", requests: 1 },
    ],
    [
      "a key that is not a key",
      {
        appId: "12345",
        appPrivateKey: "-----BEGIN RSA PRIVATE KEY-----nope-----END RSA PRIVATE KEY-----",
      },
      { reason: "key-rejected", requests: 0 },
    ],
    [
      "no App ID",
      { appId: "", appPrivateKey: privateKey },
      { reason: "not-configured", requests: 0 },
    ],
  ] as const)("refuses %s", ([_name, github, expected]) => {
    const { sent, logs, layer } = harness(github);
    return Effect.gen(function* () {
      const tokens = yield* GitHubAppInstallationTokens.GitHubAppInstallationTokens;
      const error = yield* tokens
        .tokenFor({ sandboxId: sandboxA, repository: "org/missing" })
        .pipe(Effect.flip);
      expect(error.reason).toBe(expected.reason);
      expect(sent).toHaveLength(expected.requests);
      expect(`${error.message}\n${logs.join("\n")}`).not.toContain("PRIVATE KEY");
    }).pipe(Effect.provide(layer));
  });
});
