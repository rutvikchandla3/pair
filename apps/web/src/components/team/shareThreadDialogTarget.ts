import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

/** As the assign picker: the menu, palette and keybinding close as they run, so the root hosts it. */
export const shareThreadDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("team:share-thread-dialog-thread"),
);

export function openShareThreadDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(shareThreadDialogThreadAtom, threadRef);
}
