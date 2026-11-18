import { describe, expect, it } from "vite-plus/test";

import {
  deriveWsBaseUrl,
  environmentEndpointUrl,
  environmentSocketUrl,
  normalizeHttpBaseUrl,
  resolveEnvironmentUrl,
} from "./endpoint.ts";

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe("https://example.com/");
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/");
    expect(deriveWsBaseUrl("https://example.com/api")).toBe("wss://example.com/");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });
});

describe("server URLs under a path prefix", () => {
  it.each([
    ["http://127.0.0.1:3773", "/api/auth/session", "http://127.0.0.1:3773/api/auth/session"],
    ["https://host.test/?x=1#y", "/", "https://host.test/"],
    [
      "https://host.test/sbx/abc",
      "/api/auth/session",
      "https://host.test/sbx/abc/api/auth/session",
    ],
    [
      "https://host.test/sbx/abc/",
      "/.well-known/t3/environment",
      "https://host.test/sbx/abc/.well-known/t3/environment",
    ],
    ["https://host.test/sbx/abc/", "/", "https://host.test/sbx/abc/"],
  ])("joins %s and %s", (base, path, expected) => {
    expect(environmentEndpointUrl(base, path)).toBe(expected);
  });

  it.each([
    ["https://host.test/", "/api/assets/a.png?t=1", "https://host.test/api/assets/a.png?t=1"],
    [
      "https://host.test/sbx/abc/",
      "/api/assets/a.png?t=1#p",
      "https://host.test/sbx/abc/api/assets/a.png?t=1#p",
    ],
    [
      "https://host.test/sbx/abc",
      "/api/attachments/upload/u1",
      "https://host.test/sbx/abc/api/attachments/upload/u1",
    ],
    ["https://host.test/sbx/abc/", "https://cdn.test/a.png", "https://cdn.test/a.png"],
    ["https://host.test/sbx/abc/", "//cdn.test/a.png", "https://cdn.test/a.png"],
  ])("resolves %s against %s", (base, serverUrl, expected) => {
    expect(resolveEnvironmentUrl(base, serverUrl)).toBe(expected);
  });

  it.each([
    ["ws://127.0.0.1:3773", "ws://127.0.0.1:3773/ws"],
    ["wss://host.test/", "wss://host.test/ws"],
    ["wss://host.test/sbx/abc/", "wss://host.test/sbx/abc/ws"],
    ["wss://desktop.example.test/ws", "wss://desktop.example.test/ws"],
  ])("opens the socket for %s", (base, expected) => {
    expect(environmentSocketUrl(base).toString()).toBe(expected);
  });
});
