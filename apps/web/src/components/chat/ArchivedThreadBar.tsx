import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ArchiveIcon, ArchiveX } from "lucide-react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** In the composer's place on an archived thread, which takes no messages until unarchived. */
export function ArchivedThreadBar(props: {
  readonly threadRef: ScopedThreadRef;
  readonly canUnarchive: boolean;
}) {
  const { unarchiveThread } = useThreadActions();
  const unarchive = async () => {
    const result = await unarchiveThread(props.threadRef);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Failed to unarchive thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };

  return (
    <div className="flex min-h-12 items-center gap-3 rounded-2xl py-2 ps-5 pe-2 text-muted-foreground text-sm">
      <ArchiveIcon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Archived · read-only</span>
      {props.canUnarchive ? (
        <Button size="sm" variant="outline" onClick={() => void unarchive()}>
          <ArchiveX />
          Unarchive
        </Button>
      ) : null}
    </div>
  );
}
