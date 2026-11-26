import { describe, expect, it } from "@effect/vitest";

import { trackedFoldersRefusalAt } from "./trackedFoldersGuard.ts";

describe("trackedFoldersRefusalAt", () => {
  it("refuses a workspace's roots, a cloud-only server and a sandbox path, and only those", () => {
    expect(trackedFoldersRefusalAt(false, "/home/me/app")).toBeUndefined();
    expect(trackedFoldersRefusalAt(false, "/home/me/ws", { roots: [{}] })).toContain(
      "Workspace settings",
    );
    expect(trackedFoldersRefusalAt(true, "/srv/checkouts/app")).toContain("cloud-only");
    expect(trackedFoldersRefusalAt(false, "/t3-sandbox/sbx_00000000000000000001/app")).toContain(
      "cloud sandbox",
    );
  });
});
