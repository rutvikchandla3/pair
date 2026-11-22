import {
  BotAskId,
  BotId,
  RunId,
  ThreadId,
  type BotAsk,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import {
  BotQuestionsPopover,
  questionCountLabel,
  type BotAnswer,
  type BotAnswerOutcome,
  type BotQuestion,
} from "./BotQuestionsPopover";

const ENV = "env-1" as EnvironmentId;

function ask(id: string, overrides: Partial<BotAsk> = {}): BotAsk {
  return {
    id: BotAskId.make(id),
    botId: BotId.make("bot-1"),
    jobId: null,
    question: `Question ${id}?`,
    why: "",
    options: [],
    pick: null,
    status: "open",
    answerKind: null,
    answer: null,
    remember: false,
    noteId: null,
    homeRunId: null,
    createdAt: "2026-11-18T10:00:00.000Z",
    answeredAt: null,
    ...overrides,
  };
}

const MERGE = ask("merge", {
  question: "Merge pair #56 now?",
  why: "CI is green and the review is done.",
  options: ["Merge it", "Wait for me"],
  pick: "Merge it",
  homeRunId: RunId.make("run-merge"),
});
const BRANCH = ask("branch", { question: "Protect pair-be main?" });
const MERGE_ABOUT = { title: "Review and merge pair #56", threadId: ThreadId.make("thread-56") };

function Harness(props: {
  readonly questions: ReadonlyArray<BotQuestion>;
  readonly onAnswer: (answer: BotAnswer) => Promise<BotAnswerOutcome>;
  readonly onShowInChat?: (runId: RunId) => void;
  readonly canAnswer?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <BotQuestionsPopover
      environmentId={ENV}
      botName="Atlas"
      label={questionCountLabel(props.questions.length)}
      questions={props.questions}
      canAnswer={props.canAnswer ?? true}
      open={open}
      onOpenChange={setOpen}
      onAnswer={props.onAnswer}
      onShowInChat={props.onShowInChat ?? (() => {})}
    />
  );
}

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => (resolve = done));
  return { promise, resolve };
}

describe("BotQuestionsPopover", () => {
  it("opens from the pill, answers each way, and drops answered cards down to empty", async () => {
    const onAnswer = vi.fn(async (_answer: BotAnswer): Promise<BotAnswerOutcome> => "answered");
    await using _screen = await render(
      <Harness
        questions={[
          { ask: MERGE, about: MERGE_ABOUT },
          { ask: BRANCH, about: null },
        ]}
        onAnswer={onAnswer}
      />,
    );

    await userEvent.click(page.getByRole("button", { name: "2 questions for you" }));
    await expect.element(page.getByRole("heading", { name: "2 questions for you" })).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: MERGE_ABOUT.title }))
      .toHaveAttribute("href", "/env-1/thread-56");

    await userEvent.click(page.getByRole("button", { name: "Merge it · Atlas's pick" }));
    expect(onAnswer).toHaveBeenLastCalledWith({
      askId: MERGE.id,
      kind: "option",
      answer: "Merge it",
    });
    // The confirmed card leaves before the snapshot catches up, and focus stays in the panel.
    await expect.element(page.getByRole("heading", { name: "1 question for you" })).toBeVisible();
    await expect.element(page.getByText(MERGE.question)).not.toBeInTheDocument();
    expect(page.getByRole("dialog").element().contains(document.activeElement)).toBe(true);

    await userEvent.type(page.getByRole("textbox", { name: "Your own answer" }), " Yes {Enter}");
    expect(onAnswer).toHaveBeenLastCalledWith({ askId: BRANCH.id, kind: "text", answer: "Yes" });
    await expect.element(page.getByRole("heading", { name: "No questions for you" })).toBeVisible();
    await expect.element(page.getByText("Nothing needs you right now.")).toBeVisible();
  });

  it("locks a card while sending without dropping focus, and unlocks it on failure", async () => {
    const pending = deferred<BotAnswerOutcome>();
    const onAnswer = vi.fn((_answer: BotAnswer) => pending.promise);
    await using _screen = await render(
      <Harness questions={[{ ask: BRANCH, about: null }]} onAnswer={onAnswer} />,
    );

    await userEvent.click(page.getByRole("button", { name: "1 question for you" }));
    const decide = page.getByRole("button", { name: "Let Atlas decide" });
    await userEvent.click(decide);
    expect(onAnswer).toHaveBeenLastCalledWith({ askId: BRANCH.id, kind: "bot-decides" });
    await expect.element(decide).toHaveAttribute("aria-disabled", "true");
    await expect.element(decide).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onAnswer).toHaveBeenCalledTimes(1);

    pending.resolve("failed");
    await expect.element(decide).toHaveAttribute("aria-disabled", "false");
    await expect.element(page.getByText(BRANCH.question)).toBeVisible();
  });

  it("drops a question resolved elsewhere and moves focus out of its card", async () => {
    const onAnswer = vi.fn(async (): Promise<BotAnswerOutcome> => "answered");
    const both = [
      { ask: MERGE, about: null },
      { ask: BRANCH, about: null },
    ];
    await using screen = await render(<Harness questions={both} onAnswer={onAnswer} />);

    await userEvent.click(page.getByRole("button", { name: "2 questions for you" }));
    const mergeInput = page
      .getByRole("region", { name: MERGE.question })
      .getByRole("textbox", { name: "Your own answer" });
    await userEvent.click(mergeInput);
    await expect.element(mergeInput).toHaveFocus();

    await screen.rerender(<Harness questions={[both[1]!]} onAnswer={onAnswer} />);
    await expect.element(page.getByRole("heading", { name: "1 question for you" })).toBeVisible();
    await expect.element(page.getByText(MERGE.question)).not.toBeInTheDocument();
    expect(page.getByRole("dialog").element().contains(document.activeElement)).toBe(true);
  });

  it("shows questions read-only on a connection that can't answer", async () => {
    await using _screen = await render(
      <Harness
        questions={[{ ask: MERGE, about: null }]}
        onAnswer={async () => "answered"}
        canAnswer={false}
      />,
    );

    await userEvent.click(page.getByRole("button", { name: "1 question for you" }));
    await expect.element(page.getByText("This connection can't answer questions.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: /Merge it/ })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Show in chat" })).toBeVisible();
  });

  it("closes and jumps to the asking turn from Show in chat", async () => {
    const onShowInChat = vi.fn();
    await using _screen = await render(
      <Harness
        questions={[{ ask: MERGE, about: null }]}
        onAnswer={async () => "answered"}
        onShowInChat={onShowInChat}
      />,
    );

    await userEvent.click(page.getByRole("button", { name: "1 question for you" }));
    await userEvent.click(page.getByRole("button", { name: "Show in chat" }));
    expect(onShowInChat).toHaveBeenCalledWith(MERGE.homeRunId);
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });
});
