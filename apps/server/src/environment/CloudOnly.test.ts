import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { SandboxId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import type { WorkspaceHostId } from "../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../workspaceHost/WorkspaceHosts.ts";
import * as WorkspaceHostTesting from "../workspaceHost/WorkspaceHostTesting.ts";
import * as CloudOnly from "./CloudOnly.ts";

const sandboxId = SandboxId.make("sbx_0000000000000000000a");
const machineRoot = `/t3-sandbox/${sandboxId}`;

const layerTest = Layer.mergeAll(
  WorkspaceHostTesting.layerFromContext,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-cloud-only-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const cloudOnly = (on: boolean) =>
  Effect.updateService(ServerConfig.ServerConfig, (config) => ({ ...config, cloudOnly: on }));

it.layer(layerTest)("CloudOnly.refuseLocalHost", (it) => {
  it.effect.each([
    ["a server path", true, "/srv/repo"],
    ["no path", true, null],
    ["a connected machine's path", false, `${machineRoot}/worktrees/a`],
    ["a sleeping machine's path", false, `/t3-sandbox/sbx_0000000000000000000b/worktrees/a`],
    ["a path that climbs out of a machine", true, `${machineRoot}/../../srv/repo`],
  ] as const)("%s: refused on a cloud-only server is %s", ([, refused, path]) =>
    Effect.gen(function* () {
      const hosts = yield* WorkspaceHosts.WorkspaceHosts;
      const machine = {
        ...hosts.local,
        id: "machine" as WorkspaceHostId,
        kind: "sandbox" as const,
      };
      yield* hosts.register(machineRoot, machine);

      const onCloudOnly = yield* CloudOnly.refuseLocalHost("test.op", path).pipe(
        cloudOnly(true),
        Effect.result,
      );
      const elsewhere = yield* CloudOnly.refuseLocalHost("test.op", path).pipe(cloudOnly(false));

      expect(Result.isFailure(onCloudOnly)).toBe(refused);
      if (Result.isFailure(onCloudOnly)) {
        expect(onCloudOnly.failure).toMatchObject({
          _tag: "CloudOnlyRefusedError",
          operation: "test.op",
          message: CloudOnly.CLOUD_ONLY_MESSAGE,
        });
      }
      expect(elsewhere).toBeUndefined();
    }).pipe(Effect.scoped),
  );
});
