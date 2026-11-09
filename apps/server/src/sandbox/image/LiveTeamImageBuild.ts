import type { ComputeDriverId, TeamImageBuildId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export interface LiveBuild {
  readonly imageBuildId: TeamImageBuildId;
  readonly driverId: ComputeDriverId;
}

/**
 * The build that holds a machine slot, if any. No dependencies, so admission and the drain read it
 * without depending on `TeamImageService`, its only writer.
 */
export class LiveTeamImageBuild extends Context.Service<
  LiveTeamImageBuild,
  {
    readonly current: Effect.Effect<LiveBuild | null>;
    /** The current value first, then each change. */
    readonly changes: Stream.Stream<LiveBuild | null>;
    readonly set: (build: LiveBuild | null) => Effect.Effect<void>;
  }
>()("t3/sandbox/image/LiveTeamImageBuild") {}

export const layer = Layer.effect(
  LiveTeamImageBuild,
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make<LiveBuild | null>(null);
    return LiveTeamImageBuild.of({
      current: SubscriptionRef.get(ref),
      changes: SubscriptionRef.changes(ref),
      set: Effect.fn("LiveTeamImageBuild.set")((build: LiveBuild | null) =>
        SubscriptionRef.set(ref, build),
      ),
    });
  }),
);
