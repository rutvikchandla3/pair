import type { ContinueInCloudOffer } from "@t3tools/client-runtime/state/cloud-target";
import {
  SANDBOX_ACTION_MENU_LABELS,
  SANDBOX_OWNER_ONLY_REASON,
  type SandboxAction,
  type SandboxThreadMachine,
} from "@t3tools/client-runtime/state/sandbox";

import { CONTINUE_IN_CLOUD_LABEL } from "@t3tools/client-runtime/state/threadMove";

import type { AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";

const ACTION_ICONS: Readonly<Record<SandboxAction, string>> = {
  wake: "sun.max",
  sleep: "moon",
  retry: "arrow.clockwise",
  discard: "trash",
};

/** The machine's actions; owner-only ones a member may not run stay listed, disabled with why. */
function buildThreadMachineMenuItems(
  machine: Pick<SandboxThreadMachine, "actions" | "ownerOnlyDenied">,
  run: (action: SandboxAction) => void,
): AppBarMenuItem[] {
  return machine.actions.map((action) => {
    const denied = machine.ownerOnlyDenied.includes(action);
    return {
      id: `machine:${action}`,
      title: SANDBOX_ACTION_MENU_LABELS[action],
      icon: ACTION_ICONS[action],
      ...(denied ? { disabled: true, subtitle: SANDBOX_OWNER_ONLY_REASON } : {}),
      onPress: () => run(action),
    };
  });
}

/** The thread header's Machine menu, beside Team; null when the machine offers nothing. */
export function buildThreadMachineHeaderMenu(
  machine: SandboxThreadMachine,
  run: (action: SandboxAction) => void,
): AppBarMenu | null {
  const items = buildThreadMachineMenuItems(machine, run);
  if (items.length === 0) return null;
  return {
    title: "Machine",
    icon: "cloud",
    ...(machine.presentation.label === null ? {} : { status: machine.presentation.label }),
    items,
  };
}

/** The Cloud menu of a thread on the member's own computer; null when no Pair Cloud can take it. */
export function buildThreadCloudHeaderMenu(
  offer: ContinueInCloudOffer,
  open: () => void,
): AppBarMenu | null {
  if (offer.kind === "hidden") return null;
  return {
    title: "Cloud",
    icon: "icloud.and.arrow.up",
    items: [
      {
        id: "continue-in-cloud",
        title: `${CONTINUE_IN_CLOUD_LABEL}…`,
        icon: "icloud.and.arrow.up",
        ...(offer.kind === "disabled" ? { disabled: true, subtitle: offer.reason } : {}),
        onPress: open,
      },
    ],
  };
}
