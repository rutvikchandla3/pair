import { SPACE_COLOR_VALUES, spaceColor } from "@t3tools/client-runtime/spaces";
import { SPACE_COLORS, type Space, type SpaceIcon, SpaceEmoji } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SpaceMark } from "./SpaceMark";

const isSpaceEmoji = Schema.is(SpaceEmoji);

/** The owner's pick of color and emoji; saving each change as it's made. */
export function SpaceIconPicker(props: {
  readonly space: Space;
  readonly disabled: boolean;
  readonly onChange: (icon: SpaceIcon | null) => void;
}) {
  const color = spaceColor(props.space);
  const [emoji, setEmoji] = useState(props.space.icon?.emoji ?? "");
  const trimmed = emoji.trim();
  const invalid = trimmed !== "" && !isSpaceEmoji(trimmed);
  const save = (next: { readonly color: SpaceIcon["color"]; readonly emoji: string }) => {
    if (next.emoji !== "" && !isSpaceEmoji(next.emoji)) return;
    props.onChange({ color: next.color, ...(next.emoji === "" ? {} : { emoji: next.emoji }) });
  };
  return (
    <div className="flex items-start gap-3">
      <SpaceMark
        space={{
          ...props.space,
          ...(trimmed !== "" && !invalid ? { icon: { color, emoji: trimmed } } : {}),
        }}
        size="lg"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-1.5">
          {SPACE_COLORS.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={option === color}
              aria-label={option}
              disabled={props.disabled}
              className={cn(
                "size-5 rounded-full ring-offset-2 ring-offset-background disabled:cursor-not-allowed disabled:opacity-60",
                option === color ? "ring-2 ring-foreground" : "hover:ring-2 hover:ring-border",
              )}
              style={{ backgroundColor: SPACE_COLOR_VALUES[option] }}
              onClick={() => save({ color: option, emoji: invalid ? "" : trimmed })}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="w-24">
            <Input
              size="sm"
              value={emoji}
              disabled={props.disabled}
              aria-label="Emoji"
              aria-invalid={invalid}
              placeholder="Emoji"
              onChange={(event) => setEmoji(event.target.value)}
              onBlur={() => {
                if (!invalid && trimmed !== (props.space.icon?.emoji ?? "")) {
                  save({ color, emoji: trimmed });
                }
              }}
            />
          </div>
          {invalid ? <span className="text-destructive text-xs">One emoji, like 🚀</span> : null}
          {props.space.icon === undefined ? null : (
            <Button
              size="xs"
              variant="ghost"
              disabled={props.disabled}
              onClick={() => {
                setEmoji("");
                props.onChange(null);
              }}
            >
              Reset
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
