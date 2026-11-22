import { BotAskId, type EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { BotPage } from "../components/bots/BotPage";

export interface BotPageSearch {
  /** An ask id to scroll the chat to when the page opens. */
  readonly ask?: string;
  /** Opens the questions panel. */
  readonly questions?: true;
}

function BotPageRoute() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <BotPage
      environmentId={params.environmentId as EnvironmentId}
      botId={params.botId}
      askId={search.ask === undefined ? null : BotAskId.make(search.ask)}
      questionsOpen={search.questions === true}
      onQuestionsOpenChange={(open) =>
        void navigate({
          search: ({ questions: _questions, ...rest }) =>
            open ? { ...rest, questions: true as const } : rest,
          replace: true,
        })
      }
    />
  );
}

export const Route = createFileRoute("/_chat/bots/$environmentId/$botId")({
  validateSearch: (raw: Record<string, unknown>): BotPageSearch => ({
    ...(typeof raw.ask === "string" && raw.ask.trim() !== "" ? { ask: raw.ask } : {}),
    ...(raw.questions === true ? { questions: true } : {}),
  }),
  component: BotPageRoute,
});
