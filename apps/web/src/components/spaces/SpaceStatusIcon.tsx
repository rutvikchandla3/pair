import type { SpaceTaskIcon, SpaceTaskTone } from "@t3tools/client-runtime/spaces";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CircleSlashIcon,
  CircleStopIcon,
  ShieldAlertIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";

const ICONS: Record<SpaceTaskIcon, LucideIcon> = {
  "not-started": CircleDashedIcon,
  working: CircleDotIcon,
  "needs-answer": CircleHelpIcon,
  "needs-approval": ShieldAlertIcon,
  failed: CircleAlertIcon,
  limited: CircleSlashIcon,
  stopped: CircleStopIcon,
  "in-review": PullRequestGlyph.pullRequest,
  done: CircleCheckIcon,
};

const SPACE_TONE_TEXT: Record<SpaceTaskTone, string> = {
  muted: "text-muted-foreground",
  info: "text-info",
  input: "text-input-foreground",
  warning: "text-warning",
  error: "text-error",
  success: "text-success",
};

/** Static on purpose: a working task is a filled dot, never a spinner. */
export function SpaceStatusIcon(props: {
  readonly icon: SpaceTaskIcon;
  readonly tone: SpaceTaskTone;
  readonly label?: string;
}) {
  const Icon = ICONS[props.icon];
  return (
    <Icon
      role={props.label === undefined ? undefined : "img"}
      aria-label={props.label}
      aria-hidden={props.label === undefined}
      className={cn("size-3.5 shrink-0", SPACE_TONE_TEXT[props.tone])}
    />
  );
}
