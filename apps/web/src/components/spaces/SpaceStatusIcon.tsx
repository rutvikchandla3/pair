import type {
  SpaceActivityGlyph,
  SpaceTaskStatusIcon,
  SpaceTone,
} from "@t3tools/client-runtime/spaces";
import {
  CircleAlertIcon,
  CircleDashedIcon,
  GaugeIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  SquareIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";

const SPACE_TONE_TEXT: Record<SpaceTone, string> = {
  muted: "text-muted-foreground",
  info: "text-info",
  input: "text-input-foreground",
  warning: "text-warning",
  error: "text-error",
  success: "text-success",
};

const STATUS_FILL: Partial<Record<SpaceTaskStatusIcon, string>> = {
  half: "M8 4.5a3.5 3.5 0 0 1 0 7z",
  "three-quarter": "M8 4.5a3.5 3.5 0 1 1-3.5 3.5H8z",
};

const STATUS_MARK: Partial<Record<SpaceTaskStatusIcon, string>> = {
  check: "M5.3 8.2l1.8 1.8 3.6-3.8",
  x: "M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2",
};

function a11y(label: string | undefined) {
  return {
    role: label === undefined ? undefined : "img",
    "aria-label": label,
    "aria-hidden": label === undefined,
  };
}

/** A task's stored status: To do, In progress, In review, Done, Canceled. */
export function SpaceTaskStatusGlyph(props: {
  readonly icon: SpaceTaskStatusIcon;
  readonly tone: SpaceTone;
  readonly label?: string;
  readonly className?: string;
}) {
  const className = cn("size-3.5 shrink-0", SPACE_TONE_TEXT[props.tone], props.className);
  const fill = STATUS_FILL[props.icon];
  const mark = STATUS_MARK[props.icon];
  return (
    <svg viewBox="0 0 16 16" fill="none" {...a11y(props.label)} className={className}>
      {mark === undefined ? (
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      ) : (
        <>
          <circle cx="8" cy="8" r="6.75" fill="currentColor" />
          <path
            d={mark}
            stroke="var(--card)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {fill === undefined ? null : <path d={fill} fill="currentColor" />}
    </svg>
  );
}

const ACTIVITY_ICONS: Record<SpaceActivityGlyph, LucideIcon> = {
  working: CircleDashedIcon,
  "needs-answer": MessageCircleQuestionIcon,
  "needs-approval": ShieldQuestionIcon,
  failed: CircleAlertIcon,
  limited: GaugeIcon,
  stopped: SquareIcon,
};

/** Live activity of a task's threads. Static on purpose: working is never a spinner. */
export function SpaceActivityIcon(props: {
  readonly glyph: SpaceActivityGlyph;
  readonly tone: SpaceTone;
  readonly label?: string;
  readonly className?: string;
}) {
  const Icon = ACTIVITY_ICONS[props.glyph];
  return (
    <Icon
      {...a11y(props.label)}
      className={cn(
        "size-3.5 shrink-0",
        SPACE_TONE_TEXT[props.tone],
        props.glyph === "stopped" && "size-3 fill-current",
        props.className,
      )}
    />
  );
}
