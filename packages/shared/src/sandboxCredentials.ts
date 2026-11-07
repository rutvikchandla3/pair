import type { ProviderInstanceConfig, ProviderInstanceId } from "@t3tools/contracts";

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
