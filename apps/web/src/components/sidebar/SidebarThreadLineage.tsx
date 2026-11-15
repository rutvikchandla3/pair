import { FORMER_MEMBER, memberDisplayName } from "@t3tools/client-runtime/state/team";
import type { EnvironmentId, MemberId } from "@t3tools/contracts";
import { GitBranchIcon, GitForkIcon, UsersRoundIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useTeamMembers } from "../../state/team";
import { MemberAvatarStack } from "../team/MemberAvatarStack";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { SidebarThreadLead } from "./SidebarSpaces.logic";

/** A branch's or a space task thread's glyph, before the title; the tooltip says which. */
export function SidebarThreadLeadGlyph(props: {
  readonly glyph: SidebarThreadLead["glyph"];
  readonly label: string;
}) {
  const Icon = props.glyph === "space" ? UsersRoundIcon : GitBranchIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span role="img" aria-label={props.label} className="inline-flex shrink-0 items-center" />
        }
      >
        <Icon aria-hidden className="size-3.5 text-muted-foreground" />
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** ⑂ and who branched this thread; indigo while offers to it wait on its owner. */
export function SidebarThreadBranches(props: {
  readonly environmentId: EnvironmentId;
  /** Member ids joined with commas, as `sidebarBranchOwnersBySource` builds them. */
  readonly ownerIds: string;
  readonly offers: boolean;
}) {
  const members = useTeamMembers(props.environmentId);
  const branchers = props.ownerIds.split(",").map((raw) => {
    const id = raw as MemberId;
    const member = members.get(id) ?? FORMER_MEMBER;
    return { id, name: member.name, color: member.color, away: false };
  });
  const names = branchers.map((member) => memberDisplayName(members, member.id)).join(", ");
  const label = props.offers ? `Branched by ${names} · changes offered` : `Branched by ${names}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className="inline-flex shrink-0 items-center gap-0.5"
          />
        }
      >
        <GitForkIcon
          aria-hidden
          className={cn("size-3", props.offers ? "text-input-foreground" : "text-muted-foreground")}
        />
        <MemberAvatarStack members={branchers} max={2} size="sm" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
