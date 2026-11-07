import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";

import { SANDBOX_ROOT, type WorkspaceHost } from "../../workspaceHost/WorkspaceHost.ts";
import {
  SandboxProcessEnvironment,
  type SandboxEnvironmentError,
} from "../credentials/SandboxProcessEnvironment.ts";

export type SandboxEnvironmentFor = (
  host: WorkspaceHost,
  /** The one thread the process serves, for git's credential helper; none for a shared one. */
  threadId: string | undefined,
) => Effect.Effect<Record<string, string>, SandboxEnvironmentError>;

/**
 * The base env of a provider process in a sandbox: `forProcess` (image allowlist, team and project
 * cloud env, committer, thread) where the server provides it, else the host's own allowlisted
 * base. Callers spread their own names (homes) after it.
 */
export const sandboxEnvironmentFor = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(SandboxProcessEnvironment);
  return (host: WorkspaceHost, threadId: string | undefined) =>
    Option.isSome(service)
      ? service.value.forProcess(host, threadId)
      : Effect.map(host.info, (info) => {
          const environment: Record<string, string> = {};
          for (const [name, value] of Object.entries(info.environment)) {
            if (value !== undefined) environment[name] = value;
          }
          return environment;
        });
}) satisfies Effect.Effect<SandboxEnvironmentFor>;

export class SandboxProviderHomeError extends Schema.TaggedError<SandboxProviderHomeError>()(
  "SandboxProviderHomeError",
  { home: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Could not create the provider home ${this.home} in the sandbox.`;
  }
}

/** A provider instance's `CLAUDE_CONFIG_DIR` or `CODEX_HOME` in a sandbox (README P1). */
export const sandboxProviderHome = (host: { readonly id: string }, instanceId: string) =>
  `${SANDBOX_ROOT}/${host.id}/homes/${instanceId}`;

/** Made by the agent user through the spawner: the runner's file calls run as root. */
export const ensureSandboxProviderHome = Effect.fn("SandboxProviderHome.ensure")(function* (
  host: { readonly id: string; readonly spawner: WorkspaceHost["spawner"] },
  instanceId: string,
) {
  const home = sandboxProviderHome(host, instanceId);
  const exitCode = yield* host.spawner
    .exitCode(ChildProcess.make("mkdir", ["-p", home]))
    .pipe(Effect.mapError((cause) => new SandboxProviderHomeError({ home, cause })));
  if (exitCode !== 0) return yield* new SandboxProviderHomeError({ home });
  return home;
});
