import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";

import type { ProviderCloudLocalOnlyError } from "../../provider/Errors.ts";
import { SANDBOX_ROOT, type WorkspaceHost } from "../../workspaceHost/WorkspaceHost.ts";
import {
  SandboxProcessEnvironment,
  type SandboxEnvironmentError,
} from "../credentials/SandboxProcessEnvironment.ts";

const hostEnvironment = (host: WorkspaceHost) =>
  Effect.map(host.info, (info) => {
    const environment: Record<string, string> = {};
    for (const [name, value] of Object.entries(info.environment)) {
      if (value !== undefined) environment[name] = value;
    }
    return environment;
  });

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
    Option.isSome(service) ? service.value.forProcess(host, threadId) : hostEnvironment(host);
}) satisfies Effect.Effect<SandboxEnvironmentFor>;

export type SandboxProviderSessionEnvironmentFor = (
  input: Parameters<SandboxProcessEnvironment["Service"]["forProviderSession"]>[0],
) => Effect.Effect<Record<string, string>, SandboxEnvironmentError | ProviderCloudLocalOnlyError>;

/** Like `sandboxEnvironmentFor`, plus the provider instance's env and its one headless credential. */
export const sandboxProviderSessionEnvironmentFor = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(SandboxProcessEnvironment);
  return (input: Parameters<SandboxProviderSessionEnvironmentFor>[0]) =>
    Option.isSome(service) ? service.value.forProviderSession(input) : hostEnvironment(input.host);
}) satisfies Effect.Effect<SandboxProviderSessionEnvironmentFor>;

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
