import { BotAskId, type EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { BotPage } from "../components/bots/BotPage";

export interface BotPageSearch {
  /** An ask id to scroll the chat to when the page opens. */
  readonly ask?: string;
}

function BotPageRoute() {
  const params = Route.useParams();
  const search = Route.useSearch();
  return (
    <BotPage
      environmentId={params.environmentId as EnvironmentId}
      botId={params.botId}
      askId={search.ask === undefined ? null : BotAskId.make(search.ask)}
    />
  );
}

export const Route = createFileRoute("/_chat/bots/$environmentId/$botId")({
  validateSearch: (raw: Record<string, unknown>): BotPageSearch =>
    typeof raw.ask === "string" && raw.ask.trim() !== "" ? { ask: raw.ask } : {},
  component: BotPageRoute,
});
