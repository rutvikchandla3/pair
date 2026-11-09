import type { MemberId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

// Only the tag, apart from its layer: the terminal manager resolves it per write, and the layer
// reaches thread launch, which imports the terminal manager.

export class SandboxWake extends Context.Service<
  SandboxWake,
  {
    /** One `sandbox.wake` when the thread's machine sleeps; a no-op otherwise. */
    readonly wake: (input: {
      readonly threadId: ThreadId;
      readonly actorId?: MemberId;
    }) => Effect.Effect<void>;
    /** Renews the lease; wakes on a new one, unless the thread is settled or archived. */
    readonly viewed: (input: {
      readonly threadId: ThreadId;
      readonly actorId?: MemberId;
    }) => Effect.Effect<void>;
  }
>()("t3/sandbox/lifecycle/SandboxWakeService/SandboxWake") {}
