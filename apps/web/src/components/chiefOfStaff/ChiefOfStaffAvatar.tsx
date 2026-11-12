import type { ChiefOfStaffAvatarSize, ChiefOfStaffAvatarStyle } from "@t3tools/contracts";
import type { CSSProperties, ReactNode } from "react";

import { chiefOfStaffLevelTarget } from "../../chiefOfStaff/audioLevel";
import { isChiefOfStaffLive, type ChiefOfStaffPhase } from "../../chiefOfStaff/chiefOfStaff.logic";
import { cn } from "../../lib/utils";

export const CHIEF_OF_STAFF_AVATAR_PIXELS: Readonly<Record<ChiefOfStaffAvatarSize, number>> = {
  small: 16,
  medium: 20,
  large: 24,
};

export const CHIEF_OF_STAFF_AVATAR_LABELS: Readonly<Record<ChiefOfStaffAvatarStyle, string>> = {
  pet: "Pet",
  orb: "Orb",
  bot: "Bot",
  dots: "Dots",
  wave: "Wave",
};

const BACKGROUND = "var(--background)";

/** Scales a shape about its own centre by `base + level * gain`; the level is 0 outside a session. */
function follow(axis: "both" | "x" | "y", base: number, gain: number): CSSProperties {
  const factor = `calc(${base} + var(--cos-level, 0) * ${gain})`;
  return {
    transformBox: "fill-box",
    transformOrigin: "center",
    transform:
      axis === "both"
        ? `scale(${factor})`
        : axis === "x"
          ? `scaleX(${factor})`
          : `scaleY(${factor})`,
  };
}

type Look = (phase: ChiefOfStaffPhase) => ReactNode;

const pet: Look = (phase) => {
  const awake = isChiefOfStaffLive(phase);
  const eyeY = phase === "thinking" ? 11.5 : 12.5;
  return (
    <>
      <circle cx="6.5" cy="7" r="2.6" fill="currentColor" opacity={awake ? 1 : 0.8} />
      <circle cx="17.5" cy="7" r="2.6" fill="currentColor" opacity={awake ? 1 : 0.8} />
      <rect
        x="3"
        y="6"
        width="18"
        height="15"
        rx="7.5"
        fill="currentColor"
        style={phase === "listening" ? follow("both", 1, 0.08) : undefined}
      />
      {awake ? (
        <>
          <ellipse cx="9" cy={eyeY} rx="1.4" ry="1.8" fill={BACKGROUND} />
          <ellipse cx="15" cy={eyeY} rx="1.4" ry="1.8" fill={BACKGROUND} />
        </>
      ) : (
        <path
          d="M7.6 13h2.8M13.6 13h2.8"
          stroke={BACKGROUND}
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      )}
      <ellipse
        cx="12"
        cy="17"
        rx="1.7"
        ry="1"
        fill={BACKGROUND}
        style={phase === "speaking" ? follow("y", 0.4, 2.2) : { opacity: awake ? 1 : 0 }}
      />
    </>
  );
};

const orb: Look = (phase) => (
  <>
    <circle
      cx="12"
      cy="12"
      r="10.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      opacity={phase === "listening" || phase === "speaking" ? 0.5 : 0}
      style={follow("both", 0.85, 0.3)}
    />
    <circle
      cx="12"
      cy="12"
      r="7.5"
      fill="currentColor"
      opacity={phase === "listening" ? 0.75 : 1}
      style={phase === "speaking" ? follow("both", 1, 0.15) : undefined}
    />
    <circle cx="9.5" cy="9.5" r="2" fill={BACKGROUND} opacity="0.35" />
  </>
);

const bot: Look = (phase) => {
  const awake = isChiefOfStaffLive(phase);
  return (
    <>
      <path d="M12 2.8v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle
        cx="12"
        cy="2.4"
        r="1.4"
        fill="currentColor"
        style={phase === "listening" ? follow("both", 1, 0.6) : undefined}
      />
      <rect x="3.5" y="5.5" width="17" height="14.5" rx="4" fill="currentColor" />
      <rect
        x="7.5"
        y="10"
        width="2.6"
        height="3"
        rx="0.8"
        fill={BACKGROUND}
        style={
          awake ? (phase === "thinking" ? follow("y", 0.35, 0) : undefined) : follow("y", 0.3, 0)
        }
      />
      <rect
        x="13.9"
        y="10"
        width="2.6"
        height="3"
        rx="0.8"
        fill={BACKGROUND}
        style={
          awake ? (phase === "thinking" ? follow("y", 0.35, 0) : undefined) : follow("y", 0.3, 0)
        }
      />
      <rect
        x="8.5"
        y="15.5"
        width="7"
        height="1.6"
        rx="0.8"
        fill={BACKGROUND}
        style={phase === "speaking" ? follow("x", 0.4, 1) : follow("x", 0.6, 0)}
      />
    </>
  );
};

const DOTS = [
  { x: 5, gain: 0.5 },
  { x: 12, gain: 0.9 },
  { x: 19, gain: 0.5 },
] as const;

const dots: Look = (phase) => (
  <>
    {DOTS.map(({ x, gain }) => (
      <circle
        key={x}
        cx={x}
        cy="12"
        r="2.6"
        fill="currentColor"
        opacity={phase === "listening" && x !== 12 ? 0.7 : 1}
        style={follow("both", 1, phase === "speaking" ? gain : gain * 0.6)}
      />
    ))}
  </>
);

const BARS = [
  { x: 2.5, gain: 1.2 },
  { x: 6.5, gain: 2.4 },
  { x: 10.5, gain: 3.4 },
  { x: 14.5, gain: 2.4 },
  { x: 18.5, gain: 1.2 },
] as const;

const wave: Look = (phase) => (
  <>
    {BARS.map(({ x, gain }) => (
      <rect
        key={x}
        x={x}
        y="9.5"
        width="2.4"
        height="5"
        rx="1.2"
        fill="currentColor"
        opacity={phase === "listening" ? 0.8 : 1}
        style={follow("y", isChiefOfStaffLive(phase) ? 1 : 0.6, gain)}
      />
    ))}
  </>
);

const LOOKS: Readonly<Record<ChiefOfStaffAvatarStyle, Look>> = { pet, orb, bot, dots, wave };

/**
 * Static outside a live session. While live, shapes follow `--cos-level`, which the session's meter
 * writes from the microphone or the reply; connecting and thinking use the stepped status pulse.
 */
export function ChiefOfStaffAvatar({
  look,
  phase,
  accentColor,
  pixels,
  className,
}: {
  look: ChiefOfStaffAvatarStyle;
  phase: ChiefOfStaffPhase;
  /** Empty uses the theme's primary colour. */
  accentColor: string;
  pixels: number;
  className?: string;
}) {
  const live = isChiefOfStaffLive(phase);
  const waiting = phase === "starting" || phase === "connecting" || phase === "thinking";
  return (
    <span
      ref={live ? chiefOfStaffLevelTarget : undefined}
      data-phase={phase}
      className={cn(
        "inline-flex shrink-0",
        accentColor === "" && "text-primary",
        !live && "opacity-75",
        waiting && "animate-status-pulse motion-reduce:animate-none",
        className,
      )}
      style={accentColor === "" ? undefined : { color: accentColor }}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        // Inline so button styles that size and tint descendant icons leave the avatar alone.
        style={{ width: pixels, height: pixels, color: "inherit" }}
        className="overflow-visible"
      >
        {LOOKS[look](phase)}
      </svg>
    </span>
  );
}
