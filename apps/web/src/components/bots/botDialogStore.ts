import type { BotId, EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

export type BotDialogRequest =
  | { readonly type: "new"; readonly environmentId: EnvironmentId }
  | { readonly type: "edit"; readonly environmentId: EnvironmentId; readonly botId: BotId };

/** One bot dialog at a time, opened from the sidebar, the Bots page, the palette or a bot's menu. */
export const useBotDialogStore = create<{
  readonly dialog: BotDialogRequest | null;
  readonly close: () => void;
}>((set) => ({
  dialog: null,
  close: () => set({ dialog: null }),
}));

export const openBotDialog = (dialog: BotDialogRequest) => useBotDialogStore.setState({ dialog });
