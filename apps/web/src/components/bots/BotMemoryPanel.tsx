import {
  BOT_DEFAULT_INSTRUCTIONS,
  BOT_LIMIT_LABELS,
  type Bot,
  type BotLimit,
  type BotNote,
  type BotsSnapshot,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AlertTriangleIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { botsEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { RelativeTime } from "../RelativeTime";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const LIMIT_ORDER = Object.keys(BOT_LIMIT_LABELS) as ReadonlyArray<BotLimit>;

function NoteRow(props: { readonly environmentId: EnvironmentId; readonly note: BotNote }) {
  const updateNote = useAtomCommand(botsEnvironment.updateNote);
  const deleteNote = useAtomCommand(botsEnvironment.deleteNote);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(props.note.text);
  const save = async () => {
    if (text.trim() === "") return;
    const result = await updateNote({
      environmentId: props.environmentId,
      input: { noteId: props.note.id, text: text.trim() },
    });
    toastCommandFailure("Could not save the note", result);
    if (result._tag === "Success") setEditing(false);
  };
  const forget = async () => {
    const result = await deleteNote({
      environmentId: props.environmentId,
      input: { noteId: props.note.id },
    });
    toastCommandFailure("Could not forget the note", result);
  };
  return (
    <div className="rounded-md border border-border bg-card px-2.5 py-2">
      {editing ? (
        <Input
          size="sm"
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
            if (event.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <p className="text-sm">{props.note.text}</p>
      )}
      <div className="mt-1 flex items-center gap-2 text-muted-foreground text-xs">
        <span className="min-w-0 flex-1 truncate">
          {props.note.source} · <RelativeTime timestamp={props.note.updatedAt} />
        </span>
        <Button
          size="sm"
          variant="ghost-muted"
          onClick={() => {
            setText(props.note.text);
            setEditing(true);
          }}
        >
          Edit
        </Button>
        <Button size="sm" variant="ghost-muted" onClick={() => void forget()}>
          Forget
        </Button>
      </div>
    </div>
  );
}

function Section(props: {
  readonly title: string;
  readonly hint: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="font-medium text-sm">{props.title}</h2>
      <p className="text-muted-foreground text-xs">{props.hint}</p>
      {props.children}
    </section>
  );
}

/** The bot's Memory: instructions, learned notes and the "check with me before" limits. */
export function BotMemoryPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly snapshot: BotsSnapshot;
  readonly onClose: () => void;
}) {
  const update = useAtomCommand(botsEnvironment.update);
  const [instructions, setInstructions] = useState(props.bot.instructions);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const hydrated = useRef(false);
  const notes = props.snapshot.notes.filter((note) => note.botId === props.bot.id);
  const limits = props.bot.limits;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- debounces the textarea into bots.update 800ms after typing stops
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    const timer = setTimeout(() => {
      if (instructions === props.bot.instructions) return;
      setBusy(true);
      void update({
        environmentId: props.environmentId,
        input: { botId: props.bot.id, instructions },
      }).then((result) => {
        setBusy(false);
        toastCommandFailure("Could not save the instructions", result);
        if (result._tag === "Success") {
          setSaved(true);
          setTimeout(() => setSaved(false), 1500);
        }
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [instructions, props.environmentId, props.bot.id, props.bot.instructions, update]);

  const toggleLimit = async (limit: BotLimit) => {
    const next = limits.includes(limit)
      ? limits.filter((item) => item !== limit)
      : [...limits, limit];
    const result = await update({
      environmentId: props.environmentId,
      input: { botId: props.bot.id, limits: next },
    });
    toastCommandFailure("Could not save the limits", result);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3.5 py-2.5">
        <SparklesIcon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 font-medium text-sm">Memory</span>
        <span className="text-muted-foreground text-xs">
          {busy ? "Saving…" : saved ? "Saved" : ""}
        </span>
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label="Close memory"
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto scrollbar-gutter-both p-3.5">
        <Section
          title="Instructions"
          hint={`How you like work done. ${props.bot.name} reads this every turn.`}
        >
          <Textarea
            value={instructions}
            placeholder={BOT_DEFAULT_INSTRUCTIONS}
            onChange={(event) => setInstructions(event.target.value)}
            className="min-h-32"
          />
        </Section>

        <Section
          title="Learned"
          hint={`What ${props.bot.name} saved from your chats. Tell it “forget that” in chat, or here.`}
        >
          {notes.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing learned yet.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {notes.map((note) => (
                <NoteRow key={note.id} environmentId={props.environmentId} note={note} />
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Check with me before"
          hint={`${props.bot.name} asks you instead of deciding these, and tells every session to stop and ask.`}
        >
          <div className="flex flex-col">
            {LIMIT_ORDER.map((limit) => (
              <label key={limit} className="flex cursor-pointer items-center gap-2 py-1 text-sm">
                <Checkbox
                  checked={limits.includes(limit)}
                  onCheckedChange={() => void toggleLimit(limit)}
                />
                {BOT_LIMIT_LABELS[limit]}
              </label>
            ))}
          </div>
          <p className="mt-1.5 flex items-start gap-1.5 text-muted-foreground text-xs">
            <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
            Sessions run with full access in their own worktree, so these are instructions, not
            locks.
          </p>
        </Section>
      </div>
    </div>
  );
}
