import { CircleAlertIcon, CircleCheckIcon, MessageCircleQuestionIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Spinner } from "../ui/spinner";
import type { BotSessionGlyph } from "./bots.logic";

const GLYPH_STYLES: Readonly<Record<Exclude<BotSessionGlyph, "working">, string>> = {
  "needs-you": "text-indigo-600 dark:text-indigo-300",
  done: "text-success-foreground",
  failed: "text-error-foreground",
};

/** The state glyph for a bot session row or a thread chip. */
export function BotStateGlyph(props: {
  readonly glyph: BotSessionGlyph;
  readonly className?: string;
}) {
  if (props.glyph === "working") {
    return <Spinner size="xs" className={props.className} />;
  }
  const style = GLYPH_STYLES[props.glyph];
  if (props.glyph === "needs-you") {
    return (
      <MessageCircleQuestionIcon aria-label="Needs you" className={cn(style, props.className)} />
    );
  }
  if (props.glyph === "done") {
    return <CircleCheckIcon aria-label="Done" className={cn(style, props.className)} />;
  }
  return <CircleAlertIcon aria-label="Failed" className={cn(style, props.className)} />;
}
