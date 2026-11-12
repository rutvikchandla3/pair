import type { MemberId, MessageId, SpaceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface SpacePairReplyRequest {
  readonly spaceId: SpaceId;
  readonly roomThreadId: ThreadId;
  readonly postId: MessageId;
  readonly taggerId: MemberId;
}

/**
 * Starts a `@pair` reply for a post that tagged it. The `space.pair-reply.request` effect calls it
 * after the post commits; until the @pair agent provides it, the request is logged and dropped.
 */
export class SpacePairReplies extends Context.Service<
  SpacePairReplies,
  {
    readonly request: (input: SpacePairReplyRequest) => Effect.Effect<void>;
  }
>()("t3/space/SpacePairReplies") {}
