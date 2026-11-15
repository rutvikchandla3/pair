import type { CloudMachineSize, SandboxSize } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cloudMachineSizeToSend, forkMachineSizeDefault } from "./machineSize.logic";

const sizes = (teamDefault: SandboxSize): ReadonlyArray<CloudMachineSize> =>
  (["small", "default", "large"] as const).map((size, index) => ({
    size,
    vcpus: 2 ** (index + 1),
    memoryGb: 4 * 2 ** index,
    ...(size === teamDefault ? { default: true as const } : {}),
  }));

describe("cloudMachineSizeToSend", () => {
  it.each([
    { teamDefault: "default", picked: undefined, sent: undefined },
    { teamDefault: "default", picked: "default", sent: undefined },
    { teamDefault: "default", picked: "large", sent: "large" },
    // An admin made Large the default, so asking for Medium must be explicit.
    { teamDefault: "large", picked: "default", sent: "default" },
    { teamDefault: "large", picked: "large", sent: undefined },
  ] as const)("$picked on a $teamDefault team sends $sent", ({ teamDefault, picked, sent }) => {
    expect(cloudMachineSizeToSend(sizes(teamDefault), picked)).toBe(sent);
  });

  it("sends nothing where the environment offers no sizes", () => {
    expect(cloudMachineSizeToSend([], "large")).toBeUndefined();
  });
});

describe("forkMachineSizeDefault", () => {
  it.each([
    { current: "small", expected: "default" },
    { current: "default", expected: "large" },
    { current: "large", expected: "large" },
  ] as const)("steps $current up to $expected", ({ current, expected }) => {
    expect(forkMachineSizeDefault(sizes("default"), current)).toBe(expected);
  });

  it("steps up from the team default when the machine's size is unknown", () => {
    expect(forkMachineSizeDefault(sizes("small"), undefined)).toBe("default");
  });
});
