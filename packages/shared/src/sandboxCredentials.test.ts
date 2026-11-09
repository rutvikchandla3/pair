import {
  MemberId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  SecretProviderId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  cloudModelDisabledReason,
  pickCloudMoveModel,
  sandboxCredentialSupport,
  type SandboxCredentialSupport,
} from "./sandboxCredentials.ts";

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

describe("cloudModelDisabledReason", () => {
  const claude = ProviderInstanceId.make("claudeWork");
  const providers = [
    { instanceId: claude, driver: ProviderDriverKind.make("claudeAgent") },
    {
      instanceId: ProviderInstanceId.make("cursor"),
      driver: ProviderDriverKind.make("cursor"),
      displayName: "Cursor",
    },
  ];
  const settingsWith = (environment: ReadonlyArray<string>) => ({
    providerInstances: {
      [claude]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        environment: environment.map((name) => ({
          name,
          value: "",
          sensitive: true,
          valueRedacted: true,
        })),
      },
    },
  });

  it.each([
    ["a server-only login", claude, [], /^Local only\. Claude signs in on this server only/],
    ["a setup token", claude, ["CLAUDE_CODE_OAUTH_TOKEN"], null],
    [
      "a driver cloud cannot run",
      ProviderInstanceId.make("cursor"),
      [],
      /^Cursor is not supported/,
    ],
  ] as const)("%s", (_name, instanceId, environment, expected) => {
    const reason = cloudModelDisabledReason(
      { settings: settingsWith(environment), providers },
      instanceId,
    );
    if (expected === null) expect(reason).toBeNull();
    else expect(reason).toMatch(expected);
  });
});

describe("pickCloudMoveModel", () => {
  const kim = MemberId.make("member-kim");
  const ada = MemberId.make("member-ada");
  const token = [variable("CLAUDE_CODE_OAUTH_TOKEN")];
  const provider = (
    instanceId: string,
    driver: ProviderDriverKind,
    slugs: ReadonlyArray<string>,
  ) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    displayName: instanceId,
    enabled: true,
    installed: true,
    models: slugs.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
      ...(index === 1 ? { isDefault: true } : {}),
    })),
  });
  const rows: ReadonlyArray<{
    readonly name: string;
    readonly instances: Record<string, ProviderInstanceConfig>;
    readonly providers: ReadonlyArray<ReturnType<typeof provider>>;
    readonly expected: { readonly instanceId: string; readonly model: string } | null;
  }> = [
    {
      name: "the same driver and model",
      instances: { claude_team: { driver: claude, environment: token } },
      providers: [provider("claude_team", claude, ["sonnet", "opus"])],
      expected: { instanceId: "claude_team", model: "sonnet" },
    },
    {
      name: "the driver's default when the model is gone",
      instances: { claude_team: { driver: claude, environment: token } },
      providers: [provider("claude_team", claude, ["haiku", "opus"])],
      expected: { instanceId: "claude_team", model: "opus" },
    },
    {
      name: "the member's own before a team one",
      instances: {
        claude_team: { driver: claude, environment: token },
        claude_kim: { driver: claude, environment: token, ownerMemberId: kim },
      },
      providers: [
        provider("claude_team", claude, ["sonnet"]),
        provider("claude_kim", claude, ["sonnet"]),
      ],
      expected: { instanceId: "claude_kim", model: "sonnet" },
    },
    {
      name: "another member's instance never",
      instances: { claude_ada: { driver: claude, environment: token, ownerMemberId: ada } },
      providers: [provider("claude_ada", claude, ["sonnet"])],
      expected: null,
    },
    {
      name: "a Local-only instance never, but another driver's default",
      instances: {
        claudeAgent: { driver: claude },
        codex_api: { driver: codex, environment: [variable("OPENAI_API_KEY")] },
      },
      providers: [
        provider("claudeAgent", claude, ["sonnet"]),
        provider("codex_api", codex, ["gpt-5", "gpt-5-codex"]),
      ],
      expected: { instanceId: "codex_api", model: "gpt-5-codex" },
    },
    {
      name: "nothing usable",
      instances: { claudeAgent: { driver: claude } },
      providers: [provider("claudeAgent", claude, ["sonnet"])],
      expected: null,
    },
  ];

  it.each(rows)("$name", ({ instances, providers, expected }) => {
    expect(
      pickCloudMoveModel({
        settings: { providerInstances: instances as never },
        providers,
        memberId: kim,
        preferred: { driver: claude, model: "sonnet" },
      }),
    ).toEqual(expected);
  });
});
