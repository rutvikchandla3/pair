import type { CloudMachineSize, SandboxSize } from "@t3tools/contracts";
import { SANDBOX_SIZE_LABELS, SANDBOX_SIZES } from "@t3tools/shared/sandbox";

const teamDefault = (sizes: ReadonlyArray<CloudMachineSize>) =>
  sizes.find((spec) => spec.default) ?? sizes[0] ?? null;

/** The size a launch gets: the pick when that environment offers it, else its team default. */
export function resolveCloudMachineSize(
  sizes: ReadonlyArray<CloudMachineSize>,
  picked: SandboxSize | undefined,
): CloudMachineSize | null {
  return sizes.find((spec) => spec.size === picked) ?? teamDefault(sizes);
}

/** Sent only off the team default, so the server's own default applies otherwise. */
export function cloudMachineSizeToSend(
  sizes: ReadonlyArray<CloudMachineSize>,
  picked: SandboxSize | undefined,
): SandboxSize | undefined {
  const chosen = resolveCloudMachineSize(sizes, picked);
  return chosen === null || chosen.default ? undefined : chosen.size;
}

/** "Cloud · Large"; a null size leaves the label as it is. */
export const withMachineSize = (label: string, size: SandboxSize | null | undefined): string =>
  size == null ? label : `${label} · ${SANDBOX_SIZE_LABELS[size]}`;

/** A fork usually wants more room: one size up from the machine's own, Large staying Large. */
export function forkMachineSizeDefault(
  sizes: ReadonlyArray<CloudMachineSize>,
  current: SandboxSize | undefined,
): SandboxSize | null {
  const from = current ?? teamDefault(sizes)?.size;
  if (from === undefined) return null;
  const up = SANDBOX_SIZES[Math.min(SANDBOX_SIZES.indexOf(from) + 1, SANDBOX_SIZES.length - 1)];
  return sizes.find((spec) => spec.size === up)?.size ?? from;
}

export const defaultForkBranch = (branch: string): string => `${branch}-fork`;
