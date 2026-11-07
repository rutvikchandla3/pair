import type { SandboxAction } from "@t3tools/client-runtime/state/sandbox";

/** The thread menu's words; the palette names the machine in every item instead. */
export const SANDBOX_ACTION_MENU_LABELS: Readonly<Record<SandboxAction, string>> = {
  wake: "Wake machine",
  sleep: "Sleep now",
  retry: "Retry machine",
  discard: "Discard machine",
};

export const SANDBOX_ACTION_PALETTE_LABELS: Readonly<Record<SandboxAction, string>> = {
  wake: "Wake machine",
  sleep: "Sleep machine",
  retry: "Retry machine",
  discard: "Discard machine",
};

export const SANDBOX_OWNER_ONLY_REASON = "Only the owner or an admin";

export const SANDBOX_DISCARD_CONFIRMATION =
  "Discard this machine? Its disk is deleted; transcript and diffs stay.";

export const SANDBOX_ACTION_FAILURE_TITLES: Readonly<Record<SandboxAction, string>> = {
  wake: "Could not wake the machine",
  sleep: "Could not put the machine to sleep",
  retry: "Could not retry the machine",
  discard: "Could not discard the machine",
};
