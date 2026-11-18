import type { BotEvent, EnvironmentId } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

import { botsEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** One decision a session raised and the bot answered for you, with a correction field. */
export function BotDecisionRow(props: {
  readonly environmentId: EnvironmentId;
  readonly event: BotEvent;
}) {
  const correct = useAtomCommand(botsEnvironment.correctDecision);
  const [correcting, setCorrecting] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const decision = props.event.decision;
  if (decision === null) return null;

  const send = async () => {
    if (text.trim() === "") return;
    setBusy(true);
    const result = await correct({
      environmentId: props.environmentId,
      input: { eventId: props.event.id, correction: text.trim() },
    });
    setBusy(false);
    toastCommandFailure("Could not send the correction", result);
    if (result._tag === "Success") {
      setCorrecting(false);
      setText("");
    }
  };

  return (
    <div className="flex items-start gap-2 px-2.5 py-1.5">
      <CheckIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-sm">
          <span className="text-muted-foreground">{decision.sessionTitle}:</span>{" "}
          {decision.question} <span className="text-muted-foreground">→</span>{" "}
          <span className="font-medium">{decision.answer}</span>
        </div>
        {decision.correction === null ? (
          <div className="truncate text-muted-foreground text-xs">
            Because: {decision.cite}
            {correcting ? null : (
              <>
                {" · "}
                <Button size="xs" variant="link" onClick={() => setCorrecting(true)}>
                  Correct
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="truncate text-muted-foreground text-xs">
            Corrected: {decision.correction}
          </div>
        )}
        {correcting ? (
          <div className="mt-1.5 flex items-center gap-2">
            <Input
              size="sm"
              autoFocus
              className="flex-1"
              placeholder="What should it have decided?"
              value={text}
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
                if (event.key === "Escape") setCorrecting(false);
              }}
            />
            <Button size="sm" disabled={busy || text.trim() === ""} onClick={() => void send()}>
              Send
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
