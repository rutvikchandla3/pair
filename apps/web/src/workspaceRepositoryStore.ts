import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

interface WorkspaceRepositoryStoreState {
  /** The repository name a user chose for each workspace thread's git controls. */
  byThreadKey: Record<string, string>;
  select: (ref: ScopedThreadRef, name: string) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

export const useWorkspaceRepositoryStore = create<WorkspaceRepositoryStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      select: (ref, name) =>
        set((state) => ({ byThreadKey: { ...state.byThreadKey, [scopedThreadKey(ref)]: name } })),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey)) return state;
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          return { byThreadKey };
        }),
    }),
    {
      name: "t3code:workspace-repository:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
    },
  ),
);
