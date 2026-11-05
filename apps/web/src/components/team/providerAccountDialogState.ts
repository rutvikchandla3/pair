import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * Whether Settings → Team shows the add-account dialog. The command palette and the model picker
 * close as they navigate there, so the section renders the dialog once.
 */
export const addProviderAccountDialogOpenAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("provider-accounts:add-dialog-open"),
);

export function setAddProviderAccountDialogOpen(open: boolean): void {
  appAtomRegistry.set(addProviderAccountDialogOpenAtom, open);
}
