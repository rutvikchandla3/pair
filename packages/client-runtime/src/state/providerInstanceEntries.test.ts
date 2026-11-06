import {
  DEFAULT_SERVER_SETTINGS,
  MemberId,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveTeamNewThreadModelSelection } from "./providerInstanceEntries.ts";

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  models: ReadonlyArray<string>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: {} })),
    slashCommands: [],
    skills: [],
  };
}

describe("resolveTeamNewThreadModelSelection", () => {
  const alice = MemberId.make("member-alice");
  const bob = MemberId.make("member-bob");
  const claude = ProviderDriverKind.make("claudeAgent");
  const codex = ProviderDriverKind.make("codex");
  const providers = [
    provider({ instanceId: "claudeAgent", provider: claude, models: ["sonnet", "opus"] }),
    provider({ instanceId: "claude_alice", provider: claude, models: ["sonnet", "opus"] }),
    provider({ instanceId: "claude_bob", provider: claude, models: ["sonnet"] }),
    provider({ instanceId: "codex", provider: codex, models: ["gpt-6"] }),
  ];
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [ProviderInstanceId.make("claude_alice")]: { driver: claude, ownerMemberId: alice },
      [ProviderInstanceId.make("claude_bob")]: { driver: claude, ownerMemberId: bob },
    },
  };
  const pick = (instanceId: string, model: string): ModelSelection => ({
    instanceId: ProviderInstanceId.make(instanceId),
    model,
  });

  it.each([
    ["solo leaves the selection", null, pick("claude_bob", "sonnet"), null],
    ["swaps the team default to her own", alice, null, pick("claude_alice", "sonnet")],
    [
      "swaps a sticky team pick, keeping the model",
      alice,
      pick("claudeAgent", "opus"),
      pick("claude_alice", "opus"),
    ],
    ["does not swap across drivers", alice, pick("codex", "gpt-6"), null],
    ["keeps her own pick", alice, pick("claude_alice", "opus"), null],
    [
      "leaves the team default to someone without an account",
      MemberId.make("member-carol"),
      null,
      null,
    ],
    [
      "drops someone else's sticky pick for the project default",
      MemberId.make("member-carol"),
      pick("claude_bob", "sonnet"),
      pick("claudeAgent", "sonnet"),
    ],
    [
      "drops someone else's carried pick, then swaps",
      alice,
      pick("claude_bob", "sonnet"),
      pick("claude_alice", "sonnet"),
    ],
  ] as const)("%s", (_label, memberId, selection, expected) => {
    expect(
      resolveTeamNewThreadModelSelection({
        selection,
        providers,
        settings,
        projectId: null,
        memberId,
      }),
    ).toEqual(expected);
  });

  it("never leaves a teammate's account as the composer's own default", () => {
    // Without a driver's default instance, entries keep server order, so a teammate's can lead.
    const replay = ProviderDriverKind.make("acpRegistry");
    const listed = [
      provider({ instanceId: "replay_bob", provider: replay, models: ["showcase"] }),
      provider({ instanceId: "devReplay", provider: replay, models: ["showcase"] }),
    ];
    const owned = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("replay_bob")]: { driver: replay, ownerMemberId: bob },
        [ProviderInstanceId.make("devReplay")]: { driver: replay },
      },
    };
    const resolve = (memberId: MemberId) =>
      resolveTeamNewThreadModelSelection({
        selection: null,
        providers: listed,
        settings: owned,
        projectId: null,
        memberId,
      });
    expect(resolve(alice)).toEqual(pick("devReplay", "showcase"));
    expect(resolve(bob)).toBeNull();
  });
});
