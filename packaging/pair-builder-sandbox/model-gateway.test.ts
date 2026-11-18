// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Tests drive the real gateway over loopback.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { describe, expect, it } from "vite-plus/test";

import {
  CredentialsFormatError,
  createGateway,
  parseCredentialsFile,
  resolveUpstream,
  type Upstream,
} from "./model-gateway.ts";

interface ErrorBody {
  readonly type: string;
  readonly error: { readonly type: string; readonly message: string };
}

const CLIENT_TOKEN = "loopback-token-0123456789abcdef0123456789abcdef";

interface Captured {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

async function listen(server: NodeHttp.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
}

async function close(server: NodeHttp.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** An upstream that records each request and answers with a fixed SSE body. */
async function withUpstream<T>(
  run: (baseUrl: string, captured: Captured[]) => Promise<T>,
): Promise<T> {
  const captured: Captured[] = [];
  const upstream = NodeHttp.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    captured.push({ method: request.method, url: request.url, headers: request.headers, body });
    response.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_1" });
    response.end("event: message_stop\ndata: {}\n\n");
  });
  try {
    return await run(await listen(upstream), captured);
  } finally {
    await close(upstream);
  }
}

async function withGateway<T>(upstream: Upstream, run: (url: string) => Promise<T>): Promise<T> {
  const gateway = createGateway({ upstream, clientToken: CLIENT_TOKEN });
  try {
    return await run(await listen(gateway));
  } finally {
    await close(gateway);
  }
}

function upstreamFor(text: string): Upstream {
  return resolveUpstream(parseCredentialsFile(text));
}

const clientHeaders = {
  authorization: `Bearer ${CLIENT_TOKEN}`,
  "content-type": "application/json",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "interleaved-thinking-2025-05-14",
  "x-portkey-api-key": "client-supplied",
};

describe("parseCredentialsFile", () => {
  it("reads the Builder's single-quoted assignments as data", () => {
    const variables = parseCredentialsFile(
      [
        "# Pair Builder model credentials, written by the Builder API before every start.",
        "PORTKEY_API_KEY='pk-$(not run)`x`'",
        "PORTKEY_URL='https://gateway.example/v1'",
        "ANTHROPIC_API_KEY='it'\\''s'",
        "",
      ].join("\n"),
    );
    expect(Object.fromEntries(variables)).toEqual({
      PORTKEY_API_KEY: "pk-$(not run)`x`",
      PORTKEY_URL: "https://gateway.example/v1",
      ANTHROPIC_API_KEY: "it's",
    });
  });

  it.each([
    ["an expansion", "PORTKEY_API_KEY=$(cat /etc/shadow)"],
    ["a double-quoted value", 'PORTKEY_API_KEY="key"'],
    ["an unterminated quote", "PORTKEY_API_KEY='key"],
    ["a command", "export PORTKEY_API_KEY='key'"],
  ])("refuses %s", (_name, line) => {
    expect(() => parseCredentialsFile(line)).toThrow(CredentialsFormatError);
  });
});

describe("resolveUpstream", () => {
  it.each([
    [
      "platform",
      "PLATFORM_NAMESPACE='ns-key'\nAI_PLATFORM_V2_URL='https://platform.example/api/'",
      {
        kind: "platform",
        url: "https://platform.example/api",
        headers: { authorization: "Bearer ns-key" },
      },
    ],
    [
      "portkey",
      "PORTKEY_API_KEY='pk'\nPORTKEY_URL='https://portkey.example'",
      {
        kind: "portkey",
        url: "https://portkey.example/",
        headers: { "x-portkey-provider": "anthropic", "x-portkey-api-key": "pk" },
      },
    ],
    [
      "anthropic with the default base URL",
      "ANTHROPIC_API_KEY='sk-ant'",
      { kind: "anthropic", url: "https://api.anthropic.com/", headers: { "x-api-key": "sk-ant" } },
    ],
    [
      "anthropic with a base URL",
      "ANTHROPIC_API_KEY='sk-ant'\nANTHROPIC_BASE_URL='http://proxy.example:8080/anthropic'",
      {
        kind: "anthropic",
        url: "http://proxy.example:8080/anthropic",
        headers: { "x-api-key": "sk-ant" },
      },
    ],
  ])("selects %s", (_name, text, expected) => {
    const upstream = upstreamFor(text);
    expect(
      upstream.kind === "none"
        ? upstream
        : {
            kind: upstream.kind,
            url: upstream.baseUrl.href,
            headers: upstream.headers,
          },
    ).toEqual(expected);
  });

  it.each([
    ["the no-key marker", "AUTH_TOKEN_VALUE='no-ai-gateway-key'", "no-key"],
    ["an empty file", "# nothing\n", "unavailable"],
    [
      "two kinds",
      "PORTKEY_API_KEY='pk'\nPORTKEY_URL='https://p.example'\nANTHROPIC_API_KEY='sk'",
      "unavailable",
    ],
    [
      "a key and the no-key marker",
      "ANTHROPIC_API_KEY='sk'\nAUTH_TOKEN_VALUE='no-ai-gateway-key'",
      "unavailable",
    ],
    ["a key without its URL", "PLATFORM_NAMESPACE='ns'", "unavailable"],
    [
      "a URL that is not http(s)",
      "PORTKEY_API_KEY='pk'\nPORTKEY_URL='file:///etc/passwd'",
      "unavailable",
    ],
  ])("answers no upstream for %s", (_name, text, reason) => {
    expect(upstreamFor(text)).toEqual({ kind: "none", reason });
  });
});

describe("createGateway", () => {
  it.each([
    [
      "PLATFORM_NAMESPACE='ns-key'\nAI_PLATFORM_V2_URL='{upstream}/platform'",
      "/platform/v1/messages?beta=true",
      { authorization: "Bearer ns-key" },
    ],
    [
      "PORTKEY_API_KEY='pk'\nPORTKEY_URL='{upstream}'",
      "/v1/messages?beta=true",
      { "x-portkey-provider": "anthropic", "x-portkey-api-key": "pk" },
    ],
    [
      "ANTHROPIC_API_KEY='sk-ant'\nANTHROPIC_BASE_URL='{upstream}'",
      "/v1/messages?beta=true",
      { "x-api-key": "sk-ant" },
    ],
  ])("forwards with the credential of %s", async (file, path, credentialHeaders) => {
    await withUpstream((upstreamUrl, captured) =>
      withGateway(upstreamFor(file.replace("{upstream}", upstreamUrl)), async (gatewayUrl) => {
        const response = await fetch(`${gatewayUrl}/v1/messages?beta=true`, {
          method: "POST",
          headers: clientHeaders,
          body: '{"model":"claude-haiku-5-5","stream":true}',
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("request-id")).toBe("req_1");
        expect(await response.text()).toBe("event: message_stop\ndata: {}\n\n");

        const [request] = captured;
        expect(request?.method).toBe("POST");
        expect(request?.url).toBe(path);
        expect(request?.body).toBe('{"model":"claude-haiku-5-5","stream":true}');
        const forwarded = request?.headers ?? {};
        expect(forwarded["anthropic-version"]).toBe("2023-06-01");
        expect(forwarded["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");
        const auth = Object.fromEntries(
          ["authorization", "x-api-key", "x-portkey-provider", "x-portkey-api-key"]
            .filter((name) => forwarded[name] !== undefined)
            .map((name) => [name, forwarded[name]]),
        );
        expect(auth).toEqual(credentialHeaders);
      }),
    );
  });

  it("forwards count_tokens", async () => {
    await withUpstream((upstreamUrl, captured) =>
      withGateway(
        upstreamFor(`ANTHROPIC_API_KEY='sk'\nANTHROPIC_BASE_URL='${upstreamUrl}'`),
        async (url) => {
          const response = await fetch(`${url}/v1/messages/count_tokens`, {
            method: "POST",
            headers: { "x-api-key": CLIENT_TOKEN, "content-type": "application/json" },
            body: "{}",
          });
          expect(response.status).toBe(200);
          expect(captured.map((request) => request.url)).toEqual(["/v1/messages/count_tokens"]);
        },
      ),
    );
  });

  it("streams the upstream response as it arrives", async () => {
    let releaseUpstream = () => {};
    const released = new Promise<void>((resolve) => (releaseUpstream = resolve));
    const upstream = NodeHttp.createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: first\n\n");
      void released.then(() => response.end("event: last\n\n"));
    });
    try {
      const upstreamUrl = await listen(upstream);
      await withGateway(
        upstreamFor(`ANTHROPIC_API_KEY='sk'\nANTHROPIC_BASE_URL='${upstreamUrl}'`),
        async (url) => {
          const response = await fetch(`${url}/v1/messages`, {
            method: "POST",
            headers: clientHeaders,
            body: "{}",
          });
          const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
          // A buffering gateway would never deliver this before the upstream ends.
          expect((await reader.read()).value).toBe("event: first\n\n");
          releaseUpstream();
          let rest = "";
          for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
            rest += chunk.value;
          expect(rest).toBe("event: last\n\n");
        },
      );
    } finally {
      releaseUpstream();
      await close(upstream);
    }
  });

  it.each([
    ["a missing loopback token", {}, 401, "Unknown loopback token"],
    [
      "the real-looking wrong token",
      { "x-api-key": "sk-ant-guess" },
      401,
      "Unknown loopback token",
    ],
  ])("refuses %s", async (_name, headers, status, message) => {
    await withUpstream((upstreamUrl, captured) =>
      withGateway(
        upstreamFor(`ANTHROPIC_API_KEY='sk'\nANTHROPIC_BASE_URL='${upstreamUrl}'`),
        async (url) => {
          const response = await fetch(`${url}/v1/messages`, {
            method: "POST",
            headers,
            body: "{}",
          });
          expect(response.status).toBe(status);
          expect(((await response.json()) as ErrorBody).error.message).toBe(message);
          expect(captured).toEqual([]);
        },
      ),
    );
  });

  it.each([
    ["no-key", "No AI gateway key is configured"],
    ["unavailable", "no usable model credentials"],
  ] as const)("answers a final 401 without credentials (%s)", async (reason, message) => {
    await withGateway({ kind: "none", reason }, async (url) => {
      const response = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: clientHeaders,
        body: "{}",
      });
      expect(response.status).toBe(401);
      // Claude Code otherwise retries a 401 for minutes before the turn shows the error.
      expect(response.headers.get("x-should-retry")).toBe("false");
      const body = (await response.json()) as ErrorBody;
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("authentication_error");
      expect(body.error.message).toContain(message);
    });
  });

  it("serves only the Messages API", async () => {
    await withUpstream((upstreamUrl, captured) =>
      withGateway(
        upstreamFor(`ANTHROPIC_API_KEY='sk'\nANTHROPIC_BASE_URL='${upstreamUrl}'`),
        async (url) => {
          const other = await fetch(`${url}/v1/models`, { headers: clientHeaders });
          const get = await fetch(`${url}/v1/messages`, { headers: clientHeaders });
          expect([other.status, get.status]).toEqual([404, 405]);
          expect(captured).toEqual([]);
        },
      ),
    );
  });

  it("answers a retryable 502 when the upstream is unreachable", async () => {
    const closed = NodeHttp.createServer();
    const unreachable = await listen(closed);
    await close(closed);
    await withGateway(
      upstreamFor(`ANTHROPIC_API_KEY='sk'\nANTHROPIC_BASE_URL='${unreachable}'`),
      async (url) => {
        const response = await fetch(`${url}/v1/messages`, {
          method: "POST",
          headers: clientHeaders,
          body: "{}",
        });
        expect(response.status).toBe(502);
        expect(response.headers.get("x-should-retry")).toBeNull();
      },
    );
  });
});
