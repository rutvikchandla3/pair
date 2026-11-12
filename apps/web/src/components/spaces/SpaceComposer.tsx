import { SPACE_PAIR_NEEDS_KEY_HINT } from "@t3tools/client-runtime/spaceAgent";
import {
  PAIR_MENTION,
  type SpaceMentionQuery,
  type SpaceMentionToken,
  type SpaceViewer,
  insertSpaceMention,
  resolveSpaceMentions,
  spaceComposerHint,
  spaceMentionCandidates,
  spaceMentionQuery,
} from "@t3tools/client-runtime/spaces";
import {
  type EnvironmentId,
  MessageId,
  SPACE_QUOTE_MAX_LENGTH,
  type Space,
  type SpaceRoomEntry,
} from "@t3tools/contracts";
import { ArrowUpIcon, SparklesIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";

import { cn, randomUUID } from "~/lib/utils";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useSpaceTeamClaudeKey } from "../../state/spaceAgent";
import { spaceEnvironment } from "../../state/spaces";
import { useTeamMembers } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { MemberAvatar } from "../team/MemberAvatar";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";

type Post = Extract<SpaceRoomEntry, { type: "post" }>;

export function SpaceComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly viewer: SpaceViewer;
  readonly quote: Post | null;
  readonly onQuoteChange: (quote: Post | null) => void;
  /** A draft to start from, as "Ask again" fills it; remount the composer to apply another. */
  readonly initialText?: string | undefined;
}) {
  const members = useTeamMembers(props.environmentId);
  const narrow = useMediaQuery("max-sm");
  const post = useAtomCommand(spaceEnvironment.post, "Post to space");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pairReady = useSpaceTeamClaudeKey(props.environmentId);
  const [text, setText] = useState(props.initialText ?? "");
  const [tokens, setTokens] = useState<ReadonlyArray<SpaceMentionToken>>(() =>
    props.initialText?.startsWith("@pair ") ? [PAIR_MENTION] : [],
  );
  const [query, setQuery] = useState<SpaceMentionQuery | null>(null);
  const [highlight, setHighlight] = useState(0);

  // Without a Team Claude key, @pair isn't offered and a typed one isn't a tag.
  const candidates = (
    query === null ? [] : spaceMentionCandidates(query.query, props.space, props.viewer)
  ).filter((token) => pairReady || token.mention.type !== "pair");
  const mentions = resolveSpaceMentions(text, tokens).filter(
    (mention) => pairReady || mention.type !== "pair",
  );
  const hint =
    spaceComposerHint(mentions, props.space, props.viewer) ??
    (pairReady ? null : SPACE_PAIR_NEEDS_KEY_HINT);
  const tagsPair = mentions.some((mention) => mention.type === "pair");
  const canSend = text.trim().length > 0;

  const readQuery = (element: HTMLTextAreaElement) => {
    setQuery(spaceMentionQuery(element.value, element.selectionStart));
    setHighlight(0);
  };

  const choose = (token: SpaceMentionToken) => {
    if (query === null) return;
    const next = insertSpaceMention(text, query, token);
    setText(next.text);
    setTokens([...tokens, token]);
    setQuery(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const insertPair = () => {
    const element = textareaRef.current;
    const caret = element?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const start = before.length === 0 || /\s$/u.test(before) ? caret : caret + 1;
    const spaced = start === caret ? text : `${before} ${text.slice(caret)}`;
    const next = insertSpaceMention(spaced, { start, end: start, query: "" }, PAIR_MENTION);
    setText(next.text);
    setTokens([...tokens, PAIR_MENTION]);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const send = async () => {
    const body = text.trim();
    if (body.length === 0) return;
    const quote = props.quote;
    const sentTokens = tokens;
    setText("");
    setTokens([]);
    setQuery(null);
    props.onQuoteChange(null);
    const result = await post({
      environmentId: props.environmentId,
      input: {
        spaceId: props.space.id,
        messageId: MessageId.make(randomUUID()),
        text: body,
        mentions,
        ...(quote === null ? {} : { quoteEntryId: quote.id }),
      },
    });
    if (result._tag === "Failure") {
      // Hand the draft back, mentions and quote too, unless a new one was started.
      if (textareaRef.current?.value === "") {
        setText(body);
        setTokens(sentTokens);
        if (quote !== null) props.onQuoteChange(quote);
      }
      toastCommandFailure("Could not post", result);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (candidates.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((highlight + step + candidates.length) % candidates.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        choose(candidates[highlight] ?? candidates[0]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setQuery(null);
        return;
      }
    }
    if (event.key === "Escape" && props.quote !== null) {
      props.onQuoteChange(null);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="chat-composer-lane shrink-0 pb-4">
      <div className="chat-content-lane relative rounded-xl border border-input bg-background shadow-xs/5 focus-within:border-ring">
        {candidates.length > 0 ? (
          <div
            role="listbox"
            aria-label="Mention"
            className="absolute bottom-full left-0 z-20 mb-1 w-64 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-lg"
          >
            {candidates.map((token, index) => {
              const member =
                token.mention.type === "member" ? members.get(token.mention.memberId) : undefined;
              return (
                <button
                  key={token.mention.type === "pair" ? "pair" : token.mention.memberId}
                  type="button"
                  role="option"
                  aria-selected={index === highlight}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                    index === highlight && "bg-accent",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => choose(token)}
                >
                  {token.mention.type === "pair" ? (
                    <SparklesIcon className="size-5 text-input-foreground" />
                  ) : (
                    <MemberAvatar
                      size="sm"
                      member={{
                        name: token.label,
                        color: member?.color ?? "var(--muted-foreground)",
                      }}
                    />
                  )}
                  <span className="truncate">{token.label}</span>
                  {token.mention.type === "pair" ? (
                    <span className="ml-auto text-muted-foreground text-xs">agent</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
        {props.quote === null ? null : (
          <div className="flex items-start gap-2 border-border border-b px-3 py-2 text-xs">
            <div className="min-w-0 flex-1 border-border border-l-2 pl-2 text-muted-foreground">
              <span className="font-medium text-foreground">
                Replying to {props.viewer.nameOf(props.quote.authorId)}
              </span>
              <span className="line-clamp-1">
                {props.quote.text.slice(0, SPACE_QUOTE_MAX_LENGTH)}
              </span>
            </div>
            <Button
              size="icon-micro"
              variant="ghost-muted"
              aria-label="Cancel reply"
              onClick={() => props.onQuoteChange(null)}
            >
              <XIcon />
            </Button>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          aria-label="Message the space"
          placeholder={
            narrow
              ? "Message · @ to mention"
              : "Message the space · @ to mention Pair or a teammate"
          }
          className="field-sizing-content block max-h-48 min-h-11 w-full resize-none bg-transparent px-3 py-3 text-sm outline-none placeholder:text-muted-foreground"
          onChange={(event) => {
            setText(event.target.value);
            readQuery(event.target);
          }}
          onSelect={(event) => readQuery(event.currentTarget)}
          onBlur={() => setQuery(null)}
          onKeyDown={onKeyDown}
        />
        <div className="flex items-center gap-2 px-3 pb-2">
          <Button
            size="xs"
            variant={tagsPair ? "secondary" : "ghost-muted"}
            aria-pressed={tagsPair}
            disabled={!pairReady || tagsPair}
            onClick={insertPair}
          >
            <SparklesIcon />
            @pair
          </Button>
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs",
              tagsPair ? "text-input-foreground" : "text-muted-foreground",
            )}
          >
            {hint}
          </span>
          <Button size="icon-xs" aria-label="Send" disabled={!canSend} onClick={() => void send()}>
            <ArrowUpIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}
