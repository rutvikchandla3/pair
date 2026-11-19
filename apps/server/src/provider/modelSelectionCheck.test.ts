import { describe, expect, it } from "@effect/vitest";
import { type ModelSelection, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { modelSelectionProblem } from "./modelSelectionCheck.ts";
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
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: ["low", "medium", "high", "xhigh"].map((id) => ({ id, label: id })),
            },
          ],
        },
      },
      { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5", isCustom: false, capabilities: null },
    ],
    ...overrides,
  } as Partial<ServerProvider>);

const providers = [
  claude("claudeAgent-rutvik-916a", "HA"),
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

describe("modelSelectionProblem", () => {
  it("accepts an instance that can run, its model and a valid effort", () => {
    expect(
      check({
        instanceId: "claudeAgent-rutvik-916a",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "xhigh" }],
      }),
    ).toBeNull();
    // An instance that lists no models takes any id, as delegate_task does.
    expect(check({ instanceId: "custom", model: "anything" })).toBeNull();
  });

  it("names what would work for each refusal", () => {
    const runnable =
      "Ones that can run: HA (claudeAgent-rutvik-916a), HAP (claudeAgent-rutvik-3c9d), Custom (custom).";
    expect(check({ instanceId: "nope", model: "claude-opus-5-5" })).toBe(
      `No provider instance "nope" here. ${runnable}`,
    );
    expect(check({ instanceId: "claudeAgent", model: "claude-opus-5-5" })).toBe(
      `Claude (claudeAgent) can't run here: Provider is not authenticated. ${runnable}`,
    );
    expect(check({ instanceId: "claudeAgent-rutvik-916a", model: "gpt-5" })).toBe(
      'HA (claudeAgent-rutvik-916a) has no model "gpt-5". Its models: claude-opus-5-5 (Claude Opus 5.5), claude-haiku-5-5 (Claude Haiku 5.5).',
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
