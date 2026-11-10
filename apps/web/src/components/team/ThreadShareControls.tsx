import { SHARE_THREAD_OWNER_ONLY_REASON } from "@t3tools/client-runtime/state/sandbox";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { UsersIcon } from "lucide-react";

import { useThreadShare } from "~/state/sandbox";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MemberAvatarStack } from "./MemberAvatarStack";
import { openShareThreadDialog } from "./shareThreadDialogTarget";

/** Beside the title: nothing while private, avatars when shared with people, "Team" for everyone. */
export function ThreadAccessChip({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const chip = useThreadShare(threadRef)?.access.chip ?? null;
  if (chip === null) return null;
  return (
    <Tooltip>
      {chip.kind === "team" ? (
        <TooltipTrigger render={<Badge variant="outline" size="sm" />}>
          <UsersIcon aria-hidden />
          Team
        </TooltipTrigger>
      ) : (
        <TooltipTrigger render={<span aria-label={chip.label} className="inline-flex shrink-0" />}>
          <MemberAvatarStack
            members={chip.shown.map((member) => ({ ...member, away: false }))}
            more={chip.more}
          />
        </TooltipTrigger>
      )}
      <TooltipPopup side="bottom">{chip.label}</TooltipPopup>
    </Tooltip>
  );
}

/** The header's Share: shown on a team's cloud threads, usable only by the owner. */
export function ThreadShareButton({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const share = useThreadShare(threadRef);
  if (share === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!share.allowed}
            onClick={() => openShareThreadDialog(threadRef)}
          />
        }
      >
        <UsersIcon aria-hidden />
        Share
      </TooltipTrigger>
      <TooltipPopup side="top">
        {share.allowed ? "Choose who can open this thread" : SHARE_THREAD_OWNER_ONLY_REASON}
      </TooltipPopup>
    </Tooltip>
  );
}
