import type { BotShape, BotVoice } from "@t3tools/contracts";

/**
 * A bot face's marks on a 32×32 canvas, drawn as SVG on web and with react-native-svg on mobile.
 * The body takes the bot's colour, eyes are white, and a `pupil` takes the bot's colour again.
 */
export type BotFaceMark =
  | { readonly kind: "circle"; readonly cx: number; readonly cy: number; readonly r: number }
  | {
      readonly kind: "rect";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly rx: number;
    }
  /** Stroked in the fill colour with round joins, which softens the corners. */
  | { readonly kind: "path"; readonly d: string; readonly strokeWidth: number };

export interface BotFaceGeometry {
  readonly body: BotFaceMark;
  readonly eyes: ReadonlyArray<BotFaceMark>;
  readonly pupil: BotFaceMark | null;
}

// Each shape has its own eyes, so a face never reads as a "blocked" or "record" badge at 16px.
export const BOT_FACES: Readonly<Record<BotShape, BotFaceGeometry>> = {
  round: {
    body: { kind: "circle", cx: 16, cy: 16, r: 15 },
    eyes: [
      { kind: "circle", cx: 11.5, cy: 15, r: 2.6 },
      { kind: "circle", cx: 20.5, cy: 15, r: 2.6 },
    ],
    pupil: null,
  },
  square: {
    body: { kind: "rect", x: 1, y: 1, width: 30, height: 30, rx: 9 },
    eyes: [
      { kind: "rect", x: 9.4, y: 10.6, width: 4.2, height: 8.6, rx: 2.1 },
      { kind: "rect", x: 18.4, y: 10.6, width: 4.2, height: 8.6, rx: 2.1 },
    ],
    pupil: null,
  },
  tall: {
    body: { kind: "rect", x: 4, y: 1, width: 24, height: 30, rx: 12 },
    eyes: [{ kind: "circle", cx: 16, cy: 14, r: 4.6 }],
    pupil: { kind: "circle", cx: 17.2, cy: 14.6, r: 1.9 },
  },
  hex: {
    body: { kind: "path", d: "M16 2.2 27.9 9.1v13.8L16 29.8 4.1 22.9V9.1Z", strokeWidth: 2.4 },
    eyes: [
      { kind: "circle", cx: 11.8, cy: 15.5, r: 2.5 },
      { kind: "circle", cx: 20.2, cy: 15.5, r: 2.5 },
    ],
    pupil: null,
  },
};

/** A React key for a mark: its position, which is unique within one face. */
export const botFaceMarkKey = (mark: BotFaceMark): string =>
  mark.kind === "circle"
    ? `circle:${mark.cx},${mark.cy}`
    : mark.kind === "rect"
      ? `rect:${mark.x},${mark.y}`
      : `path:${mark.d}`;

export const BOT_SHAPE_LABELS: Readonly<Record<BotShape, string>> = {
  round: "Round",
  square: "Square",
  tall: "Tall",
  hex: "Hexagon",
};

export const BOT_VOICE_LABELS: Readonly<
  Record<BotVoice, { readonly label: string; readonly description: string }>
> = {
  crisp: { label: "Crisp", description: "Results first, fewest words." },
  candid: { label: "Candid", description: "Results, plus its own call in one sentence." },
};

/** The empty chat's one-line greeting, in the bot's voice. Static copy, no model call. */
export const botGreeting = (name: string, voice: BotVoice): string =>
  voice === "candid"
    ? `${name} here. Send me work; I'll push back.`
    : `${name} here. What should I take on?`;

/**
 * What a face shows. Working loops (breathe, glance, blink, hop); the rest are still poses, so an
 * idle list costs nothing to paint. A picture plays its animation only while working.
 */
export type BotFacePose = "idle" | "working" | "needs-you" | "paused";

/** How a still pose moves the eyes, in face units: up to look at you, squashed shut to sleep. */
export const BOT_POSE_EYES: Readonly<
  Record<"needs-you" | "paused", { readonly dy: number; readonly scaleY: number }>
> = {
  "needs-you": { dy: -1.6, scaleY: 1 },
  paused: { dy: 0.6, scaleY: 0.18 },
};

/** One loop of the working animation. Each face starts at its own offset so a list never bobs in step. */
export const BOT_WORKING_LOOP_MS = 6000;

/** A stable start offset into the loop for a bot, so its rows don't move in lockstep. */
export const botLoopOffsetMs = (botId: string): number => {
  let hash = 0;
  for (let index = 0; index < botId.length; index += 1) {
    hash = (hash * 31 + botId.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % BOT_WORKING_LOOP_MS;
};
