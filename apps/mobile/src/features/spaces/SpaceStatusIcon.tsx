import type {
  SpaceActivityGlyph as SpaceActivityGlyphName,
  SpaceTaskStatusIcon as SpaceTaskStatusIconName,
  SpaceTone,
} from "@t3tools/client-runtime/spaces";
import Svg, { Circle, Path } from "react-native-svg";
import { withUniwind } from "uniwind";

import { type AppSymbolName, SymbolView } from "../../components/ui/AppSymbol";

const ThemedSvg = withUniwind(Svg);

const TINT: Record<SpaceTone, string> = {
  muted: "accent-icon-muted",
  info: "accent-adaptive-sky-600-400",
  input: "accent-adaptive-indigo-600-300",
  warning: "accent-adaptive-amber-700-400",
  error: "accent-adaptive-red-700-300",
  success: "accent-adaptive-emerald-600-400",
};

/** A task's stored status: an empty, half, three-quarter, checked or crossed circle. */
export function SpaceTaskStatusIcon(props: {
  readonly icon: SpaceTaskStatusIconName;
  readonly tone: SpaceTone;
  readonly label: string;
  readonly size?: number;
}) {
  const size = props.size ?? 16;
  return (
    <ThemedSvg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      colorClassName={TINT[props.tone]}
      accessibilityLabel={props.label}
      accessible
    >
      {props.icon === "check" || props.icon === "x" ? (
        <>
          <Circle cx={8} cy={8} r={7} fill="currentColor" />
          <Path
            d={
              props.icon === "check"
                ? "M4.8 8.2l2.1 2.1 4.3-4.4"
                : "M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8"
            }
            stroke="white"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <Circle cx={8} cy={8} r={6.25} stroke="currentColor" strokeWidth={1.5} />
          {props.icon === "half" ? (
            <Path d="M8 4.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" />
          ) : null}
          {props.icon === "three-quarter" ? (
            <Path d="M8 4.5a3.5 3.5 0 1 1-3.5 3.5H8z" fill="currentColor" />
          ) : null}
        </>
      )}
    </ThemedSvg>
  );
}

const GLYPH: Record<SpaceActivityGlyphName, AppSymbolName> = {
  working: "circle.dashed",
  "needs-answer": "questionmark.bubble",
  "needs-approval": "exclamationmark.shield",
  failed: "exclamationmark.circle",
  limited: "slash.circle",
  stopped: "stop.fill",
};

/** Live activity from a task's threads. Static on purpose: nothing here spins. */
export function SpaceActivityGlyph(props: {
  readonly glyph: SpaceActivityGlyphName;
  readonly tone: SpaceTone;
  readonly size?: number;
}) {
  return (
    <SymbolView
      name={GLYPH[props.glyph]}
      size={props.size ?? 12}
      tintColorClassName={TINT[props.tone]}
    />
  );
}

export function spaceToneTextClass(tone: SpaceTone): string {
  switch (tone) {
    case "muted":
      return "text-foreground-muted";
    case "info":
      return "text-adaptive-sky-600-400";
    case "input":
      return "text-adaptive-indigo-600-300";
    case "warning":
      return "text-adaptive-amber-700-400";
    case "error":
      return "text-adaptive-red-700-300";
    case "success":
      return "text-adaptive-emerald-600-400";
  }
}
