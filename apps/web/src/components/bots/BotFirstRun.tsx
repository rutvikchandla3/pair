import type { BotStarter, EnvironmentId } from "@t3tools/contracts";
import { BOT_DEFAULT_LIMITS, BOT_LIMIT_LABELS } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { botsEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const STARTERS: ReadonlyArray<{
  readonly value: BotStarter;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "default",
    label: "Default",
    description: `Decides code details, checks with you before ${BOT_DEFAULT_LIMITS.map((limit) =>
      BOT_LIMIT_LABELS[limit].toLowerCase(),
    ).join(", ")}.`,
  },
  {
    value: "blank",
    label: "Blank",
    description: "No instructions and no limits. You write them in its Playbook.",
  },
];

/** The first-run card: name, what it's for, a starter, and Create. */
export function BotFirstRun(props: { readonly environmentId: EnvironmentId }) {
  const create = useAtomCommand(botsEnvironment.create, { reportFailure: false });
  const navigate = useNavigate();
  const [name, setName] = useState("Atlas");
  const [charter, setCharter] = useState("");
  const [starter, setStarter] = useState<BotStarter>("default");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const botName = name.trim() === "" ? "Atlas" : name.trim();

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await create({
      environmentId: props.environmentId,
      input: { name: botName, charter, starter },
    });
    setBusy(false);
    if (result._tag !== "Success") {
      const squashed = squashAtomCommandFailure(result);
      setError(squashed instanceof Error ? squashed.message : "Could not create the bot.");
      return;
    }
    void navigate({
      to: "/bots/$environmentId/$botId",
      params: { environmentId: props.environmentId, botId: result.value.id },
      search: { tab: "briefing" },
    });
  };

  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto scrollbar-gutter-both p-4">
      <div className="w-full max-w-[520px] rounded-xl border border-border bg-card p-5">
        <div className="flex items-start gap-2.5">
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary font-medium text-primary-foreground text-sm">
            {botName.charAt(0).toUpperCase()}
          </span>
          <div>
            <h1 className="font-medium text-sm">Make your bot</h1>
            <p className="text-muted-foreground text-xs">
              Give it jobs. It starts sessions, answers them your way, and asks you only when it has
              to.
            </p>
          </div>
        </div>

        <label className="mt-4 flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Name</span>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="mt-2 flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">What it&apos;s for</span>
          <Input
            value={charter}
            placeholder="Runs my software work end to end"
            onChange={(event) => setCharter(event.target.value)}
          />
        </label>

        <p className="mt-3.5 mb-1.5 font-medium text-muted-foreground text-xs">
          Start its playbook from
        </p>
        <div className="flex flex-col gap-1.5">
          {STARTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={starter === option.value}
              onClick={() => setStarter(option.value)}
              className={cn(
                "flex items-start gap-2.5 rounded-lg border p-2.5 text-left",
                starter === option.value ? "border-ring bg-accent/40" : "border-border",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 inline-flex size-3.5 shrink-0 rounded-full border",
                  starter === option.value ? "border-4 border-primary" : "border-input",
                )}
              />
              <span>
                <span className="block font-medium text-sm">{option.label}</span>
                <span className="block text-muted-foreground text-xs">{option.description}</span>
              </span>
            </button>
          ))}
        </div>

        {error === null ? null : <p className="mt-3 text-destructive text-sm">{error}</p>}

        <div className="mt-3.5 flex justify-end">
          <Button disabled={busy} onClick={() => void submit()}>
            Create {botName}
          </Button>
        </div>
      </div>
    </div>
  );
}
