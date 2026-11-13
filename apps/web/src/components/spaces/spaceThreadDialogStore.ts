import type { EnvironmentId, SpaceId, SpaceTaskId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

export type SpaceThreadDialogRequest =
  | {
      readonly type: "start";
      readonly environmentId: EnvironmentId;
      readonly spaceId: SpaceId;
      readonly taskId: SpaceTaskId;
    }
  | {
      /** Add a thread to a task, or move it to another. No thread: pick one of the viewer's. */
      readonly type: "attach";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId | null;
      readonly target: { readonly spaceId: SpaceId; readonly taskId: SpaceTaskId } | null;
      readonly fromTaskId?: SpaceTaskId;
    };

/** Start and attach open from the task page, the thread header and the palette. */
export const useSpaceThreadDialogStore = create<{
  readonly dialog: SpaceThreadDialogRequest | null;
  readonly open: (dialog: SpaceThreadDialogRequest) => void;
  readonly close: () => void;
}>((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
}));

export const openSpaceThreadDialog = (dialog: SpaceThreadDialogRequest) =>
  useSpaceThreadDialogStore.getState().open(dialog);
