import { MemberId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { canSelectProviderInstance } from "./providerInstanceOwnership.ts";

const bob = MemberId.make("member-bob");
const alice = MemberId.make("member-alice");
const bobs = ProviderInstanceId.make("claudeAgent-bob-ab12");
const team = ProviderInstanceId.make("claudeAgent");

describe("canSelectProviderInstance", () => {
  it.each([
    ["anyone picks a team instance", undefined, alice, undefined, team, true],
    ["the owner picks their own", bob, bob, undefined, bobs, true],
    ["another member picks it", bob, alice, undefined, bobs, false],
    ["another member switches back to it", bob, alice, team, bobs, false],
    ["another member stays on it", bob, alice, bobs, bobs, true],
    ["no member picks it", bob, undefined, undefined, bobs, false],
  ] as const)("%s", (_name, ownerMemberId, memberId, currentInstanceId, instanceId, expected) => {
    expect(
      canSelectProviderInstance({ ownerMemberId, memberId, currentInstanceId, instanceId }),
    ).toBe(expected);
  });
});
