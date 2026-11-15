import { useAtomValue } from "@effect/atom-react";
import { offerDialogCopy, updateDialogCopy } from "@t3tools/client-runtime/branch-lineage";
import {
  type LineageUpdateResolver,
  type MemberId,
  PROVIDER_DISPLAY_NAMES,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ArrowDownToLineIcon,
  CheckIcon,
  CircleAlertIcon,
  FileIcon,
  GitCompareArrowsIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { useQuietThreadShell } from "~/state/entities";
import { branchLineageEnvironment, useLineageView, useLineageViewer } from "~/state/branchLineage";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useTeamMembers } from "~/state/team";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { MemberAvatar } from "../team/MemberAvatar";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Textarea } from "../ui/textarea";
import { closeLineageDialog, lineageDialogAtom } from "./lineageDialogTarget";
import { useLineageActions } from "./useLineageActions";

export function LineageDialogHost() {
  const target = useAtomValue(lineageDialogAtom);
  if (target === null) return null;
  const key = `${target.kind}:${target.threadRef.environmentId}:${target.threadRef.threadId}`;
  return target.kind === "offer" ? (
    <OfferDialog key={key} threadRef={target.threadRef} />
  ) : (
    <UpdateDialog key={key} threadRef={target.threadRef} />
  );
}

function LineageDialogFrame(props: {
  readonly title: string;
  readonly description: string | null;
  readonly children: ReactNode;
  readonly footer: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeLineageDialog();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          {props.description === null ? null : (
            <DialogDescription>{props.description}</DialogDescription>
          )}
        </DialogHeader>
        <DialogPanel>{props.children}</DialogPanel>
        <DialogFooter className="sm:items-center">{props.footer}</DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function LoadingFrame({ title, error }: { readonly title: string; readonly error: string | null }) {
  return (
    <LineageDialogFrame
      title={title}
      description={null}
      footer={
        <Button size="sm" variant="outline" onClick={closeLineageDialog}>
          {error === null ? "Cancel" : "Close"}
        </Button>
      }
    >
      <p className={error === null ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>
        {error ?? "Checking…"}
      </p>
    </LineageDialogFrame>
  );
}

function OfferDialog({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { environmentId } = threadRef;
  const preview = useEnvironmentQuery(
    branchLineageEnvironment.offerPreview({
      environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const view = useLineageView(threadRef);
  const viewer = useLineageViewer(environmentId);
  const members = useTeamMembers(environmentId);
  const actions = useLineageActions();
  const offerCreate = useOrchestrationCommand(branchLineageEnvironment.offerCreate, {
    reportFailure: false,
  });
  const [note, setNote] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [sending, setSending] = useState(false);
  if (preview.data === null) {
    return <LoadingFrame title="Offer your changes" error={preview.error} />;
  }
  const data = preview.data;
  const copy = offerDialogCopy(data, {
    viewer,
    lineage: view?.lineage ?? null,
    sourceTurn: null,
  });
  const me = viewer.memberId === null ? undefined : members.get(viewer.memberId);
  const nothing = data.commits.length === 0 && data.uncommittedFiles.length === 0;
  const send = async () => {
    setSending(true);
    const trimmedNote = note.trim();
    const trimmedMessage = commitMessage.trim();
    const result = await offerCreate({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        ...(trimmedNote === "" ? {} : { note: trimmedNote }),
        ...(trimmedMessage === "" ? {} : { commitMessage: trimmedMessage }),
      },
    });
    setSending(false);
    if (result._tag !== "Success") {
      toastCommandFailure("Couldn't offer", result);
      return;
    }
    closeLineageDialog();
  };
  return (
    <LineageDialogFrame
      title={copy.title}
      description={copy.description}
      footer={
        <>
          <span className="me-auto text-xs text-muted-foreground">{copy.footer}</span>
          <Button size="sm" variant="outline" onClick={closeLineageDialog}>
            Cancel
          </Button>
          {copy.primary.kind === "offer" ? (
            <Button size="sm" disabled={nothing || sending} onClick={() => void send()}>
              <GitCompareArrowsIcon aria-hidden />
              {copy.primary.label}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                closeLineageDialog();
                void actions.startUpdate(threadRef);
              }}
            >
              <ArrowDownToLineIcon aria-hidden />
              {copy.primary.label}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {copy.summary}
            <DiffStatLabel layout="inline" additions={data.additions} deletions={data.deletions} />
          </span>
          {data.commits.map((commit) => (
            <span key={commit.sha} className="flex min-w-0 items-center gap-2">
              {me === undefined ? null : <MemberAvatar member={me} size="sm" />}
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {commit.sha.slice(0, 7)}
              </span>
              <span className="truncate">{commit.subject}</span>
            </span>
          ))}
        </div>
        {copy.uncommitted === null ? null : (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">{copy.uncommitted}</span>
            {data.uncommittedFiles.map((path) => (
              <span key={path} className="flex items-center gap-1.5 font-mono text-xs">
                <FileIcon aria-hidden className="size-3 text-muted-foreground" />
                {path}
              </span>
            ))}
            <Input
              aria-label="Commit message"
              placeholder="Commit message"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.currentTarget.value)}
            />
          </div>
        )}
        <Textarea
          aria-label="Note"
          placeholder="Add a note for them (optional)"
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
        />
        <div className="flex gap-2 text-xs">
          {copy.check.clean ? (
            <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success-foreground" />
          ) : (
            <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          )}
          <span className="flex flex-col gap-1">
            <span className={copy.check.clean ? "text-success-foreground" : "text-destructive"}>
              {copy.check.text}
            </span>
            <span className="text-muted-foreground">{copy.check.note}</span>
          </span>
        </div>
        {nothing ? (
          <p className="text-xs text-muted-foreground">There's nothing new to offer.</p>
        ) : null}
      </div>
    </LineageDialogFrame>
  );
}

function UpdateDialog({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { environmentId } = threadRef;
  const preview = useEnvironmentQuery(
    branchLineageEnvironment.updatePreview({
      environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const shell = useQuietThreadShell(threadRef);
  const viewer = useLineageViewer(environmentId);
  const providers = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.providers;
  const actions = useLineageActions();
  const [choice, setChoice] = useState<LineageUpdateResolver>("agent");
  const [sending, setSending] = useState(false);
  if (preview.data === null || shell === null) {
    return <LoadingFrame title="Update" error={preview.error} />;
  }
  const driver = providers?.find(
    (provider) => provider.instanceId === shell.providerInstanceId,
  )?.driver;
  const sourceOwnerId: MemberId | null = shell.source.branchLink?.source?.ownerId ?? null;
  const copy = updateDialogCopy(preview.data, {
    viewer,
    sourceOwnerId,
    providerName: (driver === undefined ? undefined : PROVIDER_DISPLAY_NAMES[driver]) ?? "agent",
    turnRunning: shell.source.activeRunId !== null,
  });
  const submit = async () => {
    setSending(true);
    const done = await actions.runUpdate(threadRef, choice);
    setSending(false);
    if (done !== null) closeLineageDialog();
  };
  return (
    <LineageDialogFrame
      title={copy.title}
      description={copy.summary}
      footer={
        <>
          {copy.footer === null ? null : (
            <span className="me-auto text-xs text-muted-foreground">{copy.footer}</span>
          )}
          <Button size="sm" variant="outline" onClick={closeLineageDialog}>
            Cancel
          </Button>
          <Button size="sm" disabled={sending} onClick={() => void submit()}>
            <ArrowDownToLineIcon aria-hidden />
            {copy.primary}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <ul className="flex flex-col gap-1">
          {copy.files.map((file) => (
            <li key={file.path} className="flex min-w-0 items-center gap-2 text-xs">
              {file.conflict ? (
                <CircleAlertIcon aria-hidden className="size-3 shrink-0 text-destructive" />
              ) : (
                <FileIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
              <span
                className={file.conflict ? "shrink-0 text-destructive" : "text-muted-foreground"}
              >
                {file.label}
              </span>
            </li>
          ))}
        </ul>
        {copy.choices.length === 0 ? null : (
          <RadioGroup
            aria-label="How to resolve the conflict"
            value={choice}
            onValueChange={(next) => setChoice(next as LineageUpdateResolver)}
          >
            {copy.choices.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2"
              >
                <Radio value={option.value} className="mt-0.5" />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.cost}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
        )}
      </div>
    </LineageDialogFrame>
  );
}
