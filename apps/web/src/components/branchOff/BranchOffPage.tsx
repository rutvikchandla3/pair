import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import {
  type LineageViewer,
  branchOffDraftCopy,
  runsOnOptions,
} from "@t3tools/client-runtime/branch-lineage";
import type {
  EnvironmentId,
  LineageRunsOn,
  ModelSelection,
  ThreadBranchOffDraft,
  ThreadId,
} from "@t3tools/contracts";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { GitBranchIcon, PlusIcon, ServerIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { branchLineageEnvironment, useRememberedRunsOn } from "../../state/branchLineage";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { SpaceModelPicker, useSpaceModelSelection } from "../spaces/SpaceModelPicker";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Label } from "../ui/label";
import { RadioGroup } from "../ui/radio-group";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { type StartFromValue, branchFromPrompt, startFromOf } from "./branchOff.logic";
import { useBranchOffViewer } from "./useBranchOff";

export function BranchOffRoutePage() {
  const params = useParams({ from: "/_chat/branch-off/$environmentId/$sourceThreadId" });
  const environmentId = params.environmentId as EnvironmentId;
  const sourceThreadId = params.sourceThreadId as ThreadId;
  const viewer = useBranchOffViewer(environmentId);
  const draft = useEnvironmentQuery(
    branchLineageEnvironment.branchOffDraft({ environmentId, input: { sourceThreadId } }),
  );
  const source = useQuietThreadShell({ environmentId, threadId: sourceThreadId });
  const sourceTitle = draft.data?.sourceTitle ?? source?.title ?? "Thread";

  return (
    <SidebarInset
      {...workspaceAreaProps("home", 1, "Branch off")}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <WorkspaceBreadcrumb ariaLabel="Branch off" className="flex-1">
            <WorkspaceBreadcrumbItem>
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId: sourceThreadId }}
                className="truncate rounded-sm hover:text-foreground"
              >
                {sourceTitle}
              </Link>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="min-w-0">
              <WorkspaceBreadcrumbText>New thread</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-12">
            {draft.data !== null && viewer !== null ? (
              <BranchOffDraftForm
                key={sourceThreadId}
                environmentId={environmentId}
                sourceThreadId={sourceThreadId}
                projectId={source?.projectId ?? null}
                draft={draft.data}
                viewer={viewer}
              />
            ) : draft.error !== null ? (
              <p className="text-destructive text-sm">{draft.error}</p>
            ) : viewer === null && draft.data !== null ? (
              <p className="text-muted-foreground text-sm">
                Branch off is for teams on Pair Cloud.
              </p>
            ) : (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Spinner />
                Loading…
              </div>
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

/** The draft: Start from, Runs on, Branch and Context, then the first message. */
export function BranchOffDraftForm(props: {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly projectId: ModelSelectionProjectId;
  readonly draft: ThreadBranchOffDraft;
  readonly viewer: LineageViewer;
}) {
  const { draft, environmentId, sourceThreadId, viewer } = props;
  const navigate = useNavigate();
  const [remembered, remember] = useRememberedRunsOn(environmentId);
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const model = useSpaceModelSelection(environmentId, props.projectId, picked);
  const providerName =
    model.entries.find((entry) => entry.instanceId === model.selection?.instanceId)?.displayName ??
    "Claude";
  const copy = branchOffDraftCopy(draft, viewer, providerName);
  const choice = runsOnOptions(draft, viewer, { remembered, providerName });
  const [chosenRunsOn, setChosenRunsOn] = useState<LineageRunsOn | null>(null);
  const runsOn =
    chosenRunsOn !== null && choice.options.some((option) => option.value === chosenRunsOn)
      ? chosenRunsOn
      : choice.selected;
  const [startFrom, setStartFrom] = useState<StartFromValue>("latest");
  const [startBranch, setStartBranch] = useState("main");
  const [prompt, setPrompt] = useState("");
  const [editedBranch, setEditedBranch] = useState<string | null>(null);
  const branch = editedBranch ?? branchFromPrompt(draft.suggestedBranch, prompt);
  const [withSummary, setWithSummary] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [busy, setBusy] = useState(false);
  const branchOff = useAtomCommand(branchLineageEnvironment.branchOff, { reportFailure: false });
  const branchOffSummary = useAtomCommand(branchLineageEnvironment.branchOffSummary, {
    reportFailure: false,
  });

  const connect =
    copy.blocked?.connect ?? (model.selection === null ? `Connect ${providerName}` : null);
  const start = startFromOf(startFrom, startBranch);
  const contextSummary = summary?.trim() ?? "";
  const ready =
    !busy &&
    copy.blocked === null &&
    model.selection !== null &&
    start !== null &&
    branch.trim() !== "" &&
    (prompt.trim() !== "" || contextSummary !== "");

  const toggleSummary = async (checked: boolean) => {
    setWithSummary(checked);
    if (!checked) {
      setSummary(null);
      return;
    }
    setSummarizing(true);
    const result = await branchOffSummary({
      environmentId,
      input: {
        sourceThreadId,
        ...(model.selection === null ? {} : { modelSelection: model.selection }),
      },
    });
    setSummarizing(false);
    toastCommandFailure("Could not write the summary", result);
    if (result._tag === "Success") setSummary(result.value.text);
    else setWithSummary(false);
  };

  const submit = async () => {
    if (!ready || start === null || model.selection === null) return;
    setBusy(true);
    const result = await branchOff({
      environmentId,
      input: {
        sourceThreadId,
        runsOn,
        startFrom: start,
        branch: branch.trim(),
        prompt: prompt.trim(),
        ...(contextSummary === "" ? {} : { contextSummary }),
        modelSelection: model.selection,
      },
    });
    setBusy(false);
    toastCommandFailure("Could not branch off", result);
    if (result._tag !== "Success") return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: result.value.threadId },
    });
  };

  const latestAt =
    draft.latestTurn.at === null ? null : formatRelativeTimeLabel(draft.latestTurn.at);
  const latestDetail =
    latestAt === null || latestAt === ""
      ? copy.latestDetail
      : copy.latestDetail.replace(/^(turn \d+)/, `$1 · ${latestAt}`);
  const startLabel =
    startFrom === "latest"
      ? copy.latestLabel
      : startFrom === "branch"
        ? "A branch"
        : (() => {
            const turn = draft.turns.find((candidate) => `turn:${candidate.runId}` === startFrom);
            return turn === undefined ? "An earlier turn" : `Turn ${turn.turn} · ${turn.title}`;
          })();

  return (
    <div
      className="flex flex-col gap-4"
      onKeyDown={(event) => {
        if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 font-semibold text-xl">
          <GitBranchIcon aria-hidden className="size-5" />
          {copy.title}
        </h1>
        <p className="text-muted-foreground text-sm">{copy.subtitle}</p>
      </div>

      <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-start gap-x-4 gap-y-3 rounded-xl border border-border bg-card p-4 text-sm">
        <div className="pt-1.5">
          <Label>Start from</Label>
        </div>
        <div className="flex flex-col gap-2">
          <Select
            value={startFrom}
            disabled={busy}
            onValueChange={(value) => setStartFrom(value as StartFromValue)}
          >
            <SelectTrigger size="sm" aria-label="Start from">
              <SelectValue>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{startLabel}</span>
                  {startFrom === "latest" ? (
                    <span className="truncate text-muted-foreground">{latestDetail}</span>
                  ) : null}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="latest">
                <span className="truncate">{copy.latestLabel}</span>
                <span className="truncate text-muted-foreground">{latestDetail}</span>
              </SelectItem>
              {draft.turns.length === 0 ? null : (
                <SelectGroup>
                  <SelectGroupLabel>Earlier turns</SelectGroupLabel>
                  {draft.turns.map((turn) => (
                    <SelectItem key={turn.runId} value={`turn:${turn.runId}`}>
                      <span className="truncate">
                        Turn {turn.turn} · {turn.title}
                      </span>
                      <span className="truncate text-muted-foreground">
                        {formatRelativeTimeLabel(turn.at)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              <SelectItem value="branch">A branch, such as main</SelectItem>
            </SelectPopup>
          </Select>
          {startFrom === "branch" ? (
            <Input
              aria-label="Start from branch"
              value={startBranch}
              placeholder="main"
              disabled={busy}
              onChange={(event) => setStartBranch(event.target.value)}
            />
          ) : null}
        </div>

        <div className="pt-1.5">
          <Label id="branch-off-runs-on">Runs on</Label>
        </div>
        <div className="flex flex-col gap-2">
          <RadioGroup
            aria-labelledby="branch-off-runs-on"
            value={runsOn}
            disabled={busy}
            onValueChange={(value) => {
              const next = value as LineageRunsOn;
              setChosenRunsOn(next);
              remember(next);
            }}
            className="grid grid-cols-1 sm:grid-cols-2"
          >
            {choice.options.map((option) => (
              <RadioPrimitive.Root
                key={option.value}
                value={option.value}
                aria-label={option.label}
                className="flex cursor-pointer items-start gap-2.5 rounded-lg bg-card px-3 py-2.5 text-left outline-none ring-1 ring-border ring-inset hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-checked:ring-2 data-checked:ring-inset data-checked:ring-primary"
              >
                <span
                  aria-hidden
                  className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-input"
                >
                  <RadioPrimitive.Indicator className="size-2 rounded-full bg-primary" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5 font-medium text-foreground">
                    {option.value === "new-machine" ? (
                      <PlusIcon aria-hidden className="size-3.5 text-muted-foreground" />
                    ) : (
                      <ServerIcon aria-hidden className="size-3.5 text-muted-foreground" />
                    )}
                    {option.label}
                  </span>
                  <span className="text-muted-foreground text-xs">{option.subtitle}</span>
                </span>
              </RadioPrimitive.Root>
            ))}
          </RadioGroup>
          {choice.reason === null ? null : (
            <p className="text-muted-foreground text-xs" data-testid="branch-off-runs-on-reason">
              {choice.reason}
            </p>
          )}
          <p className="text-muted-foreground text-xs" data-testid="branch-off-disclosure">
            {choice.disclosures[runsOn]}
          </p>
        </div>

        <div className="pt-1.5">
          <Label htmlFor="branch-off-branch">Branch</Label>
        </div>
        <Input
          id="branch-off-branch"
          value={branch}
          disabled={busy}
          onChange={(event) => setEditedBranch(event.target.value)}
        />

        <span className="pt-0.5 font-medium">Context</span>
        <label className="flex items-start gap-2">
          <Checkbox
            checked={withSummary}
            disabled={busy || summarizing || model.selection === null}
            onCheckedChange={(checked) => void toggleSummary(checked)}
          />
          <span className="flex flex-col">
            <span>{copy.contextLabel}</span>
            <span className="text-muted-foreground text-xs">{copy.contextHint}</span>
          </span>
        </label>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
        {summarizing ? (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <Spinner />
            Writing a summary of {draft.sourceTitle}…
          </div>
        ) : summary !== null ? (
          <div className="flex items-start gap-1">
            <Textarea
              aria-label="Summary"
              value={summary}
              disabled={busy}
              onChange={(event) => setSummary(event.target.value)}
            />
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Remove the summary"
              disabled={busy}
              onClick={() => {
                setSummary(null);
                setWithSummary(false);
              }}
            >
              <XIcon />
            </Button>
          </div>
        ) : null}
        <Textarea
          aria-label="Prompt"
          autoFocus
          value={prompt}
          disabled={busy}
          placeholder="What do you want to build on it?"
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <SpaceModelPicker
            environmentId={environmentId}
            projectId={props.projectId}
            value={picked}
            disabled={busy}
            onChange={setPicked}
          />
          {connect === null ? null : (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void navigate({ to: "/settings/providers" })}
            >
              {connect}
            </Button>
          )}
          <span className="ms-auto truncate text-muted-foreground text-xs">
            {copy.taskLine ?? ""}
          </span>
          <Button size="sm" disabled={!ready} onClick={() => void submit()}>
            <GitBranchIcon />
            {busy ? "Branching off…" : "Branch off"}
            <Kbd>⌘↵</Kbd>
          </Button>
        </div>
        {copy.blocked === null ? null : (
          <p className="text-muted-foreground text-xs">{copy.blocked.text}</p>
        )}
      </div>
    </div>
  );
}

type ModelSelectionProjectId = Parameters<typeof useSpaceModelSelection>[1];
