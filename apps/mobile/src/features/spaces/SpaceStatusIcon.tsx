import type { SpaceTaskIcon, SpaceTaskTone } from "@t3tools/client-runtime/spaces";

import { type AppSymbolName, SymbolView } from "../../components/ui/AppSymbol";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";

const SYMBOL: Record<SpaceTaskIcon, AppSymbolName> = {
  "not-started": "circle.dashed",
  working: "circle.inset.filled",
  "needs-answer": "questionmark.bubble",
  "needs-approval": "exclamationmark.shield",
  failed: "exclamationmark.circle",
  limited: "slash.circle",
  stopped: "stop.fill",
  "in-review": PullRequestGlyph.pullRequest,
  done: "checkmark.circle",
};

const TINT: Record<SpaceTaskTone, string> = {
  muted: "accent-icon-muted",
  info: "accent-adaptive-sky-600-400",
  input: "accent-adaptive-indigo-600-300",
  warning: "accent-adaptive-amber-700-400",
  error: "accent-adaptive-red-700-300",
  success: "accent-adaptive-emerald-600-400",
};

/** Static on purpose: a task's status never spins (spaces-prototype README, status icons). */
export function SpaceStatusIcon(props: {
  readonly icon: SpaceTaskIcon;
  readonly tone: SpaceTaskTone;
  readonly label: string;
  readonly size?: number;
}) {
  return (
    <SymbolView
      name={SYMBOL[props.icon]}
      size={props.size ?? 16}
      tintColorClassName={TINT[props.tone]}
      accessibilityLabel={props.label}
    />
  );
}
