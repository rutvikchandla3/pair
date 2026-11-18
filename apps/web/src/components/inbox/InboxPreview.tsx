import { useAtomValue } from "@effect/atom-react";
import { inboxRowCopy } from "@t3tools/client-runtime/inbox";
import { type SpaceViewer, spaceTaskStatusInfo } from "@t3tools/client-runtime/spaces";
import {
  buildPendingUserInputAnswers,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  seedUserInputDraftAnswers,
  type ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import type {
  EnvironmentId,
  InboxItem,
  RuntimeRequestId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import * as Option from "effect/Option";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { derivePendingUserInputProgress } from "../../pendingUserInput";
import { BotInboxAskActions } from "../bots/BotInboxAskActions";
import { openSpaceThreadDialog } from "../spaces/spaceThreadDialogStore";
import { useCanOperateSpaces } from "../../state/spaces";
import {
  environmentThreadDetails,
  threadEnvironment,
  useEnvironmentThread,
} from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadApprovalCard } from "../chat/ChildThreadApprovals";
import { ComposerPendingUserInputPanel } from "../chat/ComposerPendingUserInputPanel";
import { SpaceTaskStatusGlyph } from "../spaces/SpaceStatusIcon";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import { ThreadFollowButton } from "./ThreadFollowButton";

const ANSWER_HINT = "Answering here answers in the thread";
const LATEST_MESSAGES = 4;

/** The selected item, answered or acted on in place where it can be. */
export function InboxPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly item: InboxItem;
  readonly viewer: SpaceViewer;
  readonly onOpen: () => void;
}) {
  const { item } = props;
  const copy = inboxRowCopy(item, props.viewer);
  const thread =
    item.threadId === undefined
      ? null
      : { environmentId: props.environmentId, threadId: item.threadId };
  const openLabel =
    item.reason === "task-assigned" || item.reason === "task-handed-back"
      ? "Open task"
      : item.reason === "mention" ||
          item.reason === "pair-reply" ||
          item.reason === "added-to-space"
        ? "Open room"
        : item.reason === "bot-ask" || item.reason === "bot-job-done"
          ? "Open bot"
          : "Open thread";
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex min-w-0 items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
          {[item.spaceName, item.taskTitle ?? item.threadTitle]
            .filter((part): part is string => part !== undefined)
            .join(" / ") || copy.title}
        </p>
        {item.taskStatus === undefined ? null : <TaskStatus status={item.taskStatus} />}
        {thread !== null && item.reason === "shared-with-you" ? (
          <ThreadFollowButton thread={thread} />
        ) : null}
        <Button size="sm" variant="outline" onClick={props.onOpen}>
          {openLabel}
          <ChevronRightIcon />
        </Button>
      </div>
      {item.reason === "task-assigned" || item.reason === "task-handed-back" ? (
        <TaskPreview environmentId={props.environmentId} item={item} title={copy.title} />
      ) : thread !== null ? (
        <>
          <LatestMessages thread={thread} viewer={props.viewer} />
          {item.reason === "approval" ? (
            <PendingApprovals thread={thread} requestId={item.requestId ?? null} />
          ) : item.reason === "question" ? (
            <PendingQuestion thread={thread} />
          ) : item.excerpt === undefined ? null : (
            <Excerpt text={item.excerpt} />
          )}
        </>
      ) : (
        <>
          <p className="font-medium text-sm">{copy.title}</p>
          {item.excerpt === undefined ? null : <Excerpt text={item.excerpt} />}
          {item.reason === "bot-ask" && item.botId !== undefined && item.askId !== undefined ? (
            <BotInboxAskActions
              environmentId={props.environmentId}
              botId={item.botId}
              askId={item.askId}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function TaskStatus(props: { readonly status: NonNullable<InboxItem["taskStatus"]> }) {
  const info = spaceTaskStatusInfo(props.status);
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
      <SpaceTaskStatusGlyph icon={info.icon} tone={info.tone} />
      {info.label}
    </span>
  );
}

function Excerpt(props: { readonly text: string }) {
  return (
    <blockquote className="whitespace-pre-wrap border-l-2 border-border ps-3 text-sm">
      {props.text}
    </blockquote>
  );
}

function TaskPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly item: InboxItem;
  readonly title: string;
}) {
  const { item } = props;
  const canOperate = useCanOperateSpaces(props.environmentId);
  const spaceId = item.spaceId;
  const taskId = item.taskId;
  return (
    <div className="flex flex-col gap-3">
      <p className="font-medium text-sm">{props.title}</p>
      {item.excerpt === undefined ? null : <Excerpt text={item.excerpt} />}
      {canOperate && spaceId !== undefined && taskId !== undefined ? (
        <div>
          <Button
            size="sm"
            onClick={() =>
              openSpaceThreadDialog({
                type: "start",
                environmentId: props.environmentId,
                spaceId,
                taskId,
              })
            }
          >
            Start a thread
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The thread's last few messages, so the request reads in context. */
function LatestMessages(props: { readonly thread: ScopedThreadRef; readonly viewer: SpaceViewer }) {
  const state = useEnvironmentThread(props.thread.environmentId, props.thread.threadId);
  const projection = Option.getOrNull(state.data);
  if (projection === null) return null;
  const messages = projection.messages
    .filter((message) => message.role !== "system" && message.text.trim().length > 0)
    .slice(-LATEST_MESSAGES);
  return (
    <div className="flex flex-col gap-3">
      {messages.map((message) => {
        const mine = message.role === "user";
        return (
          <div key={message.id} className={cn("flex flex-col gap-1", mine && "items-end")}>
            {mine ? (
              <span className="font-medium text-xs">
                {message.authorId === undefined || message.authorId === props.viewer.memberId
                  ? "You"
                  : props.viewer.nameOf(message.authorId)}
              </span>
            ) : null}
            <p
              className={cn(
                "line-clamp-6 whitespace-pre-wrap text-sm",
                mine && "max-w-[80%] rounded-lg bg-muted px-3 py-2",
              )}
            >
              {message.text}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function PendingApprovals(props: {
  readonly thread: ScopedThreadRef;
  readonly requestId: RuntimeRequestId | null;
}) {
  const requests = useAtomValue(environmentThreadDetails.pendingRequestsAtom(props.thread));
  const approvals = (requests?.approvals ?? []).filter(
    (approval) => props.requestId === null || approval.requestId === props.requestId,
  );
  return (
    <div className="flex flex-col gap-2">
      {approvals.map((approval) => (
        <ThreadApprovalCard
          key={approval.requestId}
          thread={props.thread}
          approval={approval}
          label="Approval"
          heading="Approval needed"
          footer={<p className="mt-2 text-muted-foreground">{ANSWER_HINT}</p>}
        />
      ))}
    </div>
  );
}

function PendingQuestion(props: { readonly thread: ScopedThreadRef }) {
  const requests = useAtomValue(environmentThreadDetails.pendingRequestsAtom(props.thread));
  const prompt = requests?.userInputs[0];
  if (prompt === undefined) return null;
  return <QuestionAnswer key={prompt.requestId} thread={props.thread} prompt={prompt} />;
}

/** The chat's question card, with its answers held here instead of in the composer draft. */
function QuestionAnswer(props: {
  readonly thread: ScopedThreadRef;
  readonly prompt: ThreadPendingUserInput;
}) {
  const { prompt, thread } = props;
  const respond = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const dismiss = useAtomCommand(threadEnvironment.dismissUserInput, { reportFailure: false });
  const [stored, setStored] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [responding, setResponding] = useState(false);
  const answers = seedUserInputDraftAnswers(prompt.questions, stored);

  const advance = async () => {
    const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
    if (!progress.isLastQuestion) {
      if (progress.canAdvance) setQuestionIndex(progress.questionIndex + 1);
      return;
    }
    const resolved = buildPendingUserInputAnswers(prompt.questions, answers);
    if (resolved === null) return;
    setResponding(true);
    const result = await respond({
      environmentId: thread.environmentId,
      input: { threadId: thread.threadId, requestId: prompt.requestId, answers: resolved },
    });
    setResponding(false);
    if (!isAtomCommandInterrupted(result)) toastCommandFailure("Could not answer", result);
  };

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border">
      <ComposerPendingUserInputPanel
        pendingUserInputs={[prompt]}
        cwd={undefined}
        threadRef={thread}
        respondingRequestIds={responding ? [prompt.requestId] : []}
        answers={answers}
        questionIndex={questionIndex}
        onToggleOption={(questionId, optionValue) => {
          const question = prompt.questions.find((entry) => entry.id === questionId);
          if (question === undefined) return;
          setStored({
            ...stored,
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              stored[questionId],
              optionValue,
            ),
          });
        }}
        onAdvance={() => void advance()}
        onDismiss={async (requestId) =>
          toastCommandFailure(
            "Could not dismiss",
            await dismiss({
              environmentId: thread.environmentId,
              input: { threadId: thread.threadId, requestId },
            }),
          )
        }
      />
      <p className="px-4 pb-2 text-muted-foreground text-xs">{ANSWER_HINT}</p>
    </div>
  );
}
