import { Navigate, Outlet, createFileRoute, useLocation } from "@tanstack/react-router";

import { BotFirstRun } from "../components/bots/BotFirstRun";
import { Spinner } from "../components/ui/spinner";
import { useBotsSnapshot } from "../state/bots";
import { usePrimaryEnvironmentId } from "../state/environments";

/** `/bots`: the first-run card, or a redirect to the first bot's page. */
function BotsIndex() {
  const environmentId = usePrimaryEnvironmentId();
  const snapshot = useBotsSnapshot(environmentId);
  const showNew = Route.useSearch().new === 1;

  if (environmentId === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted-foreground text-sm">Connect an environment to use bots.</p>
      </div>
    );
  }
  if (snapshot === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  const first = snapshot.bots[0];
  if (first !== undefined && !showNew) {
    return (
      <Navigate
        to="/bots/$environmentId/$botId"
        params={{ environmentId, botId: first.id }}
        search={{ tab: "briefing" }}
        replace
      />
    );
  }
  return <BotFirstRun environmentId={environmentId} />;
}

function BotsRouteLayout() {
  const location = useLocation();
  return location.pathname === "/bots" ? <BotsIndex /> : <Outlet />;
}

export const Route = createFileRoute("/_chat/bots")({
  validateSearch: (raw: Record<string, unknown>): { new?: number | undefined } => ({
    new: raw.new === 1 || raw.new === "1" || raw.new === true ? 1 : undefined,
  }),
  component: BotsRouteLayout,
});
