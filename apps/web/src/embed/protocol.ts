import { ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The page-to-host protocol a host uses to embed the web app in a same-origin iframe. */
export const EMBED_PROTOCOL = "t3code-embed/v1";

const EmbedTheme = Schema.Literals(["light", "dark"]);
export type EmbedTheme = typeof EmbedTheme.Type;

export type EmbedThreadTarget =
  | { readonly kind: "new" }
  | { readonly kind: "thread"; readonly threadId: ThreadId };

export type EmbedServerPath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

export type EmbedConfig =
  | { readonly embedded: false }
  | {
      readonly embedded: true;
      readonly server: EmbedServerPath;
      readonly thread: EmbedThreadTarget;
      readonly theme: EmbedTheme | null;
    };

const isThreadId = Schema.is(ThreadId);
const isEmbedTheme = Schema.is(EmbedTheme);

function parseEmbedThreadTarget(raw: string | null): EmbedThreadTarget | null {
  if (raw === null || raw === "new") return { kind: "new" };
  return isThreadId(raw) ? { kind: "thread", threadId: raw } : null;
}

/**
 * The server must be a path on this page's origin. Anything a URL parser would rewrite (dot
 * segments, backslashes, a second leading slash that names another host) is refused, never
 * resolved, so the app can only ever talk to the path the host named.
 */
export function parseEmbedServerPath(raw: string | null): EmbedServerPath {
  if (raw === null || raw.length === 0) {
    return { ok: false, reason: "The embedding page did not name a server path." };
  }
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\\?#\s\p{Cc}]/u.test(raw)) {
    return {
      ok: false,
      reason: `The server path "${raw}" must be an absolute path on this site, such as /sbx/123.`,
    };
  }
  const path = raw.replace(/\/+$/, "");
  if (path.includes("//") || new URL(raw, "https://embed.invalid").pathname !== raw) {
    return { ok: false, reason: `The server path "${raw}" is not a plain path.` };
  }
  return { ok: true, path };
}

/** Embedded only inside a frame, so an address someone opened directly keeps the normal app. */
export function parseEmbedConfig(input: {
  readonly search: string;
  readonly framed: boolean;
}): EmbedConfig {
  const params = new URLSearchParams(input.search);
  if (!input.framed || params.get("embed") !== "1") return { embedded: false };
  const theme = params.get("theme");
  return {
    embedded: true,
    server: parseEmbedServerPath(params.get("server")),
    thread: parseEmbedThreadTarget(params.get("thread")) ?? { kind: "new" },
    theme: isEmbedTheme(theme) ? theme : null,
  };
}

const HostMessage = Schema.Union([
  Schema.Struct({
    protocol: Schema.Literal(EMBED_PROTOCOL),
    type: Schema.Literal("openThread"),
    threadId: Schema.String,
  }),
  Schema.Struct({
    protocol: Schema.Literal(EMBED_PROTOCOL),
    type: Schema.Literal("setTheme"),
    theme: EmbedTheme,
  }),
]);
const decodeHostMessage = Schema.decodeUnknownOption(HostMessage);

export type EmbedHostMessage =
  | { readonly type: "openThread"; readonly target: EmbedThreadTarget }
  | { readonly type: "setTheme"; readonly theme: EmbedTheme };

export function parseEmbedHostMessage(data: unknown): EmbedHostMessage | null {
  const message = Option.getOrNull(decodeHostMessage(data));
  if (message === null) return null;
  if (message.type === "setTheme") return { type: "setTheme", theme: message.theme };
  const target = parseEmbedThreadTarget(message.threadId);
  return target === null ? null : { type: "openThread", target };
}

export interface EmbedThreadSummary {
  readonly id: ThreadId;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly working: boolean;
}

/** What the embed posts to its host; each goes out with `protocol` set. */
export type EmbedMessage =
  | { readonly type: "ready" }
  | { readonly type: "threadChanged"; readonly threadId: ThreadId | null }
  | { readonly type: "threadsChanged"; readonly threads: ReadonlyArray<EmbedThreadSummary> };

interface EmbedHostConnection {
  readonly post: (message: EmbedMessage) => void;
  readonly dispose: () => void;
}

/** Talks only to `host` on this page's own origin, in both directions. */
export function connectEmbedHost(input: {
  readonly self: Window;
  readonly host: Window;
  readonly onMessage: (message: EmbedHostMessage) => void;
}): EmbedHostConnection {
  const origin = input.self.location.origin;
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== origin || event.source !== input.host) return;
    const message = parseEmbedHostMessage(event.data);
    if (message !== null) input.onMessage(message);
  };
  input.self.addEventListener("message", onMessage);
  return {
    post: (message) => input.host.postMessage({ protocol: EMBED_PROTOCOL, ...message }, origin),
    dispose: () => input.self.removeEventListener("message", onMessage),
  };
}
