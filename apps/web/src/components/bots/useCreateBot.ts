import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { botsEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastCommandFailure } from "../team/toastCommandFailure";

/** "+" and "New bot": create a bot with the defaults and open its chat. No dialog. */
export function useCreateBot(): (environmentId: EnvironmentId) => Promise<void> {
  const create = useAtomCommand(botsEnvironment.create, { reportFailure: false });
  const navigate = useNavigate();
  return async (environmentId: EnvironmentId) => {
    const result = await create({
      environmentId,
      input: { charter: "", starter: "default" },
    });
    toastCommandFailure("Could not create the bot", result);
    if (result._tag !== "Success") return;
    await navigate({
      to: "/bots/$environmentId/$botId",
      params: { environmentId, botId: result.value.id },
    });
  };
}
