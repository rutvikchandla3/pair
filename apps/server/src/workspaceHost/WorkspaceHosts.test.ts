import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SandboxId } from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { type WorkspaceHostId, WorkspaceHostUnavailableError } from "./WorkspaceHost.ts";
import * as WorkspaceHosts from "./WorkspaceHosts.ts";
import * as WorkspaceHostTesting from "./WorkspaceHostTesting.ts";

const sandboxA = SandboxId.make("sbx_0000000000000000000a");
const sandboxB = SandboxId.make("sbx_0000000000000000000b");
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
        const worktree = yield* Effect.flip(hosts.forPath(`/t3-sandbox/${sandboxA}/worktrees/a`));
        expect(worktree).toBeInstanceOf(WorkspaceHostUnavailableError);
        expect(worktree.sandboxId).toBe(sandboxA);
        const root = yield* Effect.flip(hosts.forPath("/t3-sandbox"));
        expect(root).toBeInstanceOf(WorkspaceHostUnavailableError);
        expect(root.sandboxId).toBeUndefined();
        // `..` collapses before matching, so a local-looking path cannot reach the reserved root.
        const hopped = yield* Effect.flip(hosts.forPath(`/repo/../t3-sandbox/${sandboxA}/x`));
        expect(hopped.sandboxId).toBe(sandboxA);
      }),
    );

    it.effect("routes a registered root to its host until the registration's scope closes", () =>
      Effect.gen(function* () {
        const hosts = yield* WorkspaceHosts.WorkspaceHosts;
        const hostA = { ...hosts.local, id: "a" as WorkspaceHostId, kind: "sandbox" as const };
        const hostB = { ...hosts.local, id: "b" as WorkspaceHostId, kind: "sandbox" as const };
        const rootA = `/t3-sandbox/${sandboxA}`;
        const scope = yield* Scope.make();
        yield* hosts.register(rootA, hostA).pipe(Scope.provide(scope));
        yield* hosts.register(`/t3-sandbox/${sandboxB}`, hostB).pipe(Scope.provide(scope));

        expect(yield* hosts.forPath(`${rootA}/worktrees/a`)).toBe(hostA);
        expect(yield* hosts.forPath(rootA)).toBe(hostA);
        // `..` cannot hop from one sandbox's root into another's.
        expect(yield* hosts.forPath(`${rootA}/../${sandboxB}/x`)).toBe(hostB);
        expect(yield* hosts.forPath(`${rootA}//worktrees/./a`)).toBe(hostA);
        // A sibling whose name starts with the root's is not under it.
        expect(yield* Effect.flip(hosts.forPath(`${rootA}0/x`))).toBeInstanceOf(
          WorkspaceHostUnavailableError,
        );

        // Any absolute root, so tests can register a temp folder; the longest root wins.
        const nested = yield* Scope.make();
        yield* hosts.register("/tmp/loopback", hostA).pipe(Scope.provide(nested));
        yield* hosts.register("/tmp/loopback/inner", hostB).pipe(Scope.provide(nested));
        expect(yield* hosts.forPath("/tmp/loopback/x")).toBe(hostA);
        expect(yield* hosts.forPath("/tmp/loopback/inner/x")).toBe(hostB);
        yield* Scope.close(nested, Exit.void);
        expect(yield* hosts.forPath("/tmp/loopback/x")).toBe(hosts.local);

        yield* Scope.close(scope, Exit.void);
        const closed = yield* Effect.flip(hosts.forPath(`${rootA}/worktrees/a`));
        expect(closed).toBeInstanceOf(WorkspaceHostUnavailableError);
        expect(closed.sandboxId).toBe(sandboxA);
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
