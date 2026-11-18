import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { BotPage, type BotTab } from "../components/bots/BotPage";

export interface BotPageSearch {
  readonly tab: BotTab;
  readonly job?: string;
}

function BotPageRoute() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const go = (next: { readonly tab: BotTab; readonly job?: string }) =>
    void navigate({
      to: "/bots/$environmentId/$botId",
      params,
      search: next,
      replace: true,
    });
  return (
    <BotPage
      environmentId={params.environmentId as EnvironmentId}
      botId={params.botId}
      tab={search.tab}
      jobId={search.job ?? null}
      onTabChange={(tab) => go({ tab, ...(search.job === undefined ? {} : { job: search.job }) })}
      onOpenJob={(job) => go({ tab: search.tab, job })}
      onCloseJob={() => go({ tab: search.tab })}
    />
  );
}

export const Route = createFileRoute("/_chat/bots/$environmentId/$botId")({
  validateSearch: (raw: Record<string, unknown>): BotPageSearch => ({
    tab: raw.tab === "chat" || raw.tab === "playbook" ? raw.tab : "briefing",
    ...(typeof raw.job === "string" && raw.job.trim() !== "" ? { job: raw.job } : {}),
  }),
  component: BotPageRoute,
});
