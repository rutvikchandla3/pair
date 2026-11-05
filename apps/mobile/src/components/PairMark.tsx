import { useColorScheme, type ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/** `monochrome` draws both brackets in the given colour, for icon slots that are one colour. */
export function PairMark(props: {
  readonly size: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
  readonly monochrome?: boolean;
}) {
  const accent = useColorScheme() === "dark" ? "#2DD4BF" : "#0F9D8A";
  return (
    <Svg accessibilityLabel="Pair" height={props.size} width={props.size} viewBox="0 0 32 32">
      <ThemedPath
        d="M4 4H20V10H10V20H4Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
      {props.monochrome ? (
        <ThemedPath
          d="M28 28H12V22H22V12H28Z"
          color={props.color}
          colorClassName={props.colorClassName}
          fill="currentColor"
        />
      ) : (
        <Path d="M28 28H12V22H22V12H28Z" fill={accent} />
      )}
    </Svg>
  );
}
