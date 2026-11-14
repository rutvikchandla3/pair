import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as PullRequestService from "./PullRequestService.ts";
import { makeMemberReadCredential } from "./memberReadCredential.ts";

// Large patches benefit from HTTP compression and flow control.
export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "pullRequests",
  Effect.fnUntraced(function* (handlers) {
    const pullRequests = yield* PullRequestService.PullRequestService;
    const memberReadCredential = yield* makeMemberReadCredential;
    return handlers.handle(
      "diff",
      Effect.fn("environment.pullRequests.diff")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* pullRequests
          .withMemberReadFallback(
            memberReadCredential(session.memberId, args.payload.host),
            pullRequests.diff(args.payload),
          )
          .pipe(traceLocalHandlerWork);
      }),
    );
  }),
);
