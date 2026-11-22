import {
  type AssetResource,
  type Bot,
  type BotPicture,
  botDisplayColor,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  BOT_FACES,
  BOT_POSE_EYES,
  BOT_WORKING_LOOP_MS,
  type BotFaceGeometry,
  type BotFaceMark,
  type BotFacePose,
  botFaceMarkKey,
  botLoopOffsetMs,
} from "@t3tools/client-runtime/bot-identity";
import { Image } from "expo-image";
import { type ReactElement, useState } from "react";
import Animated, { css, type CSSKeyframesRule, useReducedMotion } from "react-native-reanimated";
import Svg, { Circle, G, Path, Rect } from "react-native-svg";

import { assetImageSource } from "../../lib/assetImageSource";
import { useAssetUrl } from "../../state/assets";

const PAUSED_OPACITY = 0.6;
const LAYER = { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 } as const;

type AvatarBot = Pick<Bot, "color" | "shape"> & {
  readonly id?: string;
  readonly picture?: BotPicture | null;
};

function Mark(props: { readonly mark: BotFaceMark; readonly fill: string }) {
  const { mark, fill } = props;
  switch (mark.kind) {
    case "circle":
      return <Circle cx={mark.cx} cy={mark.cy} r={mark.r} fill={fill} />;
    case "rect":
      return (
        <Rect
          x={mark.x}
          y={mark.y}
          width={mark.width}
          height={mark.height}
          rx={mark.rx}
          fill={fill}
        />
      );
    case "path":
      return (
        <Path
          d={mark.d}
          fill={fill}
          stroke={fill}
          strokeWidth={mark.strokeWidth}
          strokeLinejoin="round"
        />
      );
  }
}

function Eyes(props: { readonly face: BotFaceGeometry; readonly color: string }) {
  const { face, color } = props;
  return (
    <>
      {face.eyes.map((eye) => (
        <Mark key={botFaceMarkKey(eye)} mark={eye} fill="#fff" />
      ))}
      {face.pupil === null ? null : <Mark mark={face.pupil} fill={color} />}
    </>
  );
}

/** The middle of the eyes in face units, which a blink or a sleepy squash scales about. */
function eyeCenter(face: BotFaceGeometry): { readonly x: number; readonly y: number } {
  const centers = face.eyes.map((eye) =>
    eye.kind === "circle"
      ? { x: eye.cx, y: eye.cy }
      : eye.kind === "rect"
        ? { x: eye.x + eye.width / 2, y: eye.y + eye.height / 2 }
        : { x: 16, y: 16 },
  );
  return {
    x: centers.reduce((sum, center) => sum + center.x, 0) / centers.length,
    y: centers.reduce((sum, center) => sum + center.y, 0) / centers.length,
  };
}

function StillFace(props: {
  readonly face: BotFaceGeometry;
  readonly color: string;
  readonly size: number;
  readonly pose: BotFacePose;
}) {
  const { face, color, size, pose } = props;
  const eyes = pose === "needs-you" || pose === "paused" ? BOT_POSE_EYES[pose] : null;
  const centerY = eyeCenter(face).y;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      opacity={pose === "paused" ? PAUSED_OPACITY : 1}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <Mark mark={face.body} fill={color} />
      <G
        transform={
          eyes === null
            ? undefined
            : `matrix(1 0 0 ${eyes.scaleY} 0 ${centerY * (1 - eyes.scaleY) + eyes.dy})`
        }
      >
        <Eyes face={face} color={color} />
      </G>
    </Svg>
  );
}

interface WorkingMotion {
  readonly face: CSSKeyframesRule;
  readonly body: CSSKeyframesRule;
  readonly eyes: CSSKeyframesRule;
}

const workingMotions = new Map<number, WorkingMotion>();

/** Breathe, glance left then right, blink, then a double hop. Keyframes are in points, so per size. */
function workingMotion(size: number): WorkingMotion {
  const cached = workingMotions.get(size);
  if (cached !== undefined) return cached;
  const unit = size / 32;
  const at = (ms: number) => `${(ms / BOT_WORKING_LOOP_MS) * 100}%`;
  const eyes = (translateX: number, scaleY: number) => ({
    transform: [{ translateX: translateX * unit }, { scaleY }],
  });
  const hop = (translateY: number) => ({ transform: [{ translateY: translateY * unit }] });
  const motion: WorkingMotion = {
    body: css.keyframes({
      "0%": { transform: [{ scaleX: 1 }, { scaleY: 1 }] },
      [at(300)]: { transform: [{ scaleX: 1.02 }, { scaleY: 0.97 }] },
      [at(700)]: { transform: [{ scaleX: 1 }, { scaleY: 1 }] },
      "100%": { transform: [{ scaleX: 1 }, { scaleY: 1 }] },
    }),
    eyes: css.keyframes({
      "0%": eyes(0, 1),
      [at(1400)]: eyes(0, 1),
      [at(1650)]: eyes(-2, 1),
      [at(2300)]: eyes(-2, 1),
      [at(2550)]: eyes(2, 1),
      [at(3100)]: eyes(2, 1),
      [at(3350)]: eyes(0, 1),
      [at(3800)]: eyes(0, 1),
      [at(3900)]: eyes(0, 0.1),
      [at(4000)]: eyes(0, 1),
      "100%": eyes(0, 1),
    }),
    face: css.keyframes({
      "0%": hop(0),
      [at(4600)]: hop(0),
      [at(4750)]: hop(-3),
      [at(4900)]: hop(0),
      [at(5050)]: hop(-2),
      [at(5200)]: hop(0),
      "100%": hop(0),
    }),
  };
  workingMotions.set(size, motion);
  return motion;
}

/** CSS keyframes on views: the loop runs natively, and stops when this unmounts. */
function WorkingFace(props: {
  readonly face: BotFaceGeometry;
  readonly color: string;
  readonly size: number;
  readonly botId: string;
}) {
  const { face, color, size } = props;
  const motion = workingMotion(size);
  const loop = {
    animationDuration: BOT_WORKING_LOOP_MS,
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
    animationDelay: -botLoopOffsetMs(props.botId),
  } as const;
  const center = eyeCenter(face);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, animationName: motion.face, ...loop }}
    >
      <Animated.View style={{ ...LAYER, animationName: motion.body, ...loop }}>
        <Svg width={size} height={size} viewBox="0 0 32 32">
          <Mark mark={face.body} fill={color} />
        </Svg>
      </Animated.View>
      <Animated.View
        style={{
          ...LAYER,
          transformOrigin: `${(center.x / 32) * 100}% ${(center.y / 32) * 100}%`,
          animationName: motion.eyes,
          ...loop,
        }}
      >
        <Svg width={size} height={size} viewBox="0 0 32 32">
          <Eyes face={face} color={color} />
        </Svg>
      </Animated.View>
    </Animated.View>
  );
}

function Face(props: {
  readonly bot: AvatarBot;
  readonly size: number;
  readonly pose: BotFacePose;
  readonly reducedMotion: boolean;
}) {
  const face = BOT_FACES[props.bot.shape];
  const color = botDisplayColor(props.bot.color);
  if (props.pose === "working" && !props.reducedMotion) {
    return <WorkingFace face={face} color={color} size={props.size} botId={props.bot.id ?? ""} />;
  }
  return (
    <StillFace
      face={face}
      color={color}
      size={props.size}
      pose={props.pose === "working" ? "idle" : props.pose}
    />
  );
}

function PictureAvatar(props: {
  readonly environmentId: EnvironmentId;
  readonly picture: BotPicture;
  readonly size: number;
  readonly pose: BotFacePose;
  readonly reducedMotion: boolean;
  readonly fallback: ReactElement;
}) {
  const { environmentId, picture, size } = props;
  const resource: AssetResource = {
    _tag: "attachment",
    attachmentId: picture.attachmentId,
    mimeType: picture.mimeType,
    disposition: "inline",
  };
  const url = useAssetUrl(environmentId, resource);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (url === null || url === failedUrl) return props.fallback;
  return (
    <Image
      source={assetImageSource(environmentId, resource, url)}
      cachePolicy="memory-disk"
      contentFit="cover"
      autoplay={props.pose === "working" && !props.reducedMotion}
      onError={() => setFailedUrl(url)}
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        opacity: props.pose === "paused" ? PAUSED_OPACITY : 1,
      }}
    />
  );
}

/**
 * A bot's face: its shape in its colour, with white eyes, the same marks the web draws. Working
 * faces loop; other poses are still. A picture replaces the face once its URL resolves.
 */
export function BotAvatar(props: {
  readonly bot: AvatarBot;
  readonly size?: number;
  readonly pose?: BotFacePose;
  readonly environmentId?: EnvironmentId | null;
}) {
  const size = props.size ?? 32;
  const pose = props.pose ?? "idle";
  const reducedMotion = useReducedMotion();
  const face = <Face bot={props.bot} size={size} pose={pose} reducedMotion={reducedMotion} />;
  const picture = props.bot.picture ?? null;
  if (picture === null || props.environmentId == null) return face;
  return (
    <PictureAvatar
      environmentId={props.environmentId}
      picture={picture}
      size={size}
      pose={pose}
      reducedMotion={reducedMotion}
      fallback={face}
    />
  );
}
