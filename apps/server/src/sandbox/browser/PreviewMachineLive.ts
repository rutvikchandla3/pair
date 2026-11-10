import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { PreviewMachine } from "../../preview/PreviewMachine.ts";
import { SANDBOX_ROOT } from "../../workspaceHost/WorkspaceHost.ts";
import * as WorkspaceHosts from "../../workspaceHost/WorkspaceHosts.ts";
import { MachineBrowser, MachineBrowserError } from "./MachineBrowser.ts";

/** A thread's tabs run on its machine's Chrome: decided from the projection, never from input. */
const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const browser = yield* MachineBrowser;
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;

  const forThread = Effect.fn("PreviewMachine.forThread")(function* (threadId: ThreadId) {
    const shell = yield* projections
      .getThreadShell(threadId)
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not read a thread's machine", { threadId, cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
    const sandboxId = shell?.sandboxId;
    if (sandboxId === undefined) return Option.none();
    return Option.some({
      sandboxId,
      endpoint: browser.endpoint(sandboxId),
      host: hosts
        .forPath(`${SANDBOX_ROOT}/${sandboxId}`)
        .pipe(
          Effect.mapError(
            () => new MachineBrowserError({ sandboxId, reason: "machine-unavailable" }),
          ),
        ),
    });
  });

  return { forThread };
});

/** Empty without a `MachineBrowser`, which only a cloud-only server builds. */
export const layer = Layer.unwrap(
  Effect.map(Effect.serviceOption(MachineBrowser), (browser) =>
    Option.isSome(browser)
      ? Layer.effect(PreviewMachine, make).pipe(
          Layer.provide(
            Layer.merge(ProjectionStore.layer, Layer.succeed(MachineBrowser, browser.value)),
          ),
        )
      : Layer.empty,
  ),
);
