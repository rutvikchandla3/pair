import type { SandboxId, ThreadId } from "@t3tools/contracts";
import type { RunnerGitCredentialResponse } from "@t3tools/contracts/runner";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

class GitCredentialError extends Schema.TaggedError<GitCredentialError>()("GitCredentialError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Could not issue a git credential for the sandbox.";
  }
}

/**
 * Answers git in a sandbox for one of its threads. The `git-credential` forward has already
 * checked that the thread uses the sandbox; `null` means no credential, and git fails the push.
 */
export class GitCredentialService extends Context.Service<
  GitCredentialService,
  {
    readonly answer: (input: {
      readonly sandboxId: SandboxId;
      readonly threadId: ThreadId;
      readonly protocol: string;
      readonly host: string;
      readonly path: string | undefined;
    }) => Effect.Effect<RunnerGitCredentialResponse["credential"], GitCredentialError>;
  }
>()("t3/sandbox/credentials/GitCredentialService") {}

/** No credentials until the App token and owner credential sources land. */
export const layerNone = Layer.succeed(
  GitCredentialService,
  GitCredentialService.of({
    answer: Effect.fn("GitCredentialService.answer")(() => Effect.succeed(null)),
  }),
);
