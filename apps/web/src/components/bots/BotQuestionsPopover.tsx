import type {
  BotAsk,
  BotsAnswerAskInput,
  EnvironmentId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useId, useRef, useState, type FormEvent, type RefObject } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

export interface BotQuestion {
  readonly ask: BotAsk;
  /** The session or job it is about; `threadId` is set when there is a session to open. */
  readonly about: { readonly title: string; readonly threadId: ThreadId | null } | null;
}

export type BotAnswer = Omit<BotsAnswerAskInput, "remember" | "ifOpen">;

/** `answered` covers an answer that landed elsewhere first; the card leaves either way. */
export type BotAnswerOutcome = "answered" | "failed";

export function questionCountLabel(count: number): string {
  if (count === 0) return "No questions for you";
  return count === 1 ? "1 question for you" : `${count} questions for you`;
}

/**
 * The header pill and the panel it opens: each open question with its suggested answers, a box for
 * your own, and "Let <bot> decide". Answering resolves the ask; resolved asks leave the list.
 */
export function BotQuestionsPopover(props: {
  readonly environmentId: EnvironmentId;
  readonly botName: string;
  readonly label: string;
  readonly questions: ReadonlyArray<BotQuestion>;
  readonly canAnswer: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAnswer: (answer: BotAnswer) => Promise<BotAnswerOutcome>;
  readonly onShowInChat: (runId: RunId) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // Answers the server confirmed; their cards leave without waiting for the snapshot.
  const [answeredHere, setAnsweredHere] = useState<ReadonlySet<string>>(() => new Set());
  const questions = props.questions.filter((question) => !answeredHere.has(question.ask.id));

  const answer = async (input: BotAnswer) => {
    const outcome = await props.onAnswer(input);
    if (outcome === "answered") {
      const live = new Set<string>(props.questions.map((question) => question.ask.id));
      setAnsweredHere((current) => new Set([...current, input.askId].filter((id) => live.has(id))));
    }
    return outcome;
  };

  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-input-foreground text-xs whitespace-nowrap hover:bg-accent"
          />
        }
      >
        <MessageCircleQuestionIcon className="size-3" aria-hidden />
        {props.label}
        <ChevronRightIcon className="size-3" aria-hidden />
      </PopoverTrigger>
      <PopoverPopup align="start" width="lg" padding="none">
        <div className="flex max-h-[min(70vh,36rem)] flex-col">
          <PopoverTitle
            render={
              <h2
                aria-live="polite"
                className="shrink-0 border-b border-border px-4 py-3 font-semibold text-sm"
              />
            }
          >
            {questionCountLabel(questions.length)}
          </PopoverTitle>
          <div ref={listRef} tabIndex={-1} className="min-h-0 overflow-y-auto outline-none">
            {questions.length === 0 ? (
              <p className="px-4 py-6 text-center text-muted-foreground text-sm">
                Nothing needs you right now.
              </p>
            ) : (
              questions.map((question) => (
                <QuestionCard
                  key={question.ask.id}
                  environmentId={props.environmentId}
                  botName={props.botName}
                  question={question}
                  canAnswer={props.canAnswer}
                  listRef={listRef}
                  onAnswer={answer}
                  onShowInChat={(runId) => {
                    props.onOpenChange(false);
                    props.onShowInChat(runId);
                  }}
                />
              ))
            )}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function QuestionCard(props: {
  readonly environmentId: EnvironmentId;
  readonly botName: string;
  readonly question: BotQuestion;
  readonly canAnswer: boolean;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly onAnswer: (answer: BotAnswer) => Promise<BotAnswerOutcome>;
  readonly onShowInChat: (runId: RunId) => void;
}) {
  const { ask, about } = props.question;
  const homeRunId = ask.homeRunId;
  const questionId = useId();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  // aria-disabled, not disabled: a disabled control drops focus to the page mid-send.
  const send = async (answer: BotAnswer) => {
    if (sending) return;
    setSending(true);
    if ((await props.onAnswer(answer)) === "failed") setSending(false);
  };
  const submitDraft = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (text === "") return;
    void send({ askId: ask.id, kind: "text", answer: text });
  };

  return (
    <section
      // A card answered here or elsewhere unmounts; keep focus in the panel instead of the page.
      ref={(node) => () => {
        if (node?.contains(document.activeElement)) props.listRef.current?.focus();
      }}
      aria-labelledby={questionId}
      aria-busy={sending}
      className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0"
    >
      {about === null ? null : about.threadId === null ? (
        <p className="truncate text-muted-foreground text-xs">{about.title}</p>
      ) : (
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: props.environmentId, threadId: about.threadId }}
          className="truncate text-muted-foreground text-xs hover:text-foreground hover:underline"
        >
          {about.title}
        </Link>
      )}
      <h3 id={questionId} className="font-medium text-sm">
        {ask.question}
      </h3>
      {ask.why.trim() === "" ? null : (
        <p className="line-clamp-2 text-muted-foreground text-xs">{ask.why}</p>
      )}
      {!props.canAnswer ? (
        <p className="text-muted-foreground text-xs">This connection can't answer questions.</p>
      ) : (
        <>
          {ask.options.length === 0 ? null : (
            <div className="flex flex-wrap gap-1.5">
              {ask.options.map((option) => (
                <Button
                  key={option}
                  size="sm-multiline"
                  variant="outline"
                  aria-disabled={sending}
                  onClick={() => void send({ askId: ask.id, kind: "option", answer: option })}
                >
                  {option}
                  {option === ask.pick ? (
                    <span className="text-muted-foreground text-xs">· {props.botName}'s pick</span>
                  ) : null}
                </Button>
              ))}
            </div>
          )}
          <form className="flex gap-1.5" onSubmit={submitDraft}>
            <Input
              size="sm"
              className="flex-1"
              aria-label="Your own answer"
              placeholder="Type your own answer…"
              value={draft}
              readOnly={sending}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
            <Button type="submit" size="sm" aria-disabled={sending || draft.trim() === ""}>
              Send
            </Button>
          </form>
        </>
      )}
      <div className="flex gap-1">
        {!props.canAnswer ? null : (
          <Button
            size="xs"
            variant="ghost-muted"
            aria-disabled={sending}
            onClick={() => void send({ askId: ask.id, kind: "bot-decides" })}
          >
            Let {props.botName} decide
          </Button>
        )}
        {homeRunId === null ? null : (
          <Button size="xs" variant="ghost-muted" onClick={() => props.onShowInChat(homeRunId)}>
            Show in chat
          </Button>
        )}
      </div>
    </section>
  );
}
