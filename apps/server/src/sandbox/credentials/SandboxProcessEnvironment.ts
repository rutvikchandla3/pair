import {
  isReservedSandboxEnvName,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
  SandboxId,
  type ServerSettings as ServerSettingsSchema,
} from "@t3tools/contracts";
import type { RunnerInfo } from "@t3tools/contracts/runner";
import {
  CODEX_MANAGED_STRIPPED_ENV_NAMES,
  sandboxCredentialEnvNames,
  sandboxCredentialSupport,
} from "@t3tools/shared/sandboxCredentials";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { ProviderCloudLocalOnlyError } from "../../provider/Errors.ts";
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

const unreserved = (entries: ProviderInstanceEnvironment) =>
  entries.filter((entry) => !isReservedSandboxEnvName(entry.name));

/** The stored instance, or the built-in default one whose id is its driver kind. */
export const sandboxInstanceConfig = (
  settings: Pick<ServerSettingsSchema, "providerInstances">,
  instanceId: ProviderInstanceId,
): ProviderInstanceConfig =>
  settings.providerInstances[instanceId] ?? { driver: ProviderDriverKind.make(instanceId) };

/** Plain values as set, references read in one batch; later entries win. */
const resolveEntries = Effect.fn("SandboxProcessEnvironment.resolveEntries")(function* (
  secrets: SecretResolver.SecretResolver["Service"],
  allowed: ProviderInstanceEnvironment,
) {
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
     * The host's base, then the team's cloud env, then the project's, with secrets read now,
     * then the server's git committer and the thread the process runs for (git's credential
     * helper sends it). Other Pair names (homes, credentials) are the caller's to spread after.
     */
    readonly forProcess: (
      host: WorkspaceHost,
      threadId: string | undefined,
    ) => Effect.Effect<Record<string, string>, SandboxEnvironmentError>;
    /**
     * `forProcess`, then the provider instance's own unreserved entries, then its one headless
     * credential, all read in one batch. Fails for an account that signs in on the server only.
     */
    readonly forProviderSession: (input: {
      readonly host: WorkspaceHost;
      readonly instanceId: ProviderInstanceId;
      readonly threadId: string | undefined;
    }) => Effect.Effect<
      Record<string, string>,
      SandboxEnvironmentError | ProviderCloudLocalOnlyError
    >;
  }
>()("t3/sandbox/credentials/SandboxProcessEnvironment") {}

/** `GitVcsDriver`'s checkpoint committer, for a server whose git has no identity. */
const FALLBACK_COMMITTER = { name: "T3 Code", email: "t3code@users.noreply.github.com" };

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const projections = yield* ProjectionStoreV2;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  // The sandbox has no global git identity; commits name the server's, as local threads do.
  const globalGitConfig = (key: string) =>
    processRunner
      .run({
        command: "git",
        args: ["config", "--global", "--get", key],
        timeout: Duration.seconds(5),
      })
      .pipe(
        Effect.map((output) => (output.code === 0 ? output.stdout.trim() : "")),
        Effect.orElseSucceed(() => ""),
      );
  const committer = {
    GIT_COMMITTER_NAME: (yield* globalGitConfig("user.name")) || FALLBACK_COMMITTER.name,
    GIT_COMMITTER_EMAIL: (yield* globalGitConfig("user.email")) || FALLBACK_COMMITTER.email,
  };

  const sandboxOf = (host: WorkspaceHost) =>
    host.kind === "sandbox"
      ? Effect.succeed(SandboxId.make(host.id))
      : Effect.die(new Error("SandboxProcessEnvironment is for sandbox hosts only"));
  const readSettings = (sandboxId: SandboxId) =>
    settings.getSettings.pipe(
      Effect.mapError((cause) => new SandboxEnvironmentError({ sandboxId, cause })),
    );

  // Untraced: both callers carry the span.
  const environmentFor = Effect.fnUntraced(function* (
    host: WorkspaceHost,
    sandboxId: SandboxId,
    threadId: string | undefined,
    current: ServerSettingsSchema,
    /** The provider instance's entries, after the team's and project's; may name its credential. */
    instance: ProviderInstanceEnvironment,
  ) {
    const fail = (cause: unknown) => new SandboxEnvironmentError({ sandboxId, cause });
    const sandbox = yield* projections.getSandbox(sandboxId).pipe(Effect.mapError(fail));
    if (sandbox === null) return yield* fail(new Error(`Unknown sandbox ${sandboxId}`));
    const team = current.sandbox?.env ?? [];
    const project = current.projectSettingsOverrides[sandbox.projectId]?.sandboxEnv ?? [];
    const layered = yield* resolveEntries(secrets, [
      ...unreserved([...team, ...project]),
      ...instance,
    ]).pipe(Effect.mapError(fail));
    const base: Record<string, string> = {};
    for (const [name, value] of Object.entries((yield* host.info).environment)) {
      if (value !== undefined) base[name] = value;
    }
    return {
      ...base,
      ...layered,
      ...committer,
      ...(threadId === undefined ? {} : { T3CODE_THREAD_ID: threadId }),
    };
  });

  const forProcess = Effect.fn("SandboxProcessEnvironment.forProcess")(function* (
    host: WorkspaceHost,
    threadId: string | undefined,
  ) {
    const sandboxId = yield* sandboxOf(host);
    return yield* environmentFor(host, sandboxId, threadId, yield* readSettings(sandboxId), []);
  });

  const forProviderSession = Effect.fn("SandboxProcessEnvironment.forProviderSession")(function* ({
    host,
    instanceId,
    threadId,
  }: Parameters<SandboxProcessEnvironment["Service"]["forProviderSession"]>[0]) {
    const sandboxId = yield* sandboxOf(host);
    const current = yield* readSettings(sandboxId);
    const instance = sandboxInstanceConfig(current, instanceId);
    const support = sandboxCredentialSupport({ instanceId, instance });
    const localOnly = (reason: string) =>
      new ProviderCloudLocalOnlyError({
        ...(threadId === undefined ? {} : { threadId }),
        instanceId,
        reason,
      });
    if (support._tag === "LocalOnly") return yield* localOnly(support.reason);
    if (support._tag === "Unsupported") {
      return yield* localOnly(
        `${instance.driver} is not supported in cloud yet. Pick Claude or Codex.`,
      );
    }
    // Audit: which mechanism a sandbox process got, never its value (06 §7).
    yield* Effect.annotateCurrentSpan({
      "provider.instance_id": instanceId,
      "sandbox.credential_mechanism": support.mechanism,
    });
    const credentialNames = sandboxCredentialEnvNames(support.mechanism);
    const entries = instance.environment ?? [];
    const environment: Record<string, string> = yield* environmentFor(
      host,
      sandboxId,
      threadId,
      current,
      [...unreserved(entries), ...entries.filter((entry) => credentialNames.includes(entry.name))],
    );
    const [credential] = credentialNames;
    if (credential !== undefined && !environment[credential]) {
      return yield* localOnly(`${credential} is empty on this account. Set it to use it in cloud.`);
    }
    if (support.mechanism === "codex-managed") {
      for (const name of CODEX_MANAGED_STRIPPED_ENV_NAMES) delete environment[name];
    }
    return environment;
  });

  return SandboxProcessEnvironment.of({ forProcess, forProviderSession });
});

export const layer = Layer.effect(SandboxProcessEnvironment, make);
