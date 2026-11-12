import type { MemberId, MessageId, RunId, SpaceError, SpaceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** One `@pair` reply: the run on the room thread, the tagger, and the post that tagged Pair. */
export interface SpaceReplyScope {
  readonly spaceId: SpaceId;
  readonly roomThreadId: ThreadId;
  readonly runId: RunId;
  readonly taggerId: MemberId;
  /** The tagging post; a Retry's room message maps back to it (`spaceReplyTrigger`). */
  readonly roomMessageId: MessageId;
}

/** Messages API cache marker; `ttl` "1h" for the stable prefix, "5m" otherwise (§4). */
export interface SpaceCacheControl {
  readonly type: "ephemeral";
  readonly ttl?: "5m" | "1h";
}

export interface SpaceTextBlock {
  readonly type: "text";
  readonly text: string;
  readonly cache_control?: SpaceCacheControl;
}

/** Messages API content blocks, kept to what Pair sends and replays inside one reply. */
export type SpaceContentBlock =
  | SpaceTextBlock
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly tool_use_id: string;
      readonly content: string;
      readonly is_error?: boolean;
      readonly cache_control?: SpaceCacheControl;
    }
  | { readonly type: "thinking"; readonly thinking: string; readonly signature: string }
  | { readonly type: "redacted_thinking"; readonly data: string };

export interface SpaceMessageParam {
  readonly role: "user" | "assistant" | "system";
  readonly content: string | ReadonlyArray<SpaceContentBlock>;
}

export interface SpaceToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
  readonly cache_control?: SpaceCacheControl;
}

/** Everything one Messages API request needs except the model and loop state. */
export interface SpaceAgentRequest {
  readonly system: ReadonlyArray<SpaceTextBlock>;
  readonly tools: ReadonlyArray<SpaceToolDefinition>;
  readonly messages: ReadonlyArray<SpaceMessageParam>;
}

/** Builds the request for a reply from projections (spaces-agent §4). */
export class SpaceContext extends Context.Service<
  SpaceContext,
  {
    readonly assemble: (scope: SpaceReplyScope) => Effect.Effect<SpaceAgentRequest, SpaceError>;
  }
>()("t3/space/SpaceAgentRuntime/SpaceContext") {}

export interface SpaceToolResult {
  /** Plain text for the model, capped at 3,000 tokens. */
  readonly content: string;
  readonly isError: boolean;
}

/** Pair's tools, run in process as the tagger (spaces-agent §6). Never fails: errors are results. */
export class SpaceAgentTools extends Context.Service<
  SpaceAgentTools,
  {
    readonly definitions: ReadonlyArray<SpaceToolDefinition>;
    readonly call: (
      scope: SpaceReplyScope,
      name: string,
      input: unknown,
    ) => Effect.Effect<SpaceToolResult>;
  }
>()("t3/space/SpaceAgentRuntime/SpaceAgentTools") {}
