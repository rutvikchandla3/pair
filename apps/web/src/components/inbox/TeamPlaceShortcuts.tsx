import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { registerCommands } from "../../shortcuts/dispatcher";
import { useTeamEnvironmentIds } from "../../state/inbox";

/** `inbox.open`, `myTasks.open` and `sharedWithYou.open`, wherever a team environment is connected. */
export function TeamPlaceShortcuts() {
  const navigate = useNavigate();
  const teamMode = useTeamEnvironmentIds().length > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers handlers with the app's keyboard dispatcher while in team mode
  useEffect(() => {
    if (!teamMode) return;
    const go = (to: "/inbox" | "/my-tasks" | "/shared") => (event: KeyboardEvent) => {
      event.preventDefault();
      if (!event.repeat) void navigate({ to });
    };
    return registerCommands({
      "inbox.open": go("/inbox"),
      "myTasks.open": go("/my-tasks"),
      "sharedWithYou.open": go("/shared"),
    });
  }, [navigate, teamMode]);
  return null;
}
