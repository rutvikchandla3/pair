import type { Bot, BotAsk, BotJob, BotNote } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, MessageCircleQuestionIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";

import { botsEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { RelativeTime } from "../RelativeTime";
import { endSentence } from "./bots.logic";

const jobLine = (ask: BotAsk, job: BotJob | null): string => {
  if (job === null) return "";
  return `J-${job.number} · ${job.title} · `;
};

/** An open Ask: the question, why, one-click answers, a text field and Let it decide. */
export function BotAskCard(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly ask: BotAsk;
  readonly job: BotJob | null;
}) {
  const answerAsk = useAtomCommand(botsEnvironment.answerAsk);
  const [text, setText] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);

  const answer = async (kind: "option" | "text" | "bot-decides", value?: string) => {
    setBusy(true);
    const result = await answerAsk({
      environmentId: props.environmentId,
      input: {
        askId: props.ask.id,
        kind,
        ...(value === undefined ? {} : { answer: value }),
        remember: kind === "text" ? remember : false,
      },
    });
    setBusy(false);
    toastCommandFailure("Could not answer", result);
    if (result._tag === "Success") setText("");
  };

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start gap-2">
        <MessageCircleQuestionIcon className="mt-0.75 size-3.5 shrink-0 text-input-foreground" />
        <span className="min-w-0 flex-1 font-medium text-sm">{props.ask.question}</span>
        <span className="max-w-2/5 shrink-0 truncate pt-0.5 text-muted-foreground text-xs">
          {jobLine(props.ask, props.job)}
          <RelativeTime timestamp={props.ask.createdAt} />
        </span>
      </div>
      {props.ask.why.trim() === "" ? null : (
        <p className="mt-1 line-clamp-2 pl-5.5 text-muted-foreground text-sm">{props.ask.why}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-5.5">
        {props.ask.options.map((option) => (
          <Button
            key={option}
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void answer("option", option)}
          >
            {option}
          </Button>
        ))}
        {props.ask.pick === null ? null : (
          <span className="ml-0.5 text-muted-foreground text-xs">
            {props.bot.name} would pick <span className="text-foreground">{props.ask.pick}</span>
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          disabled={busy}
          onClick={() => void answer("bot-decides")}
        >
          Let {props.bot.name} decide
        </Button>
      </div>
      <div className="mt-2 flex items-center gap-2 pl-5.5">
        <Input
          size="sm"
          className="flex-1"
          placeholder="Answer in your own words…"
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && text.trim() !== "") {
              event.preventDefault();
              void answer("text", text.trim());
            }
          }}
        />
        <Button
          size="icon-sm"
          variant="secondary"
          aria-label="Send answer"
          disabled={busy || text.trim() === ""}
          onClick={() => void answer("text", text.trim())}
        >
          <CheckIcon />
        </Button>
        <label className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground text-xs">
          <Checkbox checked={remember} onCheckedChange={(value) => setRemember(value === true)} />
          Remember this
        </label>
      </div>
    </div>
  );
}

/** An answered Ask from the last day, with Remember this, the saved note and Change answer. */
export function BotAnsweredAskCard(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly ask: BotAsk;
  readonly job: BotJob | null;
  readonly note: BotNote | null;
}) {
  const rememberAsk = useAtomCommand(botsEnvironment.rememberAsk);
  const answerAsk = useAtomCommand(botsEnvironment.answerAsk);
  const updateNote = useAtomCommand(botsEnvironment.updateNote);
  const deleteNote = useAtomCommand(botsEnvironment.deleteNote);
  const [changing, setChanging] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [text, setText] = useState("");
  const [noteText, setNoteText] = useState("");
  const [busy, setBusy] = useState(false);
  const note = props.note;

  const remember = async () => {
    setBusy(true);
    const result = await rememberAsk({
      environmentId: props.environmentId,
      input: { askId: props.ask.id },
    });
    setBusy(false);
    toastCommandFailure("Could not save the note", result);
  };

  const removeNote = async () => {
    if (note === null) return;
    setBusy(true);
    const result = await deleteNote({
      environmentId: props.environmentId,
      input: { noteId: note.id },
    });
    setBusy(false);
    toastCommandFailure("Could not remove the note", result);
  };

  const saveNote = async () => {
    if (note === null || noteText.trim() === "") return;
    setBusy(true);
    const result = await updateNote({
      environmentId: props.environmentId,
      input: { noteId: note.id, text: noteText.trim() },
    });
    setBusy(false);
    toastCommandFailure("Could not save the note", result);
    if (result._tag === "Success") setEditingNote(false);
  };

  const change = async () => {
    if (text.trim() === "") return;
    setBusy(true);
    const result = await answerAsk({
      environmentId: props.environmentId,
      input: { askId: props.ask.id, kind: "text", answer: text.trim(), remember: false },
    });
    setBusy(false);
    toastCommandFailure("Could not change the answer", result);
    if (result._tag === "Success") {
      setChanging(false);
      setText("");
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start gap-2">
        <CheckIcon className="mt-0.75 size-3.5 shrink-0 text-success" />
        <span className="min-w-0 flex-1 font-medium text-sm">{props.ask.question}</span>
        <span className="max-w-2/5 shrink-0 truncate pt-0.5 text-muted-foreground text-xs">
          {jobLine(props.ask, props.job)}
          <RelativeTime timestamp={props.ask.answeredAt ?? props.ask.createdAt} />
        </span>
      </div>
      <p className="mt-1 pl-5.5 text-sm">
        {props.ask.answerKind === "bot-decides" ? (
          <>
            You let <span className="font-medium">{props.bot.name}</span> decide.
          </>
        ) : (
          <>
            {props.ask.answerKind === "text" ? "You answered: " : "You picked "}
            <span className="font-medium">{endSentence(props.ask.answer ?? "")}</span>
          </>
        )}{" "}
        {props.bot.name} is continuing.
      </p>
      {note === null ? null : editingNote ? (
        <div className="mt-2 flex items-center gap-2 pl-5.5">
          <Input
            size="sm"
            autoFocus
            className="flex-1"
            value={noteText}
            disabled={busy}
            onChange={(event) => setNoteText(event.target.value)}
          />
          <Button size="sm" disabled={busy} onClick={() => void saveNote()}>
            Save
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-muted px-2.5 py-2 pl-5.5 text-sm">
          <SparklesIcon className="size-3.5 shrink-0 text-input-foreground" />
          <span className="min-w-0 flex-1">{note.text}</span>
          <Button
            size="sm"
            variant="ghost-muted"
            disabled={busy}
            onClick={() => {
              setNoteText(note.text);
              setEditingNote(true);
            }}
          >
            Edit
          </Button>
          <Button size="sm" variant="ghost-muted" disabled={busy} onClick={() => void removeNote()}>
            Remove note
          </Button>
        </div>
      )}
      <div className="mt-2 flex items-center gap-2 pl-5.5">
        {!props.ask.remember && props.ask.noteId === null ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void remember()}>
            <SparklesIcon className="text-input-foreground" />
            Remember this
          </Button>
        ) : null}
        <Button size="sm" variant="link" disabled={busy} onClick={() => setChanging(!changing)}>
          Change answer
        </Button>
      </div>
      {changing ? (
        <div className="mt-2 flex items-center gap-2 pl-5.5">
          <Input
            size="sm"
            autoFocus
            className="flex-1"
            placeholder="New answer…"
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void change();
              }
              if (event.key === "Escape") setChanging(false);
            }}
          />
          <Button size="sm" disabled={busy || text.trim() === ""} onClick={() => void change()}>
            Answer
          </Button>
        </div>
      ) : null}
    </div>
  );
}
