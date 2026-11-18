import type { Bot, BotModels, EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useEnvironmentProviders } from "../../state/environments";
import { botsEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { toastCommandFailure } from "../team/toastCommandFailure";

const PICKER_TRIGGER = "w-full justify-between";

type BotModelRole = keyof BotModels;

const MODEL_NOTES: Readonly<Record<BotModelRole, string>> = {
  brain: "Plans, answers sessions, writes reports",
  worker: "Implementation and test sessions",
  reviewer: "Review sessions",
};

const MODEL_LABELS: Readonly<Record<BotModelRole, string>> = {
  brain: "Brain",
  worker: "Worker",
  reviewer: "Reviewer",
};

/** Name, charter and the three models. */
export function BotSettingsDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const update = useAtomCommand(botsEnvironment.update);
  const [name, setName] = useState(props.bot.name);
  const [charter, setCharter] = useState(props.bot.charter);
  const [models, setModels] = useState<BotModels>(props.bot.models);
  const [busy, setBusy] = useState(false);
  const settings = usePrimarySettings();
  const providersByEnvironment = useEnvironmentProviders();
  const providers = providersByEnvironment.get(props.environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, null);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(settings, providers);

  const setModel = (
    role: BotModelRole,
    instanceId: ModelSelection["instanceId"],
    model: string,
  ) => {
    setModels((current) => ({
      ...current,
      [role]: { instanceId, model },
    }));
  };

  const save = async () => {
    if (name.trim() === "") return;
    setBusy(true);
    const result = await update({
      environmentId: props.environmentId,
      input: { botId: props.bot.id, name: name.trim(), charter, models },
    });
    setBusy(false);
    toastCommandFailure("Could not save the bot", result);
    if (result._tag === "Success") props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{props.bot.name} settings</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-6 pb-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Name</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">What it&apos;s for</span>
            <Input
              value={charter}
              placeholder="Runs my software work end to end"
              onChange={(event) => setCharter(event.target.value)}
            />
          </label>
          {(["brain", "worker", "reviewer"] as ReadonlyArray<BotModelRole>).map((role) => (
            <div key={role} className="flex flex-col gap-1">
              <span className="text-muted-foreground text-sm">{MODEL_LABELS[role]}</span>
              <ProviderModelPicker
                environmentId={props.environmentId}
                activeInstanceId={models[role].instanceId}
                model={models[role].model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerClassName={PICKER_TRIGGER}
                triggerAriaLabel={`${MODEL_LABELS[role]} model`}
                onInstanceModelChange={(instanceId, model) => setModel(role, instanceId, model)}
              />
              <span className="text-muted-foreground text-xs">{MODEL_NOTES[role]}</span>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || name.trim() === ""} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
