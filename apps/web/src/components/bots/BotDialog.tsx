import {
  type Bot,
  BOT_COLORS,
  BotColor,
  BotShape,
  BotVoice,
  type EnvironmentId,
  nextBotFace,
  nextBotName,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
} from "@t3tools/contracts";
import { BOT_SHAPE_LABELS, BOT_VOICE_LABELS } from "@t3tools/client-runtime/bot-identity";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";

import { uploadImageAttachment } from "~/lib/attachmentUploadQueue";
import { cn } from "~/lib/utils";
import { botsEnvironment, useBotsSnapshot } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { BotAvatar } from "./BotAvatar";
import { useBotDialogStore } from "./botDialogStore";

// The same short report in each voice, so the picker shows what changes and what doesn't.
const VOICE_SAMPLES: Readonly<Record<BotVoice, string>> = {
  crisp: "Sidebar drag flicker is done. It renders once on drop now. 42 of 42 tests pass.",
  candid:
    "Sidebar drag flicker is done. It renders once on drop now. 42 of 42 tests pass, and I'd merge it today.",
};

// A bot from before the palette changed may hold a colour outside it; saving leaves that alone.
const isBotColor = Schema.is(BotColor);
const isBotVoice = Schema.is(BotVoice);
const isPictureMimeType = Schema.is(Schema.Literals(PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES));

type PictureChoice =
  | { readonly kind: "keep" }
  | { readonly kind: "remove" }
  | {
      readonly kind: "file";
      readonly file: File;
      readonly mimeType: (typeof PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES)[number];
      readonly previewUrl: string;
    };

/** Mounted once in the app shell; every New bot and Edit bot entry point opens it here. */
export function BotDialogHost() {
  const dialog = useBotDialogStore((state) => state.dialog);
  const close = useBotDialogStore((state) => state.close);
  const snapshot = useBotsSnapshot(dialog?.environmentId ?? null);
  if (dialog === null || snapshot === null) return null;
  if (dialog.type === "new") {
    const face = nextBotFace(snapshot.bots);
    return (
      <BotDialog
        key="new"
        environmentId={dialog.environmentId}
        bot={null}
        initial={{
          name: nextBotName(snapshot.bots),
          color: face.color,
          shape: face.shape,
          voice: "crisp",
          charter: "",
        }}
        onClose={close}
      />
    );
  }
  const bot = snapshot.bots.find((candidate) => candidate.id === dialog.botId);
  if (bot === undefined) return null;
  return (
    <BotDialog
      key={bot.id}
      environmentId={dialog.environmentId}
      bot={bot}
      initial={bot}
      onClose={close}
    />
  );
}

function BotDialog(props: {
  readonly environmentId: EnvironmentId;
  /** Null when creating. */
  readonly bot: Bot | null;
  readonly initial: Pick<Bot, "name" | "color" | "shape" | "voice" | "charter">;
  readonly onClose: () => void;
}) {
  const create = useAtomCommand(botsEnvironment.create, { reportFailure: false });
  const update = useAtomCommand(botsEnvironment.update);
  const navigate = useNavigate();
  const [name, setName] = useState(props.initial.name);
  const [color, setColor] = useState(props.initial.color);
  const [shape, setShape] = useState<BotShape>(props.initial.shape);
  const [voice, setVoice] = useState<BotVoice>(props.initial.voice);
  const [charter, setCharter] = useState(props.initial.charter);
  const [picture, setPicture] = useState<PictureChoice>({ kind: "keep" });
  const pictureInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const trimmedName = name.trim();
  const shownName = trimmedName === "" ? "It" : trimmedName;
  const hasPicture =
    picture.kind === "file" || (picture.kind === "keep" && (props.bot?.picture ?? null) !== null);

  const choosePicture = (file: File | undefined) => {
    if (file === undefined) return;
    if (!isPictureMimeType(file.type) || file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      toastManager.add({
        type: "error",
        title: "That picture can't be used",
        description: "Pick a GIF, PNG, JPEG or WebP image up to 10 MB.",
      });
      return;
    }
    if (picture.kind === "file") URL.revokeObjectURL(picture.previewUrl);
    setPicture({ kind: "file", file, mimeType: file.type, previewUrl: URL.createObjectURL(file) });
  };

  /** Uploads a chosen picture; undefined leaves the bot's picture alone, null removes it. */
  const pictureInput = async (): Promise<
    { readonly attachmentId: string } | null | undefined | "failed"
  > => {
    if (picture.kind === "keep") return undefined;
    if (picture.kind === "remove") return null;
    const uploaded = await uploadImageAttachment({
      environmentId: props.environmentId,
      file: picture.file,
      mimeType: picture.mimeType,
    });
    if (uploaded.status === "uploaded") return { attachmentId: uploaded.attachmentId };
    toastManager.add({ type: "error", title: "Could not upload the picture" });
    return "failed";
  };

  const save = async () => {
    if (trimmedName === "" || busy) return;
    setBusy(true);
    const face = { ...(isBotColor(color) ? { color } : {}), shape, voice };
    if (props.bot === null) {
      const result = await create({
        environmentId: props.environmentId,
        input: { name: trimmedName, charter: charter.trim(), starter: "default", ...face },
      });
      toastCommandFailure("Could not create the bot", result);
      if (result._tag !== "Success") {
        setBusy(false);
        return;
      }
      const chosen = await pictureInput();
      if (chosen !== undefined && chosen !== null && chosen !== "failed") {
        const withPicture = await update({
          environmentId: props.environmentId,
          input: { botId: result.value.id, picture: chosen },
        });
        toastCommandFailure("Could not set the picture", withPicture);
      }
      setBusy(false);
      props.onClose();
      await navigate({
        to: "/bots/$environmentId/$botId",
        params: { environmentId: props.environmentId, botId: result.value.id },
      });
      return;
    }
    const chosen = await pictureInput();
    if (chosen === "failed") {
      setBusy(false);
      return;
    }
    const result = await update({
      environmentId: props.environmentId,
      input: {
        botId: props.bot.id,
        name: trimmedName,
        charter: charter.trim(),
        ...face,
        ...(chosen === undefined ? {} : { picture: chosen }),
      },
    });
    setBusy(false);
    toastCommandFailure("Could not save the bot", result);
    if (result._tag === "Success") props.onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-[480px]">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.bot === null ? "New bot" : `Edit ${props.bot.name}`}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="grid grid-cols-[64px_1fr] items-start gap-x-3 gap-y-4">
              <span className="pt-2 text-muted-foreground text-sm">Face</span>
              <div className="flex flex-wrap items-center gap-1.5">
                <div className="flex gap-1.5" role="group" aria-label="Shape">
                  {BotShape.literals.map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-label={BOT_SHAPE_LABELS[option]}
                      aria-pressed={shape === option}
                      className={cn(
                        "flex size-9 items-center justify-center rounded-lg border border-border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        shape === option && "border-foreground/64 bg-accent",
                      )}
                      onClick={() => setShape(option)}
                    >
                      <BotAvatar bot={{ color, shape: option }} size="lg" />
                    </button>
                  ))}
                </div>
                <div className="ms-2 flex gap-0.5" role="group" aria-label="Colour">
                  {BOT_COLORS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-label={option}
                      aria-pressed={color === option}
                      className={cn(
                        "flex size-7 items-center justify-center rounded-full border-2 border-transparent outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        color === option && "border-foreground/64",
                      )}
                      onClick={() => setColor(option)}
                    >
                      <span className="size-5 rounded-full" style={{ backgroundColor: option }} />
                    </button>
                  ))}
                </div>
              </div>

              <span className="pt-2 text-muted-foreground text-sm">Picture</span>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  {picture.kind === "file" ? (
                    <img
                      alt=""
                      src={picture.previewUrl}
                      className="size-9 rounded-lg object-cover"
                    />
                  ) : (
                    <BotAvatar
                      bot={{
                        color,
                        shape,
                        picture: picture.kind === "remove" ? null : (props.bot?.picture ?? null),
                      }}
                      size="row"
                      environmentId={props.environmentId}
                      animated
                      className="m-1"
                    />
                  )}
                  <input
                    ref={pictureInputRef}
                    type="file"
                    accept={PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.join(",")}
                    className="hidden"
                    onChange={(event) => {
                      choosePicture(event.currentTarget.files?.[0]);
                      event.currentTarget.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => pictureInputRef.current?.click()}
                  >
                    {hasPicture ? "Replace…" : "Upload a GIF or image…"}
                  </Button>
                  {hasPicture ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (picture.kind === "file") URL.revokeObjectURL(picture.previewUrl);
                        setPicture(props.bot?.picture ? { kind: "remove" } : { kind: "keep" });
                      }}
                    >
                      Use the face
                    </Button>
                  ) : null}
                </div>
                <p className="text-muted-foreground text-xs">
                  Shown instead of the face. A GIF plays while the bot works.
                </p>
              </div>

              <label htmlFor="bot-dialog-name" className="pt-2 text-muted-foreground text-sm">
                Name
              </label>
              <Input
                id="bot-dialog-name"
                autoFocus
                value={name}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setName(event.currentTarget.value)}
              />

              <label htmlFor="bot-dialog-role" className="pt-2 text-muted-foreground text-sm">
                Role
              </label>
              <div className="flex flex-col gap-1.5">
                <Input
                  id="bot-dialog-role"
                  value={charter}
                  placeholder="What it's for, e.g. Frontend work in pair"
                  onChange={(event) => setCharter(event.currentTarget.value)}
                />
                <p className="text-muted-foreground text-xs">
                  Shown under its name. {shownName} reads this as its job.
                </p>
              </div>

              <span className="pt-1 text-muted-foreground text-sm">Voice</span>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2.5">
                  <ToggleGroup
                    aria-label="Voice"
                    variant="segmented"
                    value={[voice]}
                    onValueChange={(next) => {
                      const value = next[0];
                      if (isBotVoice(value)) setVoice(value);
                    }}
                  >
                    {BotVoice.literals.map((option) => (
                      <Toggle key={option} value={option}>
                        {BOT_VOICE_LABELS[option].label}
                      </Toggle>
                    ))}
                  </ToggleGroup>
                  <span className="text-muted-foreground text-xs">
                    {BOT_VOICE_LABELS[voice].description}
                  </span>
                </div>
                <p className="rounded-lg border border-border bg-card px-2.5 py-2 text-xs leading-relaxed">
                  {VOICE_SAMPLES[voice]}
                </p>
                <p className="text-muted-foreground text-xs">
                  Changes how it sounds, not what it reports. Questions and session tasks are always
                  plain.
                </p>
              </div>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || trimmedName === ""}>
              {props.bot === null ? "Create" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
