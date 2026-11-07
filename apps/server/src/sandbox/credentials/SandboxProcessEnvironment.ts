import {
  isReservedSandboxEnvName,
  type ProviderInstanceEnvironment,
  SandboxId,
} from "@t3tools/contracts";
import type { RunnerInfo } from "@t3tools/contracts/runner";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { SettingsSecretUnresolvedError } from "../../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../../serverSettings.ts";
import type { WorkspaceHost } from "../../workspaceHost/WorkspaceHost.ts";

/**
 * The base environment of every process the server starts in a sandbox: an allowlist built from
 * the runner's facts and the image's `ENV`. Never anything from the server's environment.
 */
export const sandboxBaseEnvironment = (info: RunnerInfo): Record<string, string> => {
  const image = info.imageEnvironment;
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(image)) {
    if (!isReservedSandboxEnvName(name)) base[name] = value;
  }
  return {
    ...base,
    // The bundle's `t3` first, for ACP bridges and the Codex auth command.
    PATH: image.PATH ? `${info.bundleDirectory}:${image.PATH}` : info.bundleDirectory,
    HOME: info.agent.homeDirectory,
    SHELL: info.agent.shell,
    USER: "t3",
    LANG: image.LANG ?? "C.UTF-8",
    TERM: "xterm-256color",
  };
};

const isSecretUnresolved = Schema.is(SettingsSecretUnresolvedError);

export class SandboxEnvironmentError extends Schema.TaggedError<SandboxEnvironmentError>()(
  "SandboxEnvironmentError",
  { sandboxId: SandboxId, cause: Schema.Defect() },
) {
  override get message(): string {
    return isSecretUnresolved(this.cause)
      ? this.cause.message
      : `Could not read the cloud environment for sandbox ${this.sandboxId}.`;
  }
}

/** Plain values as set, references read in one batch; later entries win, reserved names drop. */
const resolveEntries = Effect.fn("SandboxProcessEnvironment.resolveEntries")(function* (
  secrets: SecretResolver.SecretResolver["Service"],
  entries: ProviderInstanceEnvironment,
) {
  const allowed = entries.filter((entry) => !isReservedSandboxEnvName(entry.name));
  const references = allowed.flatMap((entry) =>
    typeof entry.value === "string" ? [] : [entry.value],
  );
  const values = references.length === 0 ? [] : yield* secrets.read(references);
  const resolved: Record<string, string> = {};
  let index = 0;
  for (const entry of allowed) {
    if (typeof entry.value === "string") {
      resolved[entry.name] = entry.value;
      continue;
    }
    const value = values[index++];
    // A process never starts without a variable the admin set.
    if (value === undefined || value.trim() === "") {
      return yield* new SettingsSecretUnresolvedError({ provider: entry.value.provider });
    }
    resolved[entry.name] = value;
  }
  return resolved;
});

export class SandboxProcessEnvironment extends Context.Service<
  SandboxProcessEnvironment,
  {
    /**
     * The host's base, then the team's cloud env, then the project's, with secrets read now.
     * Pair's own names (`T3CODE_*`, homes, credentials) are the caller's to spread after.
     */
    readonly forProcess: (
      host: WorkspaceHost,
    ) => Effect.Effect<Record<string, string>, SandboxEnvironmentError>;
  }
>()("t3/sandbox/credentials/SandboxProcessEnvironment") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const projections = yield* ProjectionStoreV2;

  const forProcess = Effect.fn("SandboxProcessEnvironment.forProcess")(function* (
    host: WorkspaceHost,
  ) {
    if (host.kind !== "sandbox") {
      return yield* Effect.die(new Error("SandboxProcessEnvironment is for sandbox hosts only"));
    }
    const sandboxId = SandboxId.make(host.id);
    const fail = (cause: unknown) => new SandboxEnvironmentError({ sandboxId, cause });
    const sandbox = yield* projections.getSandbox(sandboxId).pipe(Effect.mapError(fail));
    if (sandbox === null) return yield* fail(new Error(`Unknown sandbox ${sandboxId}`));
    const current = yield* settings.getSettings.pipe(Effect.mapError(fail));
    const team = current.sandbox?.env ?? [];
    const project = current.projectSettingsOverrides[sandbox.projectId]?.sandboxEnv ?? [];
    const layered = yield* resolveEntries(secrets, [...team, ...project]).pipe(
      Effect.mapError(fail),
    );
    const base: Record<string, string> = {};
    for (const [name, value] of Object.entries((yield* host.info).environment)) {
      if (value !== undefined) base[name] = value;
    }
    return { ...base, ...layered };
  });

  return SandboxProcessEnvironment.of({ forProcess });
});

export const layer = Layer.effect(SandboxProcessEnvironment, make);
