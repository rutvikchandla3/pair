import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

interface LineageDialogTarget {
  readonly kind: "offer" | "update";
  /** The branch. */
  readonly threadRef: ScopedThreadRef;
}

/** The chip, header, git menu, palette and keybindings close as they run, so the root hosts it. */
export const lineageDialogAtom = Atom.make<LineageDialogTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("lineage:dialog"),
);

export function openLineageDialog(target: LineageDialogTarget): void {
  appAtomRegistry.set(lineageDialogAtom, target);
}

export function closeLineageDialog(): void {
  appAtomRegistry.set(lineageDialogAtom, null);
}
