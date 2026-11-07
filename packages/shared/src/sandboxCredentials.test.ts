import {
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  SecretProviderId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { sandboxCredentialSupport, type SandboxCredentialSupport } from "./sandboxCredentials.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const variable = (name: string) => ({ name, value: "", sensitive: true, valueRedacted: true });
const claudeLocalOnly: SandboxCredentialSupport = {
  _tag: "LocalOnly",
  reason: "Claude signs in on this server only. Add a setup token or API key to use it in cloud.",
};
const codexLocalOnly: SandboxCredentialSupport = {
  _tag: "LocalOnly",
  reason:
    "This Codex account signs in on this server only. Use a managed ChatGPT account or an API key in cloud.",
};

describe("sandboxCredentialSupport", () => {
  const rows: ReadonlyArray<
    readonly [string, string, ProviderInstanceConfig, SandboxCredentialSupport]
  > = [
    [
      "a member's Claude setup token",
      "claude_member-ada",
      { driver: claude, environment: [variable("CLAUDE_CODE_OAUTH_TOKEN")] },
      { _tag: "Ready", mechanism: "claude-setup-token" },
    ],
    [
      "an admin Claude instance with a secret-reference token",
      "claudeAgent",
      {
        driver: claude,
        environment: [
          {
            name: "CLAUDE_CODE_OAUTH_TOKEN",
            value: { provider: SecretProviderId.make("vault"), reference: "op://team/claude" },
            sensitive: true,
          },
        ],
      },
      { _tag: "Ready", mechanism: "claude-setup-token" },
    ],
    [
      "a Claude API key",
      "claude_work",
      { driver: claude, environment: [variable("HTTPS_PROXY"), variable("ANTHROPIC_API_KEY")] },
      { _tag: "Ready", mechanism: "claude-api-key" },
    ],
    ["the default Claude login", "claudeAgent", { driver: claude }, claudeLocalOnly],
    ["an empty environment", "claudeAgent", { driver: claude, environment: [] }, claudeLocalOnly],
    [
      "Claude through a gateway or Bedrock only",
      "claude_gateway",
      {
        driver: claude,
        environment: [
          variable("ANTHROPIC_AUTH_TOKEN"),
          variable("ANTHROPIC_BASE_URL"),
          variable("CLAUDE_CODE_USE_BEDROCK"),
        ],
      },
      claudeLocalOnly,
    ],
    [
      "a managed Codex account, even beside an API key",
      "codex_member-ada",
      {
        driver: codex,
        config: { setupMode: "managed" },
        environment: [variable("OPENAI_API_KEY")],
      },
      { _tag: "Ready", mechanism: "codex-managed" },
    ],
    [
      "a Codex API key",
      "codex_api",
      {
        driver: codex,
        config: { setupMode: "existing" },
        environment: [variable("OPENAI_API_KEY")],
      },
      { _tag: "Ready", mechanism: "codex-api-key" },
    ],
    ["the server's Codex login", "codex", { driver: codex }, codexLocalOnly],
    [
      "Replay (dev)",
      "devReplay",
      { driver: ProviderDriverKind.make("acpRegistry") },
      { _tag: "Ready", mechanism: "none" },
    ],
    [
      "another ACP agent",
      "copilot",
      { driver: ProviderDriverKind.make("acpRegistry") },
      { _tag: "Unsupported" },
    ],
    [
      "Cursor, even with a key",
      "cursor",
      { driver: ProviderDriverKind.make("cursor"), environment: [variable("CURSOR_API_KEY")] },
      { _tag: "Unsupported" },
    ],
  ];

  it.each(rows)("%s", (_name, instanceId, instance, expected) => {
    expect(
      sandboxCredentialSupport({ instanceId: ProviderInstanceId.make(instanceId), instance }),
    ).toEqual(expected);
  });
});
