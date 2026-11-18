import { describe, expect, it } from "vite-plus/test";

import {
  EMBED_PROTOCOL,
  parseEmbedConfig,
  parseEmbedHostMessage,
  parseEmbedServerPath,
} from "./protocol";

describe("parseEmbedConfig", () => {
  it("is embedded only when framed and asked to be", () => {
    const search = "?embed=1&server=/sbx/abc&thread=t1&theme=dark";
    expect(parseEmbedConfig({ search, framed: false })).toEqual({ embedded: false });
    expect(parseEmbedConfig({ search: "?server=/sbx/abc", framed: true })).toEqual({
      embedded: false,
    });
    expect(parseEmbedConfig({ search, framed: true })).toEqual({
      embedded: true,
      server: { ok: true, path: "/sbx/abc" },
      thread: { kind: "thread", threadId: "t1" },
      theme: "dark",
    });
  });

  it("opens a new thread and the default theme when the host names none", () => {
    expect(parseEmbedConfig({ search: "?embed=1&server=/s&theme=blue", framed: true })).toEqual({
      embedded: true,
      server: { ok: true, path: "/s" },
      thread: { kind: "new" },
      theme: null,
    });
  });
});

describe("parseEmbedServerPath", () => {
  it.each([
    ["/sbx/abc", "/sbx/abc"],
    ["/sbx/abc/", "/sbx/abc"],
    ["/", ""],
  ])("accepts %s", (raw, path) => {
    expect(parseEmbedServerPath(raw)).toEqual({ ok: true, path });
  });

  it.each([
    null,
    "",
    "sbx/abc",
    "//evil.test/sbx",
    "/\\evil.test",
    "https://evil.test/sbx",
    "/sbx/../api",
    "/sbx/%2e%2e/api",
    "/sbx//abc",
    "/sbx?x=1",
    "/sbx#x",
    "/sb x",
  ])("refuses %s", (raw) => {
    expect(parseEmbedServerPath(raw).ok).toBe(false);
  });
});

describe("parseEmbedHostMessage", () => {
  it.each([
    [
      { protocol: EMBED_PROTOCOL, type: "openThread", threadId: "t1" },
      { type: "openThread", target: { kind: "thread", threadId: "t1" } },
    ],
    [
      { protocol: EMBED_PROTOCOL, type: "openThread", threadId: "new" },
      { type: "openThread", target: { kind: "new" } },
    ],
    [
      { protocol: EMBED_PROTOCOL, type: "setTheme", theme: "light" },
      { type: "setTheme", theme: "light" },
    ],
    [{ protocol: "t3code-embed/v2", type: "setTheme", theme: "light" }, null],
    [{ protocol: EMBED_PROTOCOL, type: "setTheme", theme: "sepia" }, null],
    [{ protocol: EMBED_PROTOCOL, type: "openThread", threadId: " " }, null],
    [{ protocol: EMBED_PROTOCOL, type: "navigate", to: "/settings" }, null],
    ["openThread", null],
  ])("reads %j", (data, expected) => {
    expect(parseEmbedHostMessage(data)).toEqual(expected);
  });
});
