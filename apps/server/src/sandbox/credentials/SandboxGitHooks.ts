import { GitManagerError, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import { RepositoryIdentityResolver } from "../../project/RepositoryIdentityResolver.ts";
import { sandboxIdFromPath } from "../../workspaceHost/WorkspaceHost.ts";
import { makeSourceFor } from "./GitCredentialService.ts";

export interface SandboxGitHooksShape {
  /** Fails before git runs when a cloud push can't authenticate; else the env `git push` needs. */
  readonly preparePush: (input: {
    readonly cwd: string;
    readonly threadId: ThreadId | undefined;
  }) => Effect.Effect<NodeJS.ProcessEnv, GitManagerError>;
}

const passThrough: SandboxGitHooksShape = { preparePush: () => Effect.succeed({}) };

/** A Reference whose default adds nothing, so local and worktree pushes run exactly as before. */
export const SandboxGitHooks = Context.Reference<SandboxGitHooksShape>(
  "t3/sandbox/credentials/SandboxGitHooks",
  { defaultValue: () => passThrough },
);

const OPERATION = "SandboxGitHooks.preparePush";

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const projects = yield* ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver;
  const sourceFor = yield* makeSourceFor;

  const isGitHubProject = Effect.fn("SandboxGitHooks.isGitHubProject")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects.get(projectId);
    if (Option.isNone(project)) return true;
    const identity = yield* identities.resolve(project.value.workspaceRoot);
    // With no remote, git's own "no remote" error says more than a refusal would.
    return identity === null || identity.canonicalKey.toLowerCase().startsWith("github.com/");
  });

  const preparePush: SandboxGitHooksShape["preparePush"] = Effect.fn(OPERATION)(
    function* ({ cwd, threadId }) {
      const sandboxId = sandboxIdFromPath(cwd);
      if (sandboxId === undefined) return {};
      const sandbox = yield* projections.getSandbox(sandboxId);
      if (sandbox === null) return {};
      const attached = yield* projections.listSandboxThreads(sandboxId);
      const attachedIds = new Set(attached.map((row) => row.threadId));
      const threads = yield* Effect.forEach(attached, (row) => projections.getThread(row.threadId));
      // A workspace thread's repositories sit at `<worktreePath>/<root name>`.
      const rootAt = (thread: (typeof threads)[number]) =>
        thread.roots?.find((root) => `${thread.worktreePath}/${root.name}` === cwd);
      const atCwd = threads.find(
        (thread) => thread.worktreePath === cwd || rootAt(thread) !== undefined,
      );
      const pushFor =
        threadId !== undefined && attachedIds.has(threadId)
          ? threadId
          : (atCwd?.id ?? sandbox.ownerThreadId);
      const repositoryProject =
        (atCwd === undefined ? undefined : rootAt(atCwd)?.projectId) ?? sandbox.projectId;
      if (!(yield* isGitHubProject(repositoryProject))) {
        return yield* new GitManagerError({
          operation: OPERATION,
          cwd,
          code: "cloud-push-unsupported-host",
          detail: "Pushing from cloud supports GitHub until a later release.",
        });
      }
      if (Option.isNone(yield* sourceFor(pushFor))) {
        return yield* new GitManagerError({
          operation: OPERATION,
          cwd,
          code: "github-credential-missing",
          detail: "Connect GitHub to push: Settings → Team, your row.",
        });
      }
      // The credential helper answers for this thread, so a fork pushes as its own owner.
      return { T3CODE_THREAD_ID: pushFor };
    },
    (effect, { cwd }) =>
      effect.pipe(
        Effect.mapError((error) =>
          error._tag === "GitManagerError"
            ? error
            : new GitManagerError({
                operation: OPERATION,
                cwd,
                detail: error.message,
                cause: error,
              }),
        ),
      ),
  );

  return { preparePush } satisfies SandboxGitHooksShape;
});

export const layer = Layer.effect(SandboxGitHooks, make);
