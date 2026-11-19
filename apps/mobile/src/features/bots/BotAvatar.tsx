import { type Bot, botDisplayColor } from "@t3tools/contracts";
import { BOT_FACES, type BotFaceMark, botFaceMarkKey } from "@t3tools/client-runtime/bot-identity";
import Svg, { Circle, Path, Rect } from "react-native-svg";

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

/** A bot's face: its shape in its colour, with white eyes. The same marks the web draws. */
export function BotAvatar(props: {
  readonly bot: Pick<Bot, "color" | "shape">;
  readonly size?: number;
}) {
  const size = props.size ?? 32;
  const face = BOT_FACES[props.bot.shape];
  const color = botDisplayColor(props.bot.color);
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <Mark mark={face.body} fill={color} />
      {face.eyes.map((eye) => (
        <Mark key={botFaceMarkKey(eye)} mark={eye} fill="#fff" />
      ))}
      {face.pupil === null ? null : <Mark mark={face.pupil} fill={color} />}
    </Svg>
  );
}
