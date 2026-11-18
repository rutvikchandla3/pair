import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { botsEnvironment, useBotsSnapshot } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";

/** The open Ask's suggested answers, answerable in place from Inbox. */
export function BotInboxAskActions(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly askId: string;
}) {
  const snapshot = useBotsSnapshot(props.environmentId);
  const answerAsk = useAtomCommand(botsEnvironment.answerAsk);
  const [busy, setBusy] = useState(false);
  if (snapshot === null) return null;
  const ask = snapshot.asks.find((candidate) => candidate.id === props.askId);
  if (ask === undefined || ask.status !== "open") return null;

  const answer = async (kind: "option" | "bot-decides", value?: string) => {
    setBusy(true);
    const result = await answerAsk({
      environmentId: props.environmentId,
      input: {
        askId: ask.id,
        kind,
        ...(value === undefined ? {} : { answer: value }),
        remember: false,
      },
    });
    setBusy(false);
    toastCommandFailure("Could not answer", result);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      {ask.options.map((option) => (
        <Button
          key={option}
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => void answer("option", option)}
        >
          {option}
        </Button>
      ))}
      <Button size="xs" variant="ghost" disabled={busy} onClick={() => void answer("bot-decides")}>
        Let it decide
      </Button>
    </div>
  );
}
