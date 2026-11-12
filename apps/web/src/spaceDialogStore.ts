import type { EnvironmentId, MemberId, SpaceId } from "@t3tools/contracts";
import { create } from "zustand";

export type SpaceDialogRequest =
  | { readonly type: "new-space"; readonly environmentId: EnvironmentId | null }
  | {
      readonly type: "new-task";
      readonly environmentId: EnvironmentId;
      readonly spaceId: SpaceId;
      readonly ownerId?: MemberId;
    }
  | { readonly type: "settings"; readonly environmentId: EnvironmentId; readonly spaceId: SpaceId };

/** One space dialog at a time, opened from the room, the sidebar, the palette or a shortcut. */
export const useSpaceDialogStore = create<{
  readonly dialog: SpaceDialogRequest | null;
  readonly open: (dialog: SpaceDialogRequest) => void;
  readonly close: () => void;
}>((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
}));

export const openSpaceDialog = (dialog: SpaceDialogRequest) =>
  useSpaceDialogStore.getState().open(dialog);
