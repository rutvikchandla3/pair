import { describe, expect, it } from "@effect/vitest";
import {
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  providerOwnedReason,
  ThreadManagementProviderInstanceDisabledError,
} from "../orchestration-v2/ThreadManagementService.ts";
import { sandboxCredentialSupport } from "@t3tools/shared/sandboxCredentials";
import { ProviderCloudLocalOnlyError, ProviderCloudUnsupportedError } from "./Errors.ts";
import { isModelSelectionRefusal, modelSelectionProblem } from "./modelSelectionCheck.ts";
import { readyProvider } from "./ProviderRegistry.testkit.ts";

const claude = (
  instanceId: string,
  displayName: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider =>
  readyProvider(instanceId, {
    displayName,
    models: [
      {
        slug: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        aliases: ["opus"],
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: ["low", "medium", "high", "xhigh"].map((id) => ({ id, label: id })),
            },
            { id: "fastMode", label: "Fast", type: "boolean" },
          ],
        },
      },
      { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5", isCustom: false, capabilities: null },
      {
        slug: "claude-opus-4",
        name: "Claude Opus 4",
        isLegacy: true,
        isCustom: false,
        capabilities: null,
      },
    ],
    ...overrides,
  } as Partial<ServerProvider>);

const many = Array.from({ length: 10 }, (_, index) => ({
  slug: `model-${index}`,
  name: `model-${index}`,
  isCustom: false,
  capabilities: null,
}));

const providers = [
  claude("claudeAgent-rutvik-916a", "HA"),
  claude("big", "Big", { models: many } as Partial<ServerProvider>),
  claude("claudeAgent-rutvik-3c9d", "HAP"),
  claude("claudeAgent", "Claude", { auth: { status: "unauthenticated" } }),
  claude("custom", "Custom", { models: [] }),
];
const adapterInstanceIds = new Set(providers.map((provider) => provider.instanceId));

const check = (selection: { instanceId: string; model: string; options?: unknown }) =>
  modelSelectionProblem({
    providers,
    adapterInstanceIds,
    selection: selection as ModelSelection,
  });

/** Why a signed-in-here account of `driver` can't run in the cloud. */
const localOnlyReason = (driver: "claudeAgent" | "codex"): string => {
  const support = sandboxCredentialSupport({
    instanceId: ProviderInstanceId.make(driver),
    instance: { driver: ProviderDriverKind.make(driver) },
  });
  if (support._tag !== "LocalOnly") throw new Error(`${driver} is not local-only`);
  return support.reason;
};

describe("modelSelectionProblem", () => {
  it("accepts an instance that can run, its model and a valid effort", () => {
    expect(
      check({
        instanceId: "claudeAgent-rutvik-916a",
        model: "claude-opus-5-5",
        // An option the model doesn't declare passes through, as threads keep it.
        options: [
          { id: "effort", value: "xhigh" },
          { id: "fromAnotherVersion", value: 1 },
        ],
      }),
    ).toBeNull();
    expect(check({ instanceId: "claudeAgent-rutvik-916a", model: "opus" })).toBeNull();
    // An instance that lists no models takes any id, as delegate_task does.
    expect(check({ instanceId: "custom", model: "anything" })).toBeNull();
  });

  it("names what would work for each refusal", () => {
    const runnable =
      "Ones that can run: HA (claudeAgent-rutvik-916a), Big (big), HAP (claudeAgent-rutvik-3c9d), Custom (custom).";
    expect(check({ instanceId: "nope", model: "claude-opus-5-5" })).toBe(
      `No provider instance "nope" here. ${runnable}`,
    );
    expect(check({ instanceId: "claudeAgent", model: "claude-opus-5-5" })).toBe(
      `Claude (claudeAgent) can't run here: Provider is not authenticated. ${runnable}`,
    );
    expect(check({ instanceId: "claudeAgent-rutvik-916a", model: "gpt-5" })).toBe(
      'HA (claudeAgent-rutvik-916a) has no model "gpt-5". Its models: claude-opus-5-5 (Claude Opus 5.5), claude-haiku-5-5 (Claude Haiku 5.5).',
    );
    expect(check({ instanceId: "big", model: "gpt-5" })).toBe(
      'Big (big) has no model "gpt-5". Its models: model-0, model-1, model-2, model-3, model-4, model-5, model-6, model-7 and 2 more.',
    );
    expect(
      check({
        instanceId: "claudeAgent-rutvik-916a",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "huge" }],
      }),
    ).toBe(
      "claude-opus-5-5 on HA rejected options: Option effort must be one of: low, medium, high, xhigh.",
    );
    expect(
      check({
        instanceId: "claudeAgent-rutvik-916a",
        model: "claude-opus-5-5",
        options: [{ id: "fastMode", value: "yes" }],
      }),
    ).toBe("claude-opus-5-5 on HA rejected options: Option fastMode expects a boolean value.");
    expect(
      check({
        instanceId: "claudeAgent-rutvik-916a",
        model: "claude-opus-5-5",
        options: [
          { id: "fromAnotherVersion", value: 1 },
          { id: "fromAnotherVersion", value: 2 },
        ],
      }),
    ).toBe(
      "claude-opus-5-5 on HA rejected options: Option fromAnotherVersion was specified more than once.",
    );
  });

  it("recognises each of its refusals, as a forwarder prefixes them", () => {
    const refusals = [
      check({ instanceId: "nope", model: "claude-opus-5-5" }),
      check({ instanceId: "claudeAgent", model: "claude-opus-5-5" }),
      check({ instanceId: "claudeAgent-rutvik-916a", model: "gpt-5" }),
      check({
        instanceId: "claudeAgent-rutvik-916a",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "huge" }],
      }),
      // A snapshot without a display name is named by its id alone.
      modelSelectionProblem({
        providers: [readyProvider("codex", { installed: false })],
        adapterInstanceIds,
        selection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      }),
      // What a launch refuses with after the check, and all a 0.1.7-pair.36 server sends.
      new ProviderCloudUnsupportedError({ threadId: "", driver: "pi" }).message,
      new ProviderCloudLocalOnlyError({
        instanceId: "claudeAgent",
        reason: localOnlyReason("claudeAgent"),
      }).message,
      new ProviderCloudLocalOnlyError({ instanceId: "codex", reason: localOnlyReason("codex") })
        .message,
      new ThreadManagementProviderInstanceDisabledError({
        projectId: ProjectId.make("project:there"),
        instanceId: ProviderInstanceId.make("pi"),
      }).message,
      new ThreadManagementProviderInstanceDisabledError({
        projectId: ProjectId.make("project:there"),
        instanceId: ProviderInstanceId.make("claudeAgent-piyush-eff7"),
        reason: providerOwnedReason("Piyush's Claude", "Piyush"),
      }).message,
    ];
    for (const refusal of refusals) {
      expect(isModelSelectionRefusal(`Could not start the session on Pair Cloud: ${refusal}`)).toBe(
        true,
      );
    }
    expect(isModelSelectionRefusal("The base branch fix/x is not on origin.")).toBe(false);
  });

  it("refuses an instance with no V2 adapter", () => {
    expect(
      modelSelectionProblem({
        providers,
        adapterInstanceIds: new Set(),
        selection: {
          instanceId: ProviderInstanceId.make("claudeAgent-rutvik-916a"),
          model: "claude-opus-5-5",
        },
      }),
    ).toBe(
      "HA (claudeAgent-rutvik-916a) can't run here: No V2 provider adapter is registered. No provider instance here can run threads.",
    );
  });
});
