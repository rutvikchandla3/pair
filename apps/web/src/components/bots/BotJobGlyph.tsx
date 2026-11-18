import type { BotJob } from "@t3tools/contracts";
import { CircleCheckIcon, CircleIcon, CircleXIcon, LoaderCircleIcon } from "lucide-react";

/** A job's status: an empty ring until the bot's first update, then working, done or stopped. */
export function JobStatusGlyph({ job }: { readonly job: BotJob }) {
  if (job.headline.trim() === "" && job.status === "working") {
    return <CircleIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  switch (job.status) {
    case "done":
      return <CircleCheckIcon className="size-3.5 shrink-0 text-success" />;
    case "stopped":
      return <CircleXIcon className="size-3.5 shrink-0 text-muted-foreground" />;
    default:
      return <LoaderCircleIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  }
}
