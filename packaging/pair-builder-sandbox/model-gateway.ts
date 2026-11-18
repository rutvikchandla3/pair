#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off extendsNativeError:off - The image runs this on bare Node, with no node_modules or Effect runtime.
// Loopback model gateway (see README.md). The agent can read whatever its user can, so the model
// credential stays in this process, run as its own user: it adds the credential to the Messages
// API calls Claude Code sends here. Plain Node (type stripping), no dependencies.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";

export type Upstream =
  | {
      readonly kind: "platform" | "portkey" | "anthropic";
      readonly baseUrl: URL;
      readonly headers: Readonly<Record<string, string>>;
    }
  | { readonly kind: "none"; readonly reason: "no-key" | "unavailable" };

const NO_KEY_MARKER = "no-ai-gateway-key";
const KNOWN_VARIABLES = new Set([
  "AUTH_TOKEN_VALUE",
  "PLATFORM_NAMESPACE",
  "AI_PLATFORM_V2_URL",
  "PORTKEY_API_KEY",
  "PORTKEY_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
]);
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

const FORWARDED_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

// The client's credential is replaced; hop-by-hop headers belong to each connection. Identity
// encoding keeps SSE unbuffered and lets the client read the stream as it arrives.
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "proxy-authorization",
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "accept-encoding",
]);
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "trailer",
  "upgrade",
]);

// Streams send pings, so silence this long means the upstream is gone, not thinking.
const UPSTREAM_IDLE_TIMEOUT_MS = 10 * 60_000;
const UPSTREAM_CONNECT_TIMEOUT_MS = 30_000;
// Node's global agents time sockets out after 5 s idle, which would cut a slow response.
const AGENTS = {
  "http:": new NodeHttp.Agent({ timeout: UPSTREAM_IDLE_TIMEOUT_MS }),
  "https:": new NodeHttps.Agent({ timeout: UPSTREAM_IDLE_TIMEOUT_MS }),
};

export class CredentialsFormatError extends Error {}

/**
 * Parses the Builder's credentials file: `NAME='value'` lines (POSIX single quotes, `'\''` for a
 * quote) and comments. It is read as data, never run, so anything else is refused.
 */
export function parseCredentialsFile(text: string): Map<string, string> {
  const variables = new Map<string, string>();
  const lines = text.split("\n");
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new CredentialsFormatError(`line ${index + 1} is not an assignment`);
    const [, name = "", rawValue = ""] = match;
    let value = "";
    let rest = rawValue;
    while (rest.length > 0) {
      const quoted = /^'([^']*)'/.exec(rest);
      if (quoted) {
        value += quoted[1];
        rest = rest.slice(quoted[0].length);
      } else if (rest.startsWith("\\'")) {
        value += "'";
        rest = rest.slice(2);
      } else {
        const bare = /^[A-Za-z0-9_./:@%+,-]+/.exec(rest);
        if (!bare) throw new CredentialsFormatError(`${name} (line ${index + 1}) is not quoted`);
        value += bare[0];
        rest = rest.slice(bare[0].length);
      }
    }
    variables.set(name, value);
  }
  return variables;
}

function parseBaseUrl(name: string, value: string): URL {
  const url = URL.parse(value.trim());
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.search || url.hash) {
    throw new CredentialsFormatError(`${name} is not an http(s) URL`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

/** Picks the one gateway kind the file carries. The Builder writes exactly one. */
export function resolveUpstream(
  variables: ReadonlyMap<string, string>,
  log: (message: string) => void = () => {},
): Upstream {
  const value = (name: string) => variables.get(name)?.trim() ?? "";
  const unknown = [...variables.keys()].filter((name) => !KNOWN_VARIABLES.has(name));
  if (unknown.length > 0) log(`ignoring unknown credentials variables: ${unknown.join(", ")}`);

  const kinds: string[] = [];
  if (value("PLATFORM_NAMESPACE")) kinds.push("platform");
  if (value("PORTKEY_API_KEY")) kinds.push("portkey");
  if (value("ANTHROPIC_API_KEY")) kinds.push("anthropic");
  if (value("AUTH_TOKEN_VALUE") === NO_KEY_MARKER) kinds.push("no-key");
  if (kinds.length === 0) {
    log("the credentials file names no gateway key");
    return { kind: "none", reason: "unavailable" };
  }
  if (kinds.length > 1) {
    log(`refusing an ambiguous credentials file (it carries ${kinds.join(" and ")})`);
    return { kind: "none", reason: "unavailable" };
  }
  try {
    switch (kinds[0]) {
      case "platform":
        if (!value("AI_PLATFORM_V2_URL"))
          throw new CredentialsFormatError("AI_PLATFORM_V2_URL is missing");
        return {
          kind: "platform",
          baseUrl: parseBaseUrl("AI_PLATFORM_V2_URL", value("AI_PLATFORM_V2_URL")),
          headers: { authorization: `Bearer ${value("PLATFORM_NAMESPACE")}` },
        };
      case "portkey":
        if (!value("PORTKEY_URL")) throw new CredentialsFormatError("PORTKEY_URL is missing");
        return {
          kind: "portkey",
          baseUrl: parseBaseUrl("PORTKEY_URL", value("PORTKEY_URL")),
          headers: {
            "x-portkey-provider": "anthropic",
            "x-portkey-api-key": value("PORTKEY_API_KEY"),
          },
        };
      case "anthropic":
        return {
          kind: "anthropic",
          baseUrl: parseBaseUrl(
            "ANTHROPIC_BASE_URL",
            value("ANTHROPIC_BASE_URL") || DEFAULT_ANTHROPIC_BASE_URL,
          ),
          headers: { "x-api-key": value("ANTHROPIC_API_KEY") },
        };
      default:
        return { kind: "none", reason: "no-key" };
    }
  } catch (error) {
    if (!(error instanceof CredentialsFormatError)) throw error;
    log(`refusing the credentials file: ${error.message}`);
    return { kind: "none", reason: "unavailable" };
  }
}

function digest(value: string): Buffer {
  return NodeCrypto.createHash("sha256").update(value).digest();
}

function presentedToken(headers: NodeHttp.IncomingHttpHeaders): string | undefined {
  const apiKey = headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey) return apiKey;
  const match = /^Bearer\s+(.+)$/i.exec(headers.authorization?.trim() ?? "");
  return match?.[1];
}

function sendError(
  response: NodeHttp.ServerResponse,
  status: number,
  type: string,
  message: string,
): void {
  const body = JSON.stringify({ type: "error", error: { type, message } });
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    // Claude Code retries a 401 ten times with backoff; none of these gets better by retrying.
    ...(status === 502 ? {} : { "x-should-retry": "false" }),
  });
  response.end(body);
}

const NO_KEY_MESSAGE =
  "No AI gateway key is configured for this Pair Builder account, so this workspace cannot call models. An org admin can add one in Pair Builder's account settings.";
const UNAVAILABLE_MESSAGE =
  "This Pair Builder sandbox has no usable model credentials. Restart the sandbox; if it persists, check the sandbox logs.";

export interface GatewayOptions {
  readonly upstream: Upstream;
  /** Loopback token the T3 server's Claude processes present as their API credential. */
  readonly clientToken: string;
  readonly log?: (message: string) => void;
}

export function createGateway(options: GatewayOptions): NodeHttp.Server {
  const log = options.log ?? (() => {});
  const expectedToken = digest(options.clientToken);
  const { upstream } = options;

  return NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://gateway.invalid");
    if (!FORWARDED_PATHS.has(url.pathname)) {
      sendError(response, 404, "not_found_error", `${url.pathname} is not served by this gateway`);
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      sendError(response, 405, "invalid_request_error", "Use POST");
      return;
    }
    const token = presentedToken(request.headers);
    if (token === undefined || !NodeCrypto.timingSafeEqual(digest(token), expectedToken)) {
      sendError(response, 401, "authentication_error", "Unknown loopback token");
      return;
    }
    if (upstream.kind === "none") {
      sendError(
        response,
        401,
        "authentication_error",
        upstream.reason === "no-key" ? NO_KEY_MESSAGE : UNAVAILABLE_MESSAGE,
      );
      return;
    }

    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (
        value === undefined ||
        STRIPPED_REQUEST_HEADERS.has(name) ||
        name.startsWith("x-portkey-")
      ) {
        continue;
      }
      headers[name] = value;
    }
    Object.assign(headers, upstream.headers);

    const target = new URL(upstream.baseUrl);
    target.pathname = `${upstream.baseUrl.pathname.replace(/\/+$/, "")}${url.pathname}`;
    target.search = url.search;
    const isHttps = target.protocol === "https:";
    const transport = isHttps ? NodeHttps : NodeHttp;
    const startedAt = process.hrtime.bigint();

    const forward = transport.request(target, {
      method: "POST",
      headers,
      agent: AGENTS[isHttps ? "https:" : "http:"],
    });
    const connectTimer = setTimeout(() => {
      forward.destroy(new Error("upstream connect timeout"));
    }, UPSTREAM_CONNECT_TIMEOUT_MS);
    forward.once("socket", (socket) => {
      // A kept-alive socket is already connected.
      if (!socket.connecting) return clearTimeout(connectTimer);
      socket.once(isHttps ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
    });
    forward.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
      forward.destroy(new Error("upstream idle timeout"));
    });

    forward.on("response", (upstreamResponse) => {
      clearTimeout(connectTimer);
      const responseHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value !== undefined && !STRIPPED_RESPONSE_HEADERS.has(name))
          responseHeaders[name] = value;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      response.flushHeaders();
      upstreamResponse.pipe(response);
      upstreamResponse.once("end", () => {
        const ms = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
        log(`POST ${url.pathname} -> ${upstreamResponse.statusCode} (${ms} ms)`);
      });
      upstreamResponse.once("error", () => response.destroy());
    });
    forward.on("error", (error) => {
      clearTimeout(connectTimer);
      log(`POST ${url.pathname} failed: ${error.message}`);
      if (!response.headersSent) {
        sendError(response, 502, "api_error", "The model gateway could not reach its upstream.");
      } else {
        response.destroy();
      }
    });
    // The client gave up (for example an interrupted turn): stop the upstream call too.
    response.once("close", () => {
      if (!response.writableFinished) forward.destroy();
    });
    request.pipe(forward);
  });
}

function main(): void {
  const log = (message: string) => process.stderr.write(`model-gateway: ${message}\n`);
  const port = Number(process.env.PAIR_MODEL_GATEWAY_PORT);
  const clientToken = process.env.PAIR_MODEL_GATEWAY_CLIENT_TOKEN ?? "";
  if (!Number.isInteger(port) || port <= 0 || port > 65_535 || clientToken.length < 32) {
    log("PAIR_MODEL_GATEWAY_PORT and PAIR_MODEL_GATEWAY_CLIENT_TOKEN are required");
    process.exit(2);
  }
  delete process.env.PAIR_MODEL_GATEWAY_CLIENT_TOKEN;

  let upstream: Upstream = { kind: "none", reason: "unavailable" };
  const fd = process.env.PAIR_MODEL_GATEWAY_CREDENTIALS_FD;
  if (fd === undefined) {
    log("no model credentials were handed over; model calls answer 401");
  } else {
    try {
      const text = NodeFS.readFileSync(Number(fd), "utf8");
      NodeFS.closeSync(Number(fd));
      upstream = resolveUpstream(parseCredentialsFile(text), log);
    } catch (error) {
      const reason =
        error instanceof CredentialsFormatError ? error.message : "it could not be read";
      log(`refusing the credentials file: ${reason}`);
    }
  }
  log(
    upstream.kind === "none"
      ? `no usable model credentials (${upstream.reason}); model calls answer 401`
      : `forwarding to the ${upstream.kind} gateway at ${upstream.baseUrl.origin}`,
  );

  const server = createGateway({ upstream, clientToken, log });
  server.listen(port, "127.0.0.1", () => log(`listening on 127.0.0.1:${port}`));
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (import.meta.main) main();
