import { describe, expect, it, vi } from "vite-plus/test";

import { connectEmbedHost, EMBED_PROTOCOL } from "./protocol";

function frame(): Window & Disposable {
  const element = document.createElement("iframe");
  document.body.append(element);
  const contentWindow = element.contentWindow!;
  return Object.assign(contentWindow, { [Symbol.dispose]: () => element.remove() });
}

const openThread = { protocol: EMBED_PROTOCOL, type: "openThread", threadId: "thread-1" };

describe("connectEmbedHost", () => {
  it("accepts host messages only from the host window on this origin", () => {
    using host = frame();
    using stranger = frame();
    const onMessage = vi.fn();
    const connection = connectEmbedHost({ self: window, host, onMessage });
    const deliver = (init: MessageEventInit) =>
      window.dispatchEvent(new MessageEvent("message", init));

    deliver({ data: openThread, origin: "https://evil.test", source: host });
    deliver({ data: openThread, origin: window.location.origin, source: stranger });
    deliver({
      data: { ...openThread, protocol: "other" },
      origin: window.location.origin,
      source: host,
    });
    expect(onMessage).not.toHaveBeenCalled();

    deliver({ data: openThread, origin: window.location.origin, source: host });
    expect(onMessage).toHaveBeenCalledExactlyOnceWith({
      type: "openThread",
      target: { kind: "thread", threadId: "thread-1" },
    });

    connection.dispose();
    deliver({ data: openThread, origin: window.location.origin, source: host });
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("posts to the host on this origin only", async () => {
    using host = frame();
    const received = vi.fn();
    host.addEventListener("message", (event) => received(event.origin, event.data));
    const connection = connectEmbedHost({ self: window, host, onMessage: vi.fn() });

    connection.post({ type: "threadChanged", threadId: null });

    await vi.waitFor(() =>
      expect(received).toHaveBeenCalledWith(window.location.origin, {
        protocol: EMBED_PROTOCOL,
        type: "threadChanged",
        threadId: null,
      }),
    );
    connection.dispose();
  });
});
