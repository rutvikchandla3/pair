import {
  BOT_DEFAULT_INSTRUCTIONS,
  BOT_LIMIT_LABELS,
  type Bot,
  type BotLimit,
  type BotNote,
  type BotsSnapshot,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AlertTriangleIcon, SparklesIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { botsEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { RelativeTime } from "../RelativeTime";
import { toastCommandFailure } from "../team/toastCommandFailure";

const LIMIT_ORDER = Object.keys(BOT_LIMIT_LABELS) as ReadonlyArray<BotLimit>;

function Section(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly right?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="mt-5 first:mt-0">
      <div className="flex items-center gap-2">
        <h2 className="font-medium text-sm">{props.title}</h2>
        <span className="flex-1" />
        {props.right}
      </div>
      <p className="mt-0.5 mb-2 text-muted-foreground text-xs">{props.subtitle}</p>
      {props.children}
    </section>
  );
}

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
  const remove = async () => {
    const result = await deleteNote({
      environmentId: props.environmentId,
      input: { noteId: props.note.id },
    });
    toastCommandFailure("Could not remove the note", result);
  };
  const cited =
    props.note.citedCount === 0
      ? "not cited yet"
      : `cited by ${props.note.citedCount} decision${props.note.citedCount === 1 ? "" : "s"}`;
  return (
    <div className="flex items-start gap-2.5 border-t border-border px-3 py-2 first:border-t-0">
      <SparklesIcon className="mt-0.5 size-3.5 shrink-0 text-input-foreground" />
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              autoFocus
              className="flex-1"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
                if (event.key === "Escape") setEditing(false);
              }}
            />
            <Button size="sm" onClick={() => void save()}>
              Save
            </Button>
          </div>
        ) : (
          <p className="text-sm">{props.note.text}</p>
        )}
        <p className="text-muted-foreground text-xs">
          {props.note.source} · <RelativeTime timestamp={props.note.updatedAt} /> · {cited}
        </p>
      </div>
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
      <Button size="sm" variant="ghost-muted" onClick={() => void remove()}>
        Remove
      </Button>
    </div>
  );
}

/** The Playbook: Instructions (autosaved), Learned notes, and Check with me before. */
export function BotPlaybook(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly snapshot: BotsSnapshot;
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
        toastCommandFailure("Could not save the playbook", result);
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
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
      <div className="mx-auto w-full max-w-[720px] px-3 py-4">
        <Section
          title="Instructions"
          subtitle={`Your taste and standing orders. ${props.bot.name} reads them before every turn.`}
          right={
            <span className="text-muted-foreground text-xs">
              {busy ? "Saving…" : saved ? "Saved" : ""}
            </span>
          }
        >
          <Textarea
            value={instructions}
            placeholder={BOT_DEFAULT_INSTRUCTIONS}
            onChange={(event) => setInstructions(event.target.value)}
            className="min-h-40"
          />
        </Section>

        <Section
          title="Learned"
          subtitle={`Notes ${props.bot.name} saved from your answers and from Chat.`}
        >
          <div className="rounded-lg border border-border bg-card">
            {notes.length === 0 ? (
              <p className="px-3 py-3 text-muted-foreground text-sm">Nothing learned yet.</p>
            ) : (
              notes.map((note) => (
                <NoteRow key={note.id} environmentId={props.environmentId} note={note} />
              ))
            )}
          </div>
        </Section>

        <Section
          title="Check with me before"
          subtitle={`${props.bot.name} asks you instead of deciding these, and tells every session to stop and ask.`}
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
          <div className="mt-2 flex items-start gap-1.5 rounded-md bg-muted px-2.5 py-2 text-muted-foreground text-xs">
            <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
            Sessions run with full access in their own worktree, so these are instructions, not
            locks.
          </div>
        </Section>
      </div>
    </div>
  );
}
