import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { getProviderClient } from "@t3tools/client-runtime/provider-clients";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  rebuildSuggestion,
  teamImageBuildPresentation,
  type TeamImageBuildPresentation,
} from "@t3tools/client-runtime/team-image-presentation";
import {
  type EnvironmentId,
  type MemberId,
  type ProjectId,
  type ServerSettingsPatch,
  type TeamImageBuild,
  type TeamImageBuildId,
  type TeamImageProposal,
  type TeamImageProposalId,
  type TeamImageRecipe,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import { AsyncResult } from "effect/reactivity";
import { useNavigate } from "@tanstack/react-router";
import { InfoIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { usePrimarySettings } from "~/hooks/useSettings";
import { formatBytes } from "~/lib/formatBytes";
import { useProjects, useThreadShell } from "~/state/entities";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { teamImageEnvironment } from "~/state/teamImage";
import { useTeamMembers } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Textarea } from "../ui/textarea";
import { ProviderEnvironmentSection } from "./ProviderInstanceCard";
import { useSecretSources } from "./SecretSourceInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  draftFromRecipe,
  EDIT_WITH_AGENT_PROMPT,
  fixWithAgentPrompt,
  installDiff,
  npmTokenWarning,
  RECIPE_CHANGED_MESSAGE,
  recipeChanges,
  recipeFromDraft,
  reservedBuildName,
  type TeamImageDraft,
} from "./TeamImageSettings.logic";

const EMPTY_RECIPE: TeamImageRecipe = {
  base: { type: "pair" },
  projectIds: [],
  buildEnv: {},
  buildSecrets: {},
  install: "",
};

const TONE_BADGE = {
  neutral: "secondary",
  success: "success",
  progress: "info",
  danger: "error",
} as const satisfies Record<TeamImageBuildPresentation["tone"], string>;

const REMOVED_IMAGE_REASON = "Pair Cloud removed this build's image to save disk.";

interface Edit {
  /** The revision the editor started from; a save names it. */
  readonly baseRevision: number | null;
  readonly draft: TeamImageDraft;
  /** An accepted proposal that this edit's save closes. */
  readonly acceptsProposalId?: TeamImageProposalId;
}

function isRecipeChangedFailure(result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag !== "Failure") return false;
  const error = squashAtomCommandFailure(result);
  return (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    error.reason === "recipe-changed"
  );
}

function warningParts(message: string): ReadonlyArray<{ text: string; code: boolean }> {
  return message.split("`").map((text, index) => ({ text, code: index % 2 === 1 }));
}

export function TeamImageSettings({
  environmentId,
  driversConfigured,
}: {
  readonly environmentId: EnvironmentId;
  /** A build runs on the default driver, so none means none can start. */
  readonly driversConfigured: boolean;
}) {
  const snapshotView = useEnvironmentQuery(
    teamImageEnvironment.snapshot({ environmentId, input: {} }),
  );
  const snapshot = snapshotView.data;
  const canEdit = useAtomValue(teamImageEnvironment.saveRecipe.permissionAtom(environmentId));
  const members = useTeamMembers(environmentId);
  const allProjects = useProjects();
  const secretSources = useSecretSources(environmentId);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const saveRecipe = useAtomCommand(teamImageEnvironment.saveRecipe, { reportFailure: false });
  const saveAndBuild = useAtomCommand(teamImageEnvironment.saveAndBuild, { reportFailure: false });
  const startBuild = useAtomCommand(teamImageEnvironment.startBuild, { reportFailure: false });
  const cancelBuild = useAtomCommand(teamImageEnvironment.cancelBuild, { reportFailure: false });
  const activateBuild = useAtomCommand(teamImageEnvironment.activateBuild, {
    reportFailure: false,
  });
  const readRecipe = useAtomCommand(teamImageEnvironment.readRecipe, { reportFailure: false });
  const dismissProposal = useAtomCommand(teamImageEnvironment.dismissProposal, {
    reportFailure: false,
  });
  const setSecret = useAtomCommand(teamImageEnvironment.setSecret, { reportFailure: false });
  const removeSecret = useAtomCommand(teamImageEnvironment.removeSecret, { reportFailure: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();
  const [edit, setEdit] = useState<Edit | null>(null);
  const [conflict, setConflict] = useState(false);
  const [openLog, setOpenLog] = useState<TeamImageBuildId | null>(null);
  const [openProposal, setOpenProposal] = useState<TeamImageProposalId | null>(null);
  const [busy, setBusy] = useState(false);

  const projects = allProjects.filter(
    (project) =>
      project.environmentId === environmentId && !project.archivedAt && project.isScratch !== true,
  );
  const projectName = (projectId: ProjectId) =>
    allProjects.find(
      (project) => project.environmentId === environmentId && project.id === projectId,
    )?.title ?? "A removed project";
  const memberName = (memberId: MemberId) => members.get(memberId)?.name;
  const formatTime = (time: DateTime.Utc) =>
    formatDayAwareTimestamp(DateTime.formatIso(time), timestampFormat);

  const saved = snapshot?.recipe ?? null;
  const savedRevision = saved?.revision ?? null;
  const savedRecipe = saved?.recipe ?? EMPTY_RECIPE;
  const storedSecrets = new Set(snapshot?.storedSecrets?.map((stored) => stored.name));
  const builds = snapshot?.builds ?? [];
  const proposals = snapshot?.proposals ?? [];
  const accepting = proposals.find((proposal) => proposal.id === edit?.acceptsProposalId) ?? null;
  const active = builds.find((build) => build.id === snapshot?.activeBuildId) ?? null;
  const activeNumber = active?.number ?? null;
  const presentations = new Map(
    builds.map((build) => [
      build.id,
      teamImageBuildPresentation(build, snapshot?.activeBuildId ?? null, {
        memberName,
        activeBuildNumber: activeNumber,
      }),
    ]),
  );
  const rebuildHint = canEdit ? rebuildSuggestion(active, snapshot?.currentBase) : null;
  const buildRunning = [...presentations.values()].some((presentation) => presentation.inProgress);

  const parsed = edit === null ? null : recipeFromDraft(edit.draft);
  const changes =
    parsed?.ok === true
      ? recipeChanges(savedRecipe, parsed.recipe, projectName, parsed.secretValues)
      : null;
  // An edit equal to what is saved, such as after Save and build refused the build, is no edit.
  const dirty = edit !== null && (parsed?.ok !== true || (changes?.length ?? 0) > 0);
  const stale = dirty && edit.baseRevision !== savedRevision;
  const draft = edit?.draft ?? draftFromRecipe(savedRecipe, storedSecrets);

  const buildBlocker = !driversConfigured
    ? "Add a driver under Compute first."
    : buildRunning
      ? "A build is already running."
      : null;

  const buildTitle =
    saved === null ? "Save a recipe first." : (buildBlocker ?? "Builds the saved recipe.");

  const update = (patch: Partial<TeamImageDraft>) => {
    setEdit({
      baseRevision: edit?.baseRevision ?? savedRevision,
      draft: { ...draft, ...patch },
      ...(edit?.acceptsProposalId === undefined
        ? {}
        : { acceptsProposalId: edit.acceptsProposalId }),
    });
    setConflict(false);
  };

  const acceptProposal = (proposal: TeamImageProposal) => {
    setEdit({
      baseRevision: edit?.baseRevision ?? savedRevision,
      draft: { ...draft, install: proposal.install },
      acceptsProposalId: proposal.id,
    });
    setConflict(false);
    setOpenProposal(null);
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: "The proposal is in the editor",
        description: "Save it to use it. Saving closes the proposal.",
      }),
    );
  };

  const reload = () => {
    setEdit(null);
    setConflict(false);
  };

  const run = async <A,>(
    title: string,
    action: () => Promise<AtomCommandResult<A, unknown>>,
  ): Promise<AtomCommandResult<A, unknown>> => {
    setBusy(true);
    const result = await action();
    setBusy(false);
    toastCommandFailure(title, result);
    return result;
  };

  const submit = async (andBuild: boolean) => {
    if (edit === null || parsed?.ok !== true) return;
    const { recipe, secretValues } = parsed;
    setBusy(true);
    // Values first, so the save that names them finds them on the server.
    for (const [name, value] of Object.entries(secretValues)) {
      const stored = await setSecret({
        environmentId,
        input: { name, value: Redacted.make(value) },
      });
      if (stored._tag !== "Success") {
        setBusy(false);
        toastCommandFailure("Secret not saved", stored);
        return;
      }
    }
    // Only new values: the saved recipe already names them, so there is no revision to add.
    if (savedRevision !== null && recipeChanges(savedRecipe, recipe, projectName).length === 0) {
      setEdit(null);
      setConflict(false);
      if (andBuild) {
        const result = await startBuild({
          environmentId,
          input: { recipeRevision: savedRevision },
        });
        toastCommandFailure("Build not started", result);
        if (result._tag === "Success") setOpenLog(result.value.id);
      }
      setBusy(false);
      return;
    }
    const input = {
      baseRevision: edit.baseRevision,
      recipe,
      ...(edit.acceptsProposalId === undefined
        ? {}
        : { acceptsProposalId: edit.acceptsProposalId }),
    };
    const result = andBuild
      ? await saveAndBuild({ environmentId, input })
      : await saveRecipe({ environmentId, input });
    if (result._tag === "Success") {
      setEdit(null);
      setConflict(false);
      if (andBuild && "id" in result.value) setOpenLog(result.value.id);
      // A value the saved recipe no longer names has no use left on the server.
      for (const name of storedSecrets) {
        const source = recipe.buildSecrets[name];
        if (source !== undefined && "kind" in source) continue;
        toastCommandFailure(
          "Old secret not removed",
          await removeSecret({ environmentId, input: { name } }),
        );
      }
      setBusy(false);
      return;
    }
    setBusy(false);
    if (isRecipeChangedFailure(result)) setConflict(true);
    else
      toastCommandFailure(
        andBuild ? "Recipe not saved or build not started" : "Recipe not saved",
        result,
      );
  };

  const build = async (recipeRevision: number) => {
    const result = await run("Build not started", () =>
      startBuild({ environmentId, input: { recipeRevision } }),
    );
    if (result._tag === "Success") setOpenLog(result.value.id);
  };

  const restoreRecipe = async (build: TeamImageBuild) => {
    const result = await run("Recipe not loaded", () =>
      readRecipe({ environmentId, input: { revision: build.recipeRevision } }),
    );
    if (result._tag !== "Success") return;
    setEdit({
      baseRevision: savedRevision,
      draft: draftFromRecipe(result.value.recipe, storedSecrets),
    });
    setConflict(false);
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: `Revision ${build.recipeRevision} is in the editor`,
        description: "Save it to use it again.",
      }),
    );
  };

  const saveKeepSucceeded = (keepSucceeded: number) => {
    const patch: ServerSettingsPatch = { sandbox: { teamImage: { keepSucceeded } } };
    void updateSettings({ environmentId, input: { patch } }).then((result) =>
      toastCommandFailure("Setting not saved", result),
    );
  };

  const startAgentThread = (projectId: ProjectId, prompt: string) => {
    void handleNewThread(scopeProjectRef(environmentId, projectId), {
      envMode: "cloud",
      prompt,
    });
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("cloud-team-image")}
        title="Team image"
        headerAction={
          snapshot === null ? undefined : (
            <Button size="xs" variant="ghost" onClick={snapshotView.refresh}>
              Refresh
            </Button>
          )
        }
      >
        {snapshot === null ? (
          <SettingsRow
            title="Team image"
            description={snapshotView.error ?? (snapshotView.isPending ? "Checking…" : "Loading…")}
          />
        ) : (
          <>
            <SettingsRow
              title={active === null ? "No team image yet" : `Build ${active.number} is active`}
              description={
                active === null
                  ? "Every session starts from Pair's base image. A team image adds your projects, tools and caches, so sessions start ready."
                  : activeSummary(active, formatTime, memberName, projectName)
              }
              control={
                canEdit ? (
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || buildBlocker !== null || saved === null}
                      title={buildTitle}
                      onClick={() => saved !== null && void build(saved.revision)}
                    >
                      Build
                    </Button>
                    <EditWithAgent
                      label="Edit with an agent"
                      projects={projects}
                      onPick={(projectId) => startAgentThread(projectId, EDIT_WITH_AGENT_PROMPT)}
                    />
                  </div>
                ) : undefined
              }
            >
              {rebuildHint === null ? null : (
                <div className="pb-2">
                  <Alert variant="info">
                    <InfoIcon aria-hidden />
                    <AlertDescription>{rebuildHint}</AlertDescription>
                    <AlertAction>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy || buildBlocker !== null || saved === null}
                        title={buildTitle}
                        onClick={() => saved !== null && void build(saved.revision)}
                      >
                        Build
                      </Button>
                    </AlertAction>
                  </Alert>
                </div>
              )}
            </SettingsRow>
            {canEdit && proposals.length > 0 ? (
              <>
                <SettingsRow
                  title={`Proposals (${proposals.length})`}
                  description="Agents suggested these install script changes. Nothing changes until you save one."
                />
                {proposals.map((proposal) => (
                  <ProposalRow
                    key={proposal.id}
                    environmentId={environmentId}
                    proposal={proposal}
                    savedInstall={savedRecipe.install}
                    open={openProposal === proposal.id}
                    busy={busy}
                    memberName={memberName}
                    formatTime={formatTime}
                    onToggle={() =>
                      setOpenProposal(openProposal === proposal.id ? null : proposal.id)
                    }
                    onAccept={() => acceptProposal(proposal)}
                    onDismiss={() =>
                      void run("Proposal not dismissed", () =>
                        dismissProposal({ environmentId, input: { proposalId: proposal.id } }),
                      )
                    }
                  />
                ))}
              </>
            ) : null}
            {canEdit ? (
              <RecipeEditor
                draft={draft}
                revision={savedRevision}
                dirty={dirty}
                accepting={accepting?.reason ?? null}
                parseError={parsed?.ok === false ? parsed.error : null}
                changes={changes}
                stale={stale || conflict}
                busy={busy}
                buildBlocker={buildBlocker}
                projects={projects}
                projectName={projectName}
                secretSources={secretSources}
                onChange={update}
                onReload={reload}
                onSave={() => void submit(false)}
                onSaveAndBuild={() => void submit(true)}
                canSave={dirty && parsed?.ok === true && !stale && !conflict}
              />
            ) : null}
            {canEdit ? (
              <SettingsRow
                title="Keep succeeded builds"
                description="Besides the active build and any a running session uses. Older ones are removed to save disk."
                control={
                  <NumberField
                    key={snapshot.keepSucceeded}
                    defaultValue={snapshot.keepSucceeded}
                    min={1}
                    max={20}
                    step={1}
                    size="sm"
                    className="w-auto"
                    onValueCommitted={(next) => {
                      if (next === null) return;
                      const keep = Math.min(20, Math.max(1, Math.round(next)));
                      if (keep !== snapshot.keepSucceeded) saveKeepSucceeded(keep);
                    }}
                  >
                    <NumberFieldGroup>
                      <NumberFieldDecrement aria-label="Decrease builds kept" />
                      <NumberFieldInput
                        aria-label="Succeeded builds kept"
                        size={4}
                        className="w-auto grow-0 text-right"
                      />
                      <NumberFieldIncrement aria-label="Increase builds kept" />
                    </NumberFieldGroup>
                  </NumberField>
                }
              />
            ) : null}
          </>
        )}
      </SettingsSection>

      {snapshot !== null && builds.length > 0 ? (
        <SettingsSection title="Build history">
          {builds.map((entry) => {
            const presentation = presentations.get(entry.id);
            if (presentation === undefined) return null;
            const logOpen = openLog === entry.id;
            return (
              <SettingsRow
                key={entry.id}
                title={
                  <span className="flex items-center gap-2">
                    {`Build ${entry.number}`}
                    <Badge variant={TONE_BADGE[presentation.tone]} size="sm">
                      {presentation.inProgress ? <Spinner size="xs" aria-hidden /> : null}
                      {presentation.status}
                    </Badge>
                  </span>
                }
                description={`${presentation.requester} · ${formatTime(entry.requestedAt)}`}
                control={
                  <div className="flex flex-wrap items-center gap-1.5">
                    {canEdit && presentation.inProgress ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run("Build not cancelled", () =>
                            cancelBuild({ environmentId, input: { imageBuildId: entry.id } }),
                          )
                        }
                      >
                        Cancel
                      </Button>
                    ) : null}
                    {canEdit &&
                    entry.status === "succeeded" &&
                    entry.id !== snapshot.activeBuildId ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy || !presentation.canActivate}
                        title={presentation.canActivate ? undefined : REMOVED_IMAGE_REASON}
                        onClick={() =>
                          void run("Build not activated", () =>
                            activateBuild({ environmentId, input: { imageBuildId: entry.id } }),
                          )
                        }
                      >
                        Activate
                      </Button>
                    ) : null}
                    {canEdit && entry.status === "succeeded" ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void restoreRecipe(entry)}
                      >
                        Restore recipe
                      </Button>
                    ) : null}
                    {canEdit && (entry.status === "failed" || entry.status === "cancelled") ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy || buildBlocker !== null}
                        title={buildBlocker ?? undefined}
                        onClick={() => void build(entry.recipeRevision)}
                      >
                        Retry
                      </Button>
                    ) : null}
                    {canEdit && entry.status === "failed" ? (
                      <EditWithAgent
                        label="Fix with an agent"
                        variant="ghost"
                        projects={projects}
                        onPick={(projectId) =>
                          startAgentThread(projectId, fixWithAgentPrompt(entry))
                        }
                      />
                    ) : null}
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-expanded={logOpen}
                      onClick={() => setOpenLog(logOpen ? null : entry.id)}
                    >
                      {logOpen ? "Hide log" : "Log"}
                    </Button>
                  </div>
                }
              >
                <div className="grid gap-2 pb-2">
                  {presentation.failure !== null ? (
                    <FailureDetail
                      message={presentation.failure}
                      tail={entry.failure?.logTail ?? []}
                    />
                  ) : null}
                  {logOpen ? (
                    <BuildLogPanel environmentId={environmentId} imageBuildId={entry.id} />
                  ) : null}
                </div>
              </SettingsRow>
            );
          })}
        </SettingsSection>
      ) : null}
    </>
  );
}

function ProposalRow({
  environmentId,
  proposal,
  savedInstall,
  open,
  busy,
  memberName,
  formatTime,
  onToggle,
  onAccept,
  onDismiss,
}: {
  readonly environmentId: EnvironmentId;
  readonly proposal: TeamImageProposal;
  readonly savedInstall: string;
  readonly open: boolean;
  readonly busy: boolean;
  readonly memberName: (memberId: MemberId) => string | undefined;
  readonly formatTime: (time: DateTime.Utc) => string;
  readonly onToggle: () => void;
  readonly onAccept: () => void;
  readonly onDismiss: () => void;
}) {
  const threadRef = scopeThreadRef(environmentId, proposal.threadId);
  const thread = useThreadShell(threadRef);
  const navigate = useNavigate();
  const ownerId = thread?.source.ownerId ?? null;
  const ownerName = ownerId === null ? undefined : memberName(ownerId);
  const whose = ownerName === undefined ? "A thread" : `${ownerName}'s thread`;
  const diff = installDiff(savedInstall, proposal.install);
  const changed = diff.some((line) => line.kind !== "same");
  return (
    <SettingsRow
      title={proposal.reason}
      description={`${whose} · ${formatTime(proposal.createdAt)}`}
      control={
        <Button size="xs" variant="outline" aria-expanded={open} disabled={busy} onClick={onToggle}>
          {open ? "Hide" : "Review"}
        </Button>
      }
    >
      {open ? (
        <div className="grid gap-2 pb-3">
          {changed ? (
            <pre
              aria-label="Proposed changes to the install script"
              className="max-h-64 overflow-auto rounded-md border bg-muted/40 py-2 font-mono text-xs leading-relaxed"
            >
              {diff.map((line, index) => (
                <div
                  // oxlint-disable-next-line react/no-array-index-key -- a diff has repeated lines and no ids
                  key={index}
                  className={cn(
                    "px-2 whitespace-pre-wrap",
                    line.kind === "added" && "bg-success/10 text-success-foreground",
                    line.kind === "removed" && "bg-destructive/10 text-destructive-foreground",
                    line.kind === "same" && "text-muted-foreground",
                  )}
                >
                  {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
                  {line.text}
                </div>
              ))}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">
              Its script is the same as the saved one.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <Button
              size="xs"
              variant="link"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(threadRef),
                })
              }
            >
              {thread === null ? "Open the thread" : `Open ${thread.title}`}
            </Button>
            <div className="flex items-center gap-1.5">
              <Button size="xs" variant="ghost" disabled={busy} onClick={onDismiss}>
                Dismiss
              </Button>
              <Button size="xs" disabled={busy || !changed} onClick={onAccept}>
                Accept
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </SettingsRow>
  );
}

function activeSummary(
  build: TeamImageBuild,
  formatTime: (time: DateTime.Utc) => string,
  memberName: (memberId: MemberId) => string | undefined,
  projectName: (projectId: ProjectId) => string,
): string {
  const { requester } = teamImageBuildPresentation(build, build.id, { memberName });
  const manifest = build.manifest;
  const parts = [
    build.finishedAt === null ? null : formatTime(build.finishedAt),
    requester,
    manifest === undefined ? null : `Pair base ${manifest.base.pairVersion}`,
    manifest?.sizeBytes == null ? null : formatBytes(manifest.sizeBytes),
    ...(manifest?.providers.flatMap((provider) =>
      provider.version === null
        ? []
        : [`${getProviderClient(provider.driver)?.label ?? provider.driver} ${provider.version}`],
    ) ?? []),
    manifest === undefined || manifest.repos.length === 0
      ? null
      : `${manifest.repos.length} project${manifest.repos.length === 1 ? "" : "s"} pre-cloned (${manifest.repos
          .map((repo) => projectName(repo.projectId))
          .join(", ")})`,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

function FailureDetail({
  message,
  tail,
}: {
  readonly message: string;
  readonly tail: ReadonlyArray<string>;
}) {
  return (
    <div className="grid gap-1.5">
      <p className="text-xs text-destructive">{message}</p>
      {tail.length > 0 ? (
        <pre
          aria-label="Last lines of the build log"
          className="max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground"
        >
          {tail.join("\n")}
        </pre>
      ) : null}
    </div>
  );
}

/** Mounted only while open, so closing it ends the log subscription. */
function BuildLogPanel({
  environmentId,
  imageBuildId,
}: {
  readonly environmentId: EnvironmentId;
  readonly imageBuildId: TeamImageBuildId;
}) {
  const log = useAtomValue(
    teamImageEnvironment.buildLog({ environmentId, input: { imageBuildId } }),
  );
  const view = AsyncResult.getOrElse(log, () => null);
  const failure = log._tag === "Failure" ? formatEnvironmentQueryError(log.cause) : null;
  return (
    <div className="grid gap-1">
      {/* A reversed column keeps a growing log scrolled to its last line without an effect. */}
      <div
        role="log"
        aria-label="Build log"
        className="flex max-h-80 flex-col-reverse overflow-auto rounded-md border bg-muted/40"
      >
        <pre className="p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground">
          {view === null
            ? failure === null
              ? "Loading the log…"
              : failure
            : view.text === ""
              ? "The log is empty."
              : view.text}
        </pre>
      </div>
      {view?.truncated === true ? (
        <p className="text-xs text-muted-foreground">Older lines are left out of this view.</p>
      ) : null}
      {view !== null && !view.done ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner size="xs" aria-hidden />
          Streaming
        </p>
      ) : null}
    </div>
  );
}

function EditWithAgent({
  label,
  variant = "outline",
  projects,
  onPick,
}: {
  readonly label: string;
  readonly variant?: "outline" | "ghost";
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly onPick: (projectId: ProjectId) => void;
}) {
  const only = projects.length === 1 ? projects[0] : undefined;
  if (only !== undefined) {
    return (
      <Button
        size={variant === "outline" ? "sm" : "xs"}
        variant={variant}
        onClick={() => onPick(only.id)}
      >
        {label}
      </Button>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size={variant === "outline" ? "sm" : "xs"}
            variant={variant}
            disabled={projects.length === 0}
            title={projects.length === 0 ? "Add a project to Pair Cloud first." : undefined}
          />
        }
      >
        {label}
      </MenuTrigger>
      <MenuPopup align="end">
        {projects.map((project) => (
          <MenuItem key={project.id} onClick={() => onPick(project.id)}>
            {project.title}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function RecipeEditor({
  draft,
  revision,
  dirty,
  accepting,
  parseError,
  changes,
  stale,
  busy,
  buildBlocker,
  canSave,
  projects,
  projectName,
  secretSources,
  onChange,
  onReload,
  onSave,
  onSaveAndBuild,
}: {
  readonly draft: TeamImageDraft;
  readonly revision: number | null;
  readonly dirty: boolean;
  /** The reason of the proposal this edit's save closes. */
  readonly accepting: string | null;
  readonly parseError: string | null;
  readonly changes: ReadonlyArray<string> | null;
  readonly stale: boolean;
  readonly busy: boolean;
  readonly buildBlocker: string | null;
  readonly canSave: boolean;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly projectName: (projectId: ProjectId) => string;
  readonly secretSources: ReturnType<typeof useSecretSources>;
  readonly onChange: (patch: Partial<TeamImageDraft>) => void;
  readonly onReload: () => void;
  readonly onSave: () => void;
  readonly onSaveAndBuild: () => void;
}) {
  const npmWarning = npmTokenWarning(draft.install);
  const known = new Set<ProjectId>(projects.map((project) => project.id));
  const removed = draft.projectIds.filter((projectId) => !known.has(projectId));
  const toggleProject = (projectId: ProjectId, checked: boolean) =>
    onChange({
      projectIds: checked
        ? [...draft.projectIds, projectId]
        : draft.projectIds.filter((candidate) => candidate !== projectId),
    });
  return (
    <>
      <SettingsRow
        title="Recipe"
        description={
          revision === null
            ? "Not saved yet. Pre-clone projects and run an install script on top of Pair's base image."
            : `Revision ${revision}${dirty ? ", unsaved changes" : ""}`
        }
        control={
          dirty ? (
            <Button size="xs" variant="ghost" onClick={onReload}>
              Discard changes
            </Button>
          ) : undefined
        }
      >
        <div className="grid gap-4 pb-3">
          {accepting === null ? null : (
            <Alert variant="info">
              <InfoIcon aria-hidden />
              <AlertDescription>
                This script is a proposal: {accepting}. Saving closes it.
              </AlertDescription>
            </Alert>
          )}
          {stale ? (
            <Alert variant="warning">
              <TriangleAlertIcon aria-hidden />
              <AlertDescription>{RECIPE_CHANGED_MESSAGE}</AlertDescription>
              <AlertAction>
                <Button size="xs" variant="outline" onClick={onReload}>
                  Reload
                </Button>
              </AlertAction>
            </Alert>
          ) : null}
          <fieldset className="grid gap-1.5">
            <legend className="text-xs font-medium text-foreground">Pre-cloned projects</legend>
            {projects.length === 0 && removed.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Add a project to Pair Cloud to pre-clone it.
              </p>
            ) : (
              <div className="grid gap-1.5 sm:grid-cols-2">
                {projects.map((project) => (
                  <label key={project.id} className="flex min-w-0 items-center gap-2 text-sm">
                    <Checkbox
                      checked={draft.projectIds.includes(project.id)}
                      onCheckedChange={(checked) => toggleProject(project.id, checked === true)}
                    />
                    <span className="truncate">{project.title}</span>
                  </label>
                ))}
                {removed.map((projectId) => (
                  <label
                    key={projectId}
                    className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground"
                  >
                    <Checkbox checked onCheckedChange={() => toggleProject(projectId, false)} />
                    <span className="truncate">{projectName(projectId)}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <div className="grid gap-1.5">
            <label htmlFor="team-image-install" className="text-xs font-medium text-foreground">
              Install script
            </label>
            <Textarea
              id="team-image-install"
              font="mono"
              spellCheck={false}
              placeholder={
                "# Bash, run as t3 from $HOME after the projects are cloned.\nsudo apt-get install -y postgresql-client"
              }
              value={draft.install}
              onChange={(event) => onChange({ install: event.target.value })}
            />
            {npmWarning !== null ? (
              <Alert variant="warning">
                <TriangleAlertIcon aria-hidden />
                <AlertDescription>
                  {warningParts(npmWarning).map((part) =>
                    part.code ? <code key={part.text}>{part.text}</code> : part.text,
                  )}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        </div>
      </SettingsRow>
      <ProviderEnvironmentSection
        title="Build variables"
        description="Set while the install script runs, never in sessions. A secret's value is kept on the server, or read from a secret provider; the recipe only names it, and the value can't be read back."
        environment={draft.environment}
        invalidName={reservedBuildName}
        secretSources={secretSources}
        onChange={(environment) => onChange({ environment })}
      />
      <SettingsRow title="Save" description={saveDescription(parseError, changes, buildBlocker)}>
        <div className="flex flex-wrap items-center justify-end gap-1.5 pb-3">
          <Button size="sm" variant="outline" disabled={busy || !canSave} onClick={onSave}>
            Save
          </Button>
          <Button
            size="sm"
            disabled={busy || !canSave || buildBlocker !== null}
            title={buildBlocker ?? undefined}
            onClick={onSaveAndBuild}
          >
            Save and build
          </Button>
        </div>
      </SettingsRow>
    </>
  );
}

function saveDescription(
  parseError: string | null,
  changes: ReadonlyArray<string> | null,
  buildBlocker: string | null,
) {
  if (parseError !== null) {
    return (
      <span className="flex items-start gap-1.5 text-destructive">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        {parseError}
      </span>
    );
  }
  if (changes === null || changes.length === 0) {
    return buildBlocker === null ? "No unsaved changes." : `No unsaved changes. ${buildBlocker}`;
  }
  return (
    <span className="grid gap-0.5">
      {changes.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </span>
  );
}
