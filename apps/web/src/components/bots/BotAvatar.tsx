import { type Bot, botDisplayColor } from "@t3tools/contracts";
import { BOT_FACES, type BotFaceMark, botFaceMarkKey } from "@t3tools/client-runtime/bot-identity";

const SIZES = { sm: 16, md: 20, lg: 24, xl: 56 } as const;

export type BotAvatarSize = keyof typeof SIZES;

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

/** A bot's face: its shape in its colour, with white eyes. Static; it never shows state. */
export function BotAvatar(props: {
  readonly bot: Pick<Bot, "color" | "shape">;
  readonly size?: BotAvatarSize;
}) {
  const size = SIZES[props.size ?? "md"];
  const face = BOT_FACES[props.bot.shape];
  const color = botDisplayColor(props.bot.color);
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 32 32" className="shrink-0">
      <Mark mark={face.body} fill={color} />
      {face.eyes.map((eye) => (
        <Mark key={botFaceMarkKey(eye)} mark={eye} fill="#fff" />
      ))}
      {face.pupil === null ? null : <Mark mark={face.pupil} fill={color} />}
    </svg>
  );
}
