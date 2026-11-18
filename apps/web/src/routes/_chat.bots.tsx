import { Navigate, Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";

import { useCreateBot } from "../components/bots/useCreateBot";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { useBotsSnapshot } from "../state/bots";
import { usePrimaryEnvironmentId } from "../state/environments";

/** `/bots`: the first bot's page, or a centred empty state that makes one. */
function BotsIndex() {
  const environmentId = usePrimaryEnvironmentId();
  const snapshot = useBotsSnapshot(environmentId);
  const createBot = useCreateBot();

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
  if (first !== undefined) {
    return (
      <Navigate
        to="/bots/$environmentId/$botId"
        params={{ environmentId, botId: first.id }}
        replace
      />
    );
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="inline-flex size-10 items-center justify-center rounded-xl bg-muted">
        <BotIcon className="size-5 text-muted-foreground" />
      </span>
      <p className="max-w-[420px] text-muted-foreground text-sm">
        A bot is one chat. Give it work; it runs sessions and reports back here.
      </p>
      <Button onClick={() => void createBot(environmentId)}>New bot</Button>
    </div>
  );
}

function BotsRouteLayout() {
  const location = useLocation();
  return location.pathname === "/bots" ? <BotsIndex /> : <Outlet />;
}

export const Route = createFileRoute("/_chat/bots")({
  component: BotsRouteLayout,
});
