import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderSessionHostUnavailableError } from "@t3tools/provider-core/server/errors";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspaceHostTesting from "../workspaceHost/WorkspaceHostTesting.ts";
import * as ProviderHostLive from "./ProviderHostLive.ts";

const layerTest = ProviderHostLive.layer.pipe(
  Layer.provide(WorkspaceHostTesting.layerFromContext),
  Layer.provide(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-provider-host-test-" }).pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
);

it.layer(layerTest)("ProviderHostLive", (it) => {
  it.effect("fails a session cwd on a sandbox that is not connected", () =>
    Effect.gen(function* () {
      const { sessionProcesses } = yield* ProviderHost.ProviderHost;
      expect(sessionProcesses).toBeDefined();
      if (sessionProcesses === undefined) return;
      const error = yield* Effect.flip(
        sessionProcesses("/t3-sandbox/sbx_00000000000000000123/worktrees/a"),
      );
      expect(error).toBeInstanceOf(ProviderSessionHostUnavailableError);
      expect(error.sandboxId).toBe("sbx_00000000000000000123");
    }),
  );
});
