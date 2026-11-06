import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { WorkspaceHostUnavailableError } from "./WorkspaceHost.ts";
import * as WorkspaceHosts from "./WorkspaceHosts.ts";
import * as WorkspaceHostTesting from "./WorkspaceHostTesting.ts";

const layerTest = WorkspaceHostTesting.layerFromContext.pipe(Layer.provide(NodeServices.layer));

it.layer(layerTest)("WorkspaceHosts", (it) => {
  describe("forPath", () => {
    it.effect("resolves paths outside the reserved root to the local host", () =>
      Effect.gen(function* () {
        const hosts = yield* WorkspaceHosts.WorkspaceHosts;
        for (const path of ["/repo", "/t3-sandboxes/x", "C:\\repo"]) {
          expect(yield* hosts.forPath(path)).toBe(hosts.local);
        }
      }),
    );

    it.effect("fails closed for unregistered paths under the reserved root", () =>
      Effect.gen(function* () {
        const hosts = yield* WorkspaceHosts.WorkspaceHosts;
        const worktree = yield* Effect.flip(hosts.forPath("/t3-sandbox/sbx_0123/worktrees/a"));
        expect(worktree).toBeInstanceOf(WorkspaceHostUnavailableError);
        expect(worktree.sandboxId).toBe("sbx_0123");
        const root = yield* Effect.flip(hosts.forPath("/t3-sandbox"));
        expect(root).toBeInstanceOf(WorkspaceHostUnavailableError);
      }),
    );
  });

  describe("local.info", () => {
    it.effect("reads the HostProcess references at each use", () =>
      Effect.gen(function* () {
        const { local } = yield* WorkspaceHosts.WorkspaceHosts;
        expect((yield* local.info).environment).toBe(yield* HostProcess.Environment);
        const overridden = yield* local.info.pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
        );
        expect(overridden.platform).toBe("darwin");
      }),
    );
  });
});
