import { TeamError, type TeamUsageInput, type TeamUsageResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";

export class TeamUsage extends Context.Service<
  TeamUsage,
  {
    /** Turns and tokens per member and provider instance, counted against whoever prompted. */
    readonly summary: (input: TeamUsageInput) => Effect.Effect<TeamUsageResult, TeamError>;
  }
>()("t3/team/TeamUsage") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const summary = Effect.fn("TeamUsage.summary")(function* (input: TeamUsageInput) {
    const rows = yield* projections.memberUsageSince(input.since).pipe(
      Effect.tapError((cause) => Effect.logError("Could not read team usage.", { cause })),
      Effect.mapError(
        () => new TeamError({ reason: "internal", message: "Could not read team usage." }),
      ),
    );
    return { rows };
  });
  return TeamUsage.of({ summary });
});

export const layer = Layer.effect(TeamUsage, make);
