import type { PreviewMachineBrowserReason, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { constant } from "effect/Function";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";

import type { WorkspaceHost } from "../workspaceHost/WorkspaceHost.ts";

/** The shape of `sandbox/browser`'s `MachineBrowserError`, named here so `preview/` never imports it. */
export interface PreviewMachineError {
  readonly _tag: "MachineBrowserError";
  readonly reason: PreviewMachineBrowserReason;
  readonly message: string;
}

export const isPreviewMachineError = (cause: unknown): cause is PreviewMachineError =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "MachineBrowserError" &&
  "reason" in cause &&
  typeof cause.reason === "string";

export interface PreviewMachineTarget {
  readonly sandboxId: string;
  /** The machine Chrome's CDP endpoint. A secret: never log it or send it anywhere. */
  readonly endpoint: Effect.Effect<string, PreviewMachineError>;
  /** Read per use: a machine that slept has no host until it wakes. */
  readonly host: Effect.Effect<WorkspaceHost, PreviewMachineError>;
}

/**
 * The machine a thread's browser tabs run on (07 §5, 7.4). A service, not a reference with a
 * default: a reader the server forgot to provide it to fails to compile instead of opening nothing.
 */
export class PreviewMachine extends Context.Service<
  PreviewMachine,
  {
    readonly forThread: (threadId: ThreadId) => Effect.Effect<Option.Option<PreviewMachineTarget>>;
  }
>()("t3/preview/PreviewMachine") {}

/** Every server but a cloud-only one: no thread has a machine, so tabs use the server's browser. */
export const layerNone = Layer.succeed(PreviewMachine, { forThread: constant(Effect.succeedNone) });
