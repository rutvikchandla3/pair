import { type Bot, type BotPicture, botDisplayColor, type EnvironmentId } from "@t3tools/contracts";
import {
  BOT_FACES,
  type BotFaceMark,
  type BotFacePose,
  botFaceMarkKey,
  botLoopOffsetMs,
} from "@t3tools/client-runtime/bot-identity";
import { type CSSProperties, type ReactNode, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";

const SIZES = { sm: 16, md: 20, lg: 24, row: 28, xl: 56 } as const;

export type BotAvatarSize = keyof typeof SIZES;

type AvatarBot = Pick<Bot, "color" | "shape"> & {
  readonly id?: string;
  readonly picture?: BotPicture | null;
};

function Mark(props: { readonly mark: BotFaceMark; readonly fill: string }) {
  const { mark, fill } = props;
  switch (mark.kind) {
    case "circle":
      return <circle cx={mark.cx} cy={mark.cy} r={mark.r} fill={fill} />;
    case "rect":
      return (
        <rect
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
        <path
          d={mark.d}
          fill={fill}
          stroke={fill}
          strokeWidth={mark.strokeWidth}
          strokeLinejoin="round"
        />
      );
  }
}

function Face(props: { readonly bot: AvatarBot; readonly size: number }) {
  const face = BOT_FACES[props.bot.shape];
  const color = botDisplayColor(props.bot.color);
  return (
    <svg aria-hidden width={props.size} height={props.size} viewBox="0 0 32 32">
      <g className="bot-face-hop">
        <g className="bot-face-body">
          <Mark mark={face.body} fill={color} />
        </g>
        <g className="bot-face-eyes">
          {face.eyes.map((eye) => (
            <Mark key={botFaceMarkKey(eye)} mark={eye} fill="#fff" />
          ))}
          {face.pupil === null ? null : <Mark mark={face.pupil} fill={color} />}
        </g>
      </g>
    </svg>
  );
}

function drawCover(canvas: HTMLCanvasElement, image: HTMLImageElement) {
  const context = canvas.getContext("2d");
  if (context === null) return;
  const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
}

/**
 * An animated picture holds its first frame on a canvas until it should move: dozens of looping
 * GIFs in the sidebar would repaint every frame.
 */
function PictureImage(props: {
  readonly url: string;
  readonly size: number;
  readonly moving: boolean;
  readonly onError: () => void;
}) {
  const { url, size, onError } = props;
  const stillRef = (canvas: HTMLCanvasElement | null) => {
    if (canvas === null) return;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => drawCover(canvas, image);
    image.onerror = onError;
    image.src = url;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  };
  if (props.moving) {
    return (
      <img
        alt=""
        src={url}
        decoding="async"
        width={size}
        height={size}
        onError={onError}
        className="size-full object-cover"
      />
    );
  }
  const pixels = Math.ceil(size * window.devicePixelRatio);
  return (
    <>
      <canvas ref={stillRef} width={pixels} height={pixels} className="bot-face-still size-full" />
      <img
        alt=""
        src={url}
        decoding="async"
        className="bot-face-hover-play size-full object-cover"
      />
    </>
  );
}

function Picture(props: {
  readonly picture: BotPicture;
  readonly environmentId: EnvironmentId;
  readonly size: number;
  readonly moving: boolean;
  readonly fallback: ReactNode;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const state = useAssetUrlState(props.environmentId, {
    _tag: "attachment",
    attachmentId: props.picture.attachmentId,
    mimeType: props.picture.mimeType,
    disposition: "inline",
  });
  const url = state._tag === "Success" ? state.url : null;
  const onError = () => setFailedUrl(url);
  if (url === null || failedUrl === url) return props.fallback;
  const animated =
    props.picture.mimeType === "image/gif" || props.picture.mimeType === "image/webp";
  return (
    <span
      className="block overflow-hidden bg-muted"
      style={{ width: props.size, height: props.size, borderRadius: props.size * 0.28 }}
    >
      <PictureImage
        url={url}
        size={props.size}
        moving={!animated || props.moving}
        onError={onError}
      />
    </span>
  );
}

/**
 * A bot's face, or its picture. The pose shows state: a working face loops, needs-you looks up,
 * paused sleeps. `animated` lets a picture keep playing where only one avatar shows.
 */
export function BotAvatar(props: {
  readonly bot: AvatarBot;
  readonly size?: BotAvatarSize;
  readonly pose?: BotFacePose;
  /** Where the picture is stored; without it the face shows. */
  readonly environmentId?: EnvironmentId | null;
  readonly animated?: boolean;
  readonly className?: string;
}) {
  const size = SIZES[props.size ?? "md"];
  const pose = props.pose ?? "idle";
  const face = <Face bot={props.bot} size={size} />;
  const picture = props.bot.picture ?? null;
  const style = {
    "--bot-face-offset": `-${botLoopOffsetMs(props.bot.id ?? props.bot.shape)}ms`,
  } as CSSProperties;
  return (
    <span
      aria-hidden
      data-pose={pose}
      style={style}
      className={cn("bot-face inline-flex shrink-0", props.className)}
    >
      {picture === null || props.environmentId === undefined || props.environmentId === null ? (
        face
      ) : (
        <Picture
          picture={picture}
          environmentId={props.environmentId}
          size={size}
          moving={props.animated === true || pose === "working"}
          fallback={face}
        />
      )}
    </span>
  );
}
