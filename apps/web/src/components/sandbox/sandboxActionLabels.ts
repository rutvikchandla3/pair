import type { SandboxAction } from "@t3tools/client-runtime/state/sandbox";

/** The palette names the machine in every item; menus use SANDBOX_ACTION_MENU_LABELS. */
export const SANDBOX_ACTION_PALETTE_LABELS: Readonly<Record<SandboxAction, string>> = {
  wake: "Wake machine",
  sleep: "Sleep machine",
  retry: "Retry machine",
  discard: "Discard machine",
};
