import type { SpaceMentionToken } from "@t3tools/client-runtime/spaces";
import type { SpaceId } from "@t3tools/contracts";
import { create } from "zustand";

export interface SpaceComposerDraft {
  readonly text: string;
  readonly tokens: ReadonlyArray<SpaceMentionToken>;
}

/** A draft written from outside the room (Settings' Ask), taken once by that room's composer. */
export const useSpaceComposerDraftStore = create<{
  readonly drafts: Readonly<Record<SpaceId, SpaceComposerDraft>>;
  readonly put: (spaceId: SpaceId, draft: SpaceComposerDraft) => void;
  readonly take: (spaceId: SpaceId) => SpaceComposerDraft | null;
}>((set, get) => ({
  drafts: {},
  put: (spaceId, draft) => set({ drafts: { ...get().drafts, [spaceId]: draft } }),
  take: (spaceId) => {
    const draft = get().drafts[spaceId] ?? null;
    if (draft !== null) {
      const { [spaceId]: _taken, ...rest } = get().drafts;
      set({ drafts: rest });
    }
    return draft;
  },
}));
