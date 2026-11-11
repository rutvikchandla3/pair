import {
  type CommandId,
  type GitRunStackedActionResult,
  type MemberId,
  type OrchestrationProjectShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { workspaceRootAt } from "../project/WorkspaceCheckouts.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

export interface CreatedPullRequestKey {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

export function createdPullRequestKey(
  result: Pick<GitRunStackedActionResult, "pr">,
  project: OrchestrationProjectShell | undefined,
): CreatedPullRequestKey | null {
  const { status, number, url } = result.pr;
  if ((status !== "created" && status !== "opened_existing") || number === undefined || !url) {
    return null;
  }
  return pullRequestKey({ number, url }, project);
}

/** Reads the key from the URL, else from the repository the pull request was found in. */
export function pullRequestKey(
  pullRequest: { readonly number: number; readonly url: string },
  project: Pick<OrchestrationProjectShell, "repositoryIdentity"> | undefined,
): CreatedPullRequestKey | null {
  const { number, url } = pullRequest;
  const parsed = sourceControlDefinitions.parseChangeRequestUrl(url)?.link;
  if (parsed !== undefined) {
    return { host: parsed.host, repository: parsed.repository, number: parsed.number, url };
  }
  const identity = project?.repositoryIdentity;
  const kind = identity?.provider;
  const repository = sourceControlDefinitions.repositorySelector(identity);
  if (!identity || kind === undefined || repository === null) return null;
  return {
    host: sourceControlDefinitions.changeRequestHost(identity, kind),
    repository: repository.toLowerCase(),
    number,
    url,
  };
}

/**
 * Never fails: the git action already succeeded and its result is on its way to the client, so
 * a link that cannot be made is logged and dropped.
 */
export const linkCreatedPullRequest: <E>(input: {
  readonly threadId: ThreadId;
  /** Where the action ran; in a workspace thread it names the repository. */
  readonly cwd: string;
  readonly result: Pick<GitRunStackedActionResult, "pr">;
  readonly commandId: Effect.Effect<CommandId, E>;
  readonly actorId?: MemberId | undefined;
}) => Effect.Effect<
  void,
  never,
  Orchestrator.OrchestratorV2 | ProjectService.ProjectService | Path.Path
> = Effect.fn("linkCreatedPullRequest")(
  function* <E>(input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly result: Pick<GitRunStackedActionResult, "pr">;
    readonly commandId: Effect.Effect<CommandId, E>;
    readonly actorId?: MemberId | undefined;
  }) {
    const engine = yield* Orchestrator.OrchestratorV2;
    const projects = yield* ProjectService.ProjectService;
    const path = yield* Path.Path;
    const thread = yield* engine
      .getThreadShell(input.threadId)
      .pipe(Effect.map(Option.fromNullishOr));
    if (Option.isNone(thread)) return;
    const project = Option.getOrUndefined(
      yield* projects.getShell(
        workspaceRootAt(thread.value, input.cwd, path)?.projectId ?? thread.value.projectId,
      ),
    );
    const key = createdPullRequestKey(input.result, project);
    if (key === null) return;
    const commandId = yield* input.commandId;
    yield* engine
      .dispatch({
        type: "thread.pull-request.link",
        commandId,
        threadId: input.threadId,
        ...key,
        source: "created",
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      })
      .pipe(Effect.asVoid);
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.logWarning("failed to link created pull request to thread", {
              threadId: input.threadId,
            }),
      ),
    ),
);
