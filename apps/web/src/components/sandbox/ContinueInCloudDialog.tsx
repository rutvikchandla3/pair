import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CONTINUE_IN_CLOUD_BUSY_LABEL,
  CONTINUE_IN_CLOUD_LABEL,
  MOVE_EXCLUDE_NOTE,
  MOVE_IN_PROGRESS_NOTE,
  MOVE_STAYS_NOTE,
  moveNothingToUpload,
} from "@t3tools/client-runtime/state/threadMove";
import {
  type AuthMcpClientAccess,
  CLOUD_MOVE_DEFAULT_MESSAGE,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Result from "effect/Result";
import { Atom } from "effect/reactivity";
import { useId, useRef, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useLinkableMachines, useLinkMachine } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import {
  cloudAccountNoticeAtom,
  readContinueInCloudOffer,
  useContinueInCloudOffer,
} from "~/state/sandbox";
import { threadMoveEnvironment } from "~/state/threadMove";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { LinkAccessPicker } from "../settings/LinkAccessPicker";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

const FAILURE_TITLE = "Could not continue in cloud";
const LINK_ACCESS_NOTE =
  "Threads you move there start with at most this access, and agents here never get more.";

/** The menu, the palette and the sidebar all close as they run, so the app root renders it once. */
const continueInCloudThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("sandbox:continue-in-cloud-thread"),
);

export function openContinueInCloudDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(continueInCloudThreadAtom, threadRef);
}

export function ContinueInCloudDialogHost() {
  const threadRef = useAtomValue(continueInCloudThreadAtom);
  if (threadRef === null) return null;
  return (
    <ContinueInCloudDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(continueInCloudThreadAtom, null)}
    />
  );
}

function ContinueInCloudDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const navigate = useNavigate();
  // The Pair Clouds when the dialog opened; the live offer below says when one can't take it now.
  const [targets] = useState(() => {
    const offer = readContinueInCloudOffer(threadRef);
    return offer.kind === "ready" ? offer.targets : [];
  });
  const offer = useContinueInCloudOffer(threadRef);
  const [targetId, setTargetId] = useState<EnvironmentId | null>(targets[0]?.environmentId ?? null);
  const target = targets.find((candidate) => candidate.environmentId === targetId) ?? null;
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState(CLOUD_MOVE_DEFAULT_MESSAGE);
  const [access, setAccess] = useState<AuthMcpClientAccess>("approval-required");
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(false);
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const preview = useEnvironmentQuery(
    target === null
      ? null
      : threadMoveEnvironment.preview({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, cloudEnvironmentId: target.environmentId },
        }),
  );
  const accountNotice = useAtomValue(
    cloudAccountNoticeAtom(target?.environmentId ?? threadRef.environmentId),
  );
  const notice = target === null ? null : accountNotice;
  const linkable = useLinkableMachines(
    threadRef.environmentId,
    preview.data !== null && preview.data.link.status !== "linked",
  );
  const linkMachine = useLinkMachine(threadRef.environmentId);
  const toCloud = useAtomCommand(threadMoveEnvironment.toCloud, { reportFailure: false });

  const data = preview.data;
  const linkProblem = data !== null && data.link.status !== "linked" ? data.link.message : null;
  const machine =
    linkable.find((candidate) => candidate.environmentId === target?.environmentId) ?? null;
  const blockedReason = offer.kind === "disabled" ? offer.reason : null;
  const allExcluded = data !== null && data.files.every((file) => excluded.has(file.path));
  const moving = busy || data?.moving === true;
  const canMove =
    target !== null &&
    data !== null &&
    linkProblem === null &&
    notice?.kind !== "provider" &&
    blockedReason === null &&
    message.trim().length > 0 &&
    !moving;

  const link = async () => {
    if (machine === null || linking) return;
    setLinking(true);
    const linked = await linkMachine(machine, access);
    setLinking(false);
    if (Result.isFailure(linked)) {
      if (linked.failure.message !== null) {
        toastManager.add({
          type: "error",
          title: "Could not link the environment",
          description: linked.failure.message,
        });
      }
      return;
    }
    preview.refresh();
  };

  const submit = async () => {
    if (inFlight.current || !canMove || target === null) return;
    inFlight.current = true;
    setBusy(true);
    const result = await toCloud({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        cloudEnvironmentId: target.environmentId,
        cloudProjectId: target.projectId,
        excludePaths: [...excluded],
        message: message.trim(),
        creationSource: "web",
      },
    });
    inFlight.current = false;
    setBusy(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: FAILURE_TITLE,
        description: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    toastManager.add({ type: "success", title: `Continued in cloud on ${target.label}` });
    onClose();
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(result.value.cloudThread),
    });
  };

  const toggle = (path: string, include: boolean) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (include) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          id={formId}
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{CONTINUE_IN_CLOUD_LABEL}</DialogTitle>
            <DialogDescription>
              {data === null
                ? "Reading this thread's branch and changes…"
                : `${data.branch} from ${data.baseRef}`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4 text-sm">
              {targets.length > 1 ? (
                <div className="space-y-1.5">
                  <Label htmlFor={`${formId}-target`}>Pair Cloud</Label>
                  <Select
                    value={targetId}
                    onValueChange={(next) => {
                      if (next !== null) setTargetId(next as EnvironmentId);
                    }}
                  >
                    <SelectTrigger id={`${formId}-target`}>
                      <SelectValue>{target?.label}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {targets.map((candidate) => (
                        <SelectItem key={candidate.environmentId} value={candidate.environmentId}>
                          {candidate.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}
              {preview.error !== null ? (
                <Alert variant="error">
                  <AlertDescription>{preview.error}</AlertDescription>
                </Alert>
              ) : null}
              {linkProblem !== null ? (
                <Alert variant="warning">
                  <AlertDescription>
                    <div className="flex flex-col gap-2">
                      <span>{linkProblem}</span>
                      {machine !== null ? (
                        <>
                          <LinkAccessPicker
                            value={access}
                            onChange={setAccess}
                            disabled={linking}
                            note={LINK_ACCESS_NOTE}
                          />
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            className="self-start"
                            disabled={linking}
                            onClick={() => void link()}
                          >
                            Link
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </AlertDescription>
                </Alert>
              ) : null}
              {notice !== null && target !== null ? (
                <Alert variant="warning">
                  <AlertTitle>{notice.title}</AlertTitle>
                  <AlertDescription>
                    <div className="flex flex-col gap-2">
                      <span>{notice.description}</span>
                      <Button
                        size="xs"
                        variant="outline"
                        className="self-start"
                        render={
                          <Link to="/settings/team" search={{ machine: target.environmentId }} />
                        }
                      >
                        Open Settings
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              ) : null}
              {blockedReason !== null ? (
                <Alert variant="warning">
                  <AlertDescription>{blockedReason}</AlertDescription>
                </Alert>
              ) : null}
              {data?.moving === true ? (
                <Alert variant="info">
                  <AlertDescription>{MOVE_IN_PROGRESS_NOTE}</AlertDescription>
                </Alert>
              ) : null}
              {data !== null && data.commits.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-xs font-medium">Commits</div>
                  <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {data.commits.map((commit) => (
                      <li key={commit.sha} className="truncate">
                        <span className="font-mono">{commit.sha.slice(0, 7)}</span> {commit.subject}
                      </li>
                    ))}
                    {data.commitsTruncated ? <li>and more</li> : null}
                  </ul>
                </div>
              ) : null}
              {data !== null && data.files.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-xs font-medium">Changes</div>
                  <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
                    {data.files.map((file) => (
                      <li key={file.path}>
                        <label className="flex items-center gap-2">
                          <Checkbox
                            checked={!excluded.has(file.path)}
                            disabled={moving}
                            onCheckedChange={(checked) => toggle(file.path, checked === true)}
                          />
                          <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                          <span className="shrink-0 text-muted-foreground">
                            +{file.insertions} −{file.deletions}
                          </span>
                        </label>
                      </li>
                    ))}
                    {data.filesTruncated ? (
                      <li className="text-muted-foreground">and more</li>
                    ) : null}
                  </ul>
                  <p className="text-xs text-muted-foreground">{MOVE_EXCLUDE_NOTE}</p>
                </div>
              ) : null}
              {data !== null && data.pushed && data.files.length > 0 && allExcluded ? (
                <Alert variant="info">
                  <AlertDescription>{moveNothingToUpload(data.branch)}</AlertDescription>
                </Alert>
              ) : null}
              <p className="text-xs text-muted-foreground">{MOVE_STAYS_NOTE}</p>
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-message`}>First message</Label>
                <Textarea
                  id={`${formId}-message`}
                  value={message}
                  disabled={moving}
                  onChange={(event) => setMessage(event.target.value)}
                />
              </div>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canMove}>
              {moving ? CONTINUE_IN_CLOUD_BUSY_LABEL : CONTINUE_IN_CLOUD_LABEL}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
