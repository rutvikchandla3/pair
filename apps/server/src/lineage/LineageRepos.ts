import type {
  BranchLineageError,
  MemberId,
  SpacePostAuthorKind,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** Who is asking: the member, and whether a person or an agent or API token acts for them. */
export interface LineageCaller {
  readonly memberId: MemberId;
  readonly authorKind: SpacePostAuthorKind;
}

export interface LineageReposShape {
  /** The thread's checkout. Git run there reaches its machine through `WorkspaceHosts`. */
  readonly cwdFor: (threadId: ThreadId) => Effect.Effect<string, BranchLineageError>;
  /**
   * Makes commits that exist in `from`'s repository reachable from `to`'s. Threads that share a
   * clone (one machine, or one local repository) need nothing; others go through the mirror.
   */
  readonly carry: (input: {
    readonly from: ThreadId;
    readonly to: ThreadId;
    readonly commits: ReadonlyArray<string>;
  }) => Effect.Effect<void, BranchLineageError>;
}

export class LineageRepos extends Context.Service<LineageRepos, LineageReposShape>()(
  "t3/lineage/LineageRepos",
) {}
