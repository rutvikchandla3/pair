import { composerBranchOffHint } from "@t3tools/client-runtime/branch-lineage";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { GitBranchIcon, MessageSquareIcon } from "lucide-react";

import { useQuietThreadShell } from "../../state/entities";
import { Button } from "../ui/button";
import { branchOffRoute } from "./branchOffTarget";
import { useBranchOffViewer } from "./useBranchOff";

/**
 * Under the composer on someone else's cloud thread: where a message goes, and the way to work
 * on your own instead. Hidden on your own threads, local threads and solo servers.
 */
export function ComposerBranchOffHint(props: { readonly threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const viewer = useBranchOffViewer(props.threadRef.environmentId);
  const shell = useQuietThreadShell(props.threadRef);
  const hint =
    viewer === null || shell === null ? null : composerBranchOffHint(shell.source, viewer);
  if (hint === null) return null;
  return (
    <div className="flex items-center gap-2 px-1 pt-1.5 text-muted-foreground text-xs">
      <MessageSquareIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{hint.text}</span>
      <span className="shrink-0">{hint.prompt}</span>
      <Button
        size="micro"
        variant="link"
        onClick={() => void navigate(branchOffRoute(props.threadRef))}
      >
        <GitBranchIcon aria-hidden />
        {hint.cta}
      </Button>
    </div>
  );
}
