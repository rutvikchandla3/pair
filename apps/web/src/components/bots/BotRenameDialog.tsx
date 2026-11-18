import type { Bot, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { botsEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

export function BotRenameDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const update = useAtomCommand(botsEnvironment.update);
  const [name, setName] = useState(props.bot.name);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    setBusy(true);
    const result = await update({
      environmentId: props.environmentId,
      input: { botId: props.bot.id, name: trimmed },
    });
    setBusy(false);
    toastCommandFailure("Could not rename the bot", result);
    if (result._tag === "Success") props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Rename {props.bot.name}</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-4">
          <Input
            autoFocus
            aria-label="Bot name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
          />
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
