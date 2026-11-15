import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  type DiscoveredLocalServer,
  PREVIEW_URL_MAX_LENGTH,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boundConfiguredLocalServerUrls, otherThreadsPorts } from "./portDiscoveryState";

describe("boundConfiguredLocalServerUrls", () => {
  it("keeps subscription payloads within the discovery RPC bounds", () => {
    const urls = Array.from(
      { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS + 1 },
      (_, index) => `http://localhost:${3_000 + index}`,
    );
    urls.unshift(
      "https://example.com",
      "not a URL",
      `http://localhost/${"a".repeat(PREVIEW_URL_MAX_LENGTH)}`,
    );

    const bounded = boundConfiguredLocalServerUrls(urls);

    expect(bounded).toHaveLength(CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS);
    expect(bounded.every((url) => url.startsWith("http://localhost:"))).toBe(true);
  });

  it("does not let fragment-only variants crowd out another server", () => {
    const fragments = Array.from(
      { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS },
      (_, index) => `http://localhost:3000/docs#section-${index}`,
    );

    expect(boundConfiguredLocalServerUrls([...fragments, "http://localhost:4000/app"])).toEqual([
      "http://localhost:3000/docs#section-0",
      "http://localhost:4000/app",
    ]);
  });
});

describe("otherThreadsPorts", () => {
  it("keeps the listeners the machine gives another thread, not this thread's or its terminals'", () => {
    const own = ThreadId.make("thread-own");
    const hanad = ThreadId.make("thread-hanad");
    const server = (port: number, fields: Partial<DiscoveredLocalServer>) =>
      ({
        pid: port,
        port,
        url: `http://localhost:${port}`,
        terminal: null,
        ...fields,
      }) as DiscoveredLocalServer;
    const ports = [
      server(3000, { agent: { threadId: own } }),
      server(3001, { agent: { threadId: hanad } }),
      server(3002, { agent: null }),
      server(3003, { terminal: { threadId: own } as DiscoveredLocalServer["terminal"] }),
    ];
    expect(otherThreadsPorts(ports, own).map((port) => port.port)).toEqual([3001]);
  });
});
