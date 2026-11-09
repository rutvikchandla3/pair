import {
  type MemberId,
  type ModelSelection,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

import { providerInstanceOwner } from "./providerInstanceOwnership.ts";

export type SandboxCredentialMechanism =
  | "claude-setup-token"
  | "claude-api-key"
  | "codex-managed"
  | "codex-api-key"
  | "none";

export type SandboxCredentialSupport =
  | { readonly _tag: "Ready"; readonly mechanism: SandboxCredentialMechanism }
  | { readonly _tag: "LocalOnly"; readonly reason: string }
  | { readonly _tag: "Unsupported" };

/** The provider env names a sandbox process gets for each mechanism; the first is the credential. */
const CREDENTIAL_ENV_NAMES = {
  "claude-setup-token": ["CLAUDE_CODE_OAUTH_TOKEN"],
  "claude-api-key": ["ANTHROPIC_API_KEY"],
  "codex-managed": [],
  "codex-api-key": ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  none: [],
} as const satisfies Record<SandboxCredentialMechanism, ReadonlyArray<string>>;

export const sandboxCredentialEnvNames = (
  mechanism: SandboxCredentialMechanism,
): ReadonlyArray<string> => CREDENTIAL_ENV_NAMES[mechanism];

/** Names that would redirect a managed Codex account's token; its processes never get them. */
export const CODEX_MANAGED_STRIPPED_ENV_NAMES = [
  "ACCESS_TOKEN",
  "T3CODE_CODEX_LAUNCH_ARGS",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

// The server's `DEV_REPLAY_INSTANCE_ID`: the free dev agent needs no credential.
const DEV_REPLAY_INSTANCE_ID = "devReplay";

const CLAUDE_LOCAL_ONLY =
  "Claude signs in on this server only. Add a setup token or API key to use it in cloud.";
const CODEX_LOCAL_ONLY =
  "This Codex account signs in on this server only. Use a managed ChatGPT account or an API key in cloud.";

/**
 * How a provider account authenticates in a sandbox (06 §3). Reads only the driver, the Codex
 * setup mode and environment entry names, so it gives the same answer on redacted client settings.
 */
export const sandboxCredentialSupport = (input: {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
}): SandboxCredentialSupport => {
  const names = new Set((input.instance.environment ?? []).map((entry) => entry.name));
  switch (input.instance.driver) {
    case "claudeAgent":
      if (names.has("CLAUDE_CODE_OAUTH_TOKEN")) {
        return { _tag: "Ready", mechanism: "claude-setup-token" };
      }
      if (names.has("ANTHROPIC_API_KEY")) return { _tag: "Ready", mechanism: "claude-api-key" };
      return { _tag: "LocalOnly", reason: CLAUDE_LOCAL_ONLY };
    case "codex": {
      const config = input.instance.config;
      const managed =
        typeof config === "object" &&
        config !== null &&
        (config as { readonly setupMode?: unknown }).setupMode === "managed";
      if (managed) return { _tag: "Ready", mechanism: "codex-managed" };
      if (names.has("OPENAI_API_KEY")) return { _tag: "Ready", mechanism: "codex-api-key" };
      return { _tag: "LocalOnly", reason: CODEX_LOCAL_ONLY };
    }
    case "acpRegistry":
      return input.instanceId === DEV_REPLAY_INSTANCE_ID
        ? { _tag: "Ready", mechanism: "none" }
        : { _tag: "Unsupported" };
    default:
      return { _tag: "Unsupported" };
  }
};

/** Why an account cannot run in a sandbox, as the server decides when the session opens. */
export function cloudModelDisabledReason(
  cloud: {
    readonly settings: Pick<ServerSettings, "providerInstances">;
    readonly providers: ReadonlyArray<
      Pick<ServerProvider, "instanceId" | "driver" | "displayName">
    >;
  },
  instanceId: ProviderInstanceId,
): string | null {
  const provider = cloud.providers.find((entry) => entry.instanceId === instanceId);
  const stored = cloud.settings.providerInstances[instanceId];
  const driver = provider?.driver ?? stored?.driver ?? ProviderDriverKind.make(instanceId);
  const support = sandboxCredentialSupport({ instanceId, instance: { ...stored, driver } });
  if (support._tag === "LocalOnly") return `Local only. ${support.reason}`;
  if (support._tag === "Unsupported") {
    return `${provider?.displayName ?? driver} is not supported in cloud yet. Pick Claude or Codex.`;
  }
  return null;
}

/**
 * The accounts a member's cloud session can use: enabled and installed, the member's own or no
 * one's, and able to sign in on a machine.
 */
export function usableCloudProviders<
  P extends Pick<ServerProvider, "instanceId" | "driver" | "displayName" | "enabled" | "installed">,
>(input: {
  readonly settings: Pick<ServerSettings, "providerInstances">;
  readonly providers: ReadonlyArray<P>;
  readonly memberId: MemberId | null;
}): ReadonlyArray<P> {
  return input.providers.filter((provider) => {
    const owner = providerInstanceOwner(input.settings, provider.instanceId);
    return (
      provider.enabled &&
      provider.installed &&
      (owner === undefined || owner === input.memberId) &&
      cloudModelDisabledReason(input, provider.instanceId) === null
    );
  });
}

type CloudMoveProvider = Pick<
  ServerProvider,
  "instanceId" | "driver" | "displayName" | "enabled" | "installed" | "models"
>;

const defaultModelOf = (provider: CloudMoveProvider) =>
  (
    provider.models.find((model) => model.isDefault === true) ??
    provider.models.find((model) => model.isLegacy !== true)
  )?.slug;

/**
 * The account a thread moved to Pair Cloud runs on, since the laptop's instance ids don't exist
 * there: the same driver and model, then the driver's default, then any usable default. At each
 * step the member's own account comes before a team one.
 */
export function pickCloudMoveModel(input: {
  readonly settings: Pick<ServerSettings, "providerInstances">;
  readonly providers: ReadonlyArray<CloudMoveProvider>;
  readonly memberId: MemberId;
  readonly preferred: { readonly driver: ProviderDriverKind; readonly model: string };
}): ModelSelection | null {
  const usable = usableCloudProviders(input);
  const ordered = [
    ...usable.filter((provider) => providerInstanceOwner(input.settings, provider.instanceId)),
    ...usable.filter((provider) => !providerInstanceOwner(input.settings, provider.instanceId)),
  ];
  const sameDriver = ordered.filter((provider) => provider.driver === input.preferred.driver);
  const exact = sameDriver.find((provider) =>
    provider.models.some((model) => model.slug === input.preferred.model),
  );
  if (exact !== undefined) return { instanceId: exact.instanceId, model: input.preferred.model };
  for (const provider of [...sameDriver, ...ordered]) {
    const model = defaultModelOf(provider);
    if (model !== undefined) return { instanceId: provider.instanceId, model };
  }
  return null;
}
