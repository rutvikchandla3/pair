import { useAtomValue } from "@effect/atom-react";
import { activeTeamMembers } from "@t3tools/client-runtime/state/team";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useThreadShell } from "~/state/entities";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useTeamMembers } from "~/state/team";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { CommandPaletteResults } from "../CommandPaletteResults";
import { CommandDialog, CommandDialogPopup } from "../ui/command";
import { MemberAvatar } from "./MemberAvatar";
import { toastCommandFailure } from "./toastCommandFailure";

/**
 * Which thread has the member picker open. The thread menu, the command palette and the
 * keybinding all close as they run, so the app root renders the picker once.
 */
const assignThreadDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("team:assign-thread-dialog-thread"),
);

export function openAssignThreadDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(assignThreadDialogThreadAtom, threadRef);
}

export function AssignThreadDialogHost() {
  const threadRef = useAtomValue(assignThreadDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <AssignThreadDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(assignThreadDialogThreadAtom, null)}
    />
  );
}

function AssignThreadDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const members = useTeamMembers(threadRef.environmentId);
  const ownerId = useThreadShell(threadRef)?.source.ownerId ?? null;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const setOwner = useOrchestrationCommand(threadEnvironment.setOwner, { reportFailure: false });
  const needle = query.trim().toLowerCase();
  const items: CommandPaletteActionItem[] = activeTeamMembers(members)
    .filter((member) => member.name.toLowerCase().includes(needle))
    .map((member) => ({
      kind: "action",
      value: `assign:${member.id}`,
      searchTerms: [member.name],
      title: member.name,
      icon: <MemberAvatar member={member} size="sm" />,
      titleTrailingContent:
        member.id === ownerId ? (
          <CheckIcon aria-label="Current owner" className="size-3.5 text-muted-foreground" />
        ) : null,
      run: async () => {
        if (member.id === ownerId) return;
        const result = await setOwner({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, ownerId: member.id },
        });
        toastCommandFailure("Could not assign the thread", result);
      },
    }));

  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <CommandDialogPopup
        aria-label="Assign thread to"
        className="overflow-hidden"
        onBackdropPointerDown={onClose}
      >
        <CommandPaletteContent
          aria-label="Assign thread to"
          autoHighlight="always"
          escapeLabel="Close"
          footerActionLabel="Assign"
          inputProps={{ placeholder: "Assign to…" }}
          mode="none"
          onItemHighlighted={(value) => {
            setHighlightedItemValue(typeof value === "string" ? value : null);
          }}
          onValueChange={(value) => {
            setHighlightedItemValue(null);
            setQuery(value);
          }}
          testId="assign-thread-picker"
          value={query}
        >
          <CommandPaletteResults
            groups={items.length > 0 ? [{ value: "assign-members", label: "Members", items }] : []}
            highlightedItemValue={highlightedItemValue}
            isActionsOnly={false}
            keybindings={keybindings}
            onExecuteItem={(item) => {
              if (item.kind !== "action") return;
              onClose();
              void item.run();
            }}
            emptyStateMessage="No matching members."
          />
        </CommandPaletteContent>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
