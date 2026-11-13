import { activeTeamMembers } from "@t3tools/client-runtime/state/team";
import { isWorkspaceProject } from "@t3tools/client-runtime/state/workspaces";
import {
  SPACE_PAIR_OFF_HINT,
  SPACE_TASK_STATUSES,
  type SpaceConfirm,
  type SpaceViewer,
  isSpaceOwner,
  orderSpaceMembers,
  spaceControls,
  spaceDefaultReassignTo,
  spaceWorkspaceLine,
} from "@t3tools/client-runtime/spaces";
import {
  teamClaudeKeyIsSet,
  teamClaudeKeyStatusText,
} from "@t3tools/client-runtime/team-claude-key";
import {
  type EnvironmentId,
  type MemberId,
  type ModelSelection,
  type ProjectId,
  SPACE_MAX_REPOSITORIES,
  type Space,
  type SpaceId,
  type SpaceTaskStatus,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { type SpaceDialogRequest, useSpaceDialogStore } from "../../spaceDialogStore";
import { useEnvironmentQuery } from "../../state/query";
import { useCanManageTeamClaudeKey, useTeamClaudeKeyStatus } from "../../state/spaceAgent";
import {
  spaceEnvironment,
  spaceRepositoryNames,
  useCanOperateSpaces,
  useSpaceEnvironmentIds,
  useSpaceListResult,
  useSpaceProjects,
  useSpaceTaskThreads,
  useSpaceViewer,
} from "../../state/spaces";
import { useTeamMembers } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { MemberAvatar } from "../team/MemberAvatar";
import { TeamClaudeKeyDialog } from "../team/TeamClaudeKeyCard";
import { toastCommandFailure } from "../team/toastCommandFailure";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SpaceAttachThreadDialog } from "./SpaceAttachThreadDialog";
import { SpaceConfirmDialog } from "./SpaceConfirmDialog";
import { SpaceModelPicker, useSpaceModelSelection } from "./SpaceModelPicker";
import { SpaceStartThreadDialog } from "./SpaceStartThreadDialog";
import { SpaceTaskStatusGlyph } from "./SpaceStatusIcon";
import { type SpaceThreadDialogRequest, useSpaceThreadDialogStore } from "./spaceThreadDialogStore";

/** Mounted once in the app shell; the room, sidebar, palette and shortcuts open dialogs here. */
export function SpaceDialogHost() {
  const dialog = useSpaceDialogStore((state) => state.dialog);
  const close = useSpaceDialogStore((state) => state.close);
  const threadDialog = useSpaceThreadDialogStore((state) => state.dialog);
  const closeThreadDialog = useSpaceThreadDialogStore((state) => state.close);
  const environmentIds = useSpaceEnvironmentIds();
  const environmentId =
    dialog === null
      ? null
      : dialog.type === "new-space"
        ? (dialog.environmentId ?? environmentIds[0] ?? null)
        : dialog.environmentId;
  return (
    <>
      {dialog === null || environmentId === null ? null : (
        <SpaceDialogFor dialog={dialog} environmentId={environmentId} onClose={close} />
      )}
      {threadDialog === null ? null : threadDialog.type === "attach" ? (
        <SpaceAttachThreadDialog request={threadDialog} onClose={closeThreadDialog} />
      ) : (
        <StartThreadFor request={threadDialog} onClose={closeThreadDialog} />
      )}
    </>
  );
}

function StartThreadFor(props: {
  readonly request: Extract<SpaceThreadDialogRequest, { type: "start" }>;
  readonly onClose: () => void;
}) {
  const { environmentId, spaceId, taskId } = props.request;
  const list = useSpaceListResult(environmentId);
  const threads = useSpaceTaskThreads(environmentId, spaceId, []);
  const space = list.spaces.find((candidate) => candidate.id === spaceId);
  const task = list.tasks.find((candidate) => candidate.id === taskId);
  if (space === undefined || task === undefined) return null;
  return (
    <SpaceStartThreadDialog
      environmentId={environmentId}
      space={space}
      task={task}
      threads={threads.filter(
        (thread) => thread.space?.kind === "task" && thread.space.taskId === taskId,
      )}
      onClose={props.onClose}
    />
  );
}

function SpaceDialogFor(props: {
  readonly dialog: SpaceDialogRequest;
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const viewer = useSpaceViewer(props.environmentId);
  const list = useSpaceListResult(props.environmentId);
  const { dialog } = props;
  if (dialog.type === "new-space") {
    return (
      <NewSpaceDialog environmentId={props.environmentId} viewer={viewer} onClose={props.onClose} />
    );
  }
  const space = list.spaces.find((candidate) => candidate.id === dialog.spaceId);
  if (space === undefined) return null;
  return dialog.type === "new-task" ? (
    <NewTaskDialog
      environmentId={props.environmentId}
      space={space}
      viewer={viewer}
      initialOwnerId={dialog.ownerId ?? viewer.memberId}
      onClose={props.onClose}
    />
  ) : (
    <SpaceSettingsDialog
      environmentId={props.environmentId}
      space={space}
      viewer={viewer}
      tasks={list.tasks.filter((task) => task.spaceId === space.id)}
      onClose={props.onClose}
    />
  );
}

function Field(props: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{props.label}</Label>
      {props.children}
      {props.hint === undefined ? null : (
        <p className="text-muted-foreground text-xs">{props.hint}</p>
      )}
    </div>
  );
}

/** 1–8 repositories, in the order picked; workspaces aren't offered, the server resolves one. */
function RepositoryPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly value: ReadonlyArray<ProjectId>;
  readonly disabled?: boolean;
  readonly onChange: (value: ReadonlyArray<ProjectId>) => void;
}) {
  const repositories = useSpaceProjects(props.environmentId).filter(
    (project) => !isWorkspaceProject(project),
  );
  const full = props.value.length >= SPACE_MAX_REPOSITORIES;
  if (repositories.length === 0) {
    return <p className="text-muted-foreground text-sm">Add a project first.</p>;
  }
  return (
    <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
      {repositories.map((project) => {
        const checked = props.value.includes(project.id);
        return (
          <label
            key={project.id}
            className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-accent"
          >
            <Checkbox
              checked={checked}
              disabled={(props.disabled ?? false) || (!checked && full)}
              onCheckedChange={(next) =>
                props.onChange(
                  next
                    ? [...props.value, project.id]
                    : props.value.filter((id) => id !== project.id),
                )
              }
            />
            <span className="truncate text-sm">{project.title}</span>
          </label>
        );
      })}
    </div>
  );
}

/** "Threads run in pair-be." / "Creates the workspace …", with the new workspace's name editable. */
function WorkspaceLine(props: {
  readonly environmentId: EnvironmentId;
  readonly repositoryIds: ReadonlyArray<ProjectId>;
  readonly spaceName: string;
  readonly spaceId?: SpaceId;
  readonly workspaceName: string;
  readonly onWorkspaceName: (name: string) => void;
}) {
  const projects = useSpaceProjects(props.environmentId);
  const spaceName = props.spaceName.trim();
  const workspaceName = props.workspaceName.trim();
  const preview = useEnvironmentQuery(
    props.repositoryIds.length === 0 || spaceName === ""
      ? null
      : spaceEnvironment.workspacePreview({
          environmentId: props.environmentId,
          input: {
            repositoryIds: props.repositoryIds,
            spaceName,
            ...(workspaceName === "" ? {} : { workspaceName }),
            ...(props.spaceId === undefined ? {} : { spaceId: props.spaceId }),
          },
        }),
  ).data;
  if (preview == null) return null;
  const names = spaceRepositoryNames({ repositoryIds: props.repositoryIds }, projects);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-muted-foreground text-xs">{spaceWorkspaceLine(preview, names)}</p>
      {preview.type === "create" ? (
        <Input
          size="sm"
          aria-label="Workspace name"
          value={props.workspaceName}
          placeholder={spaceName}
          onChange={(event) => props.onWorkspaceName(event.target.value)}
        />
      ) : null}
    </div>
  );
}

/** Who pays for @pair: the Team Claude key, with Add key in place for an admin. */
function PairField(props: { readonly environmentId: EnvironmentId }) {
  const status = useTeamClaudeKeyStatus(props.environmentId);
  const canManage = useCanManageTeamClaudeKey(props.environmentId);
  const viewer = useSpaceViewer(props.environmentId);
  const [adding, setAdding] = useState(false);
  const now = Date.parse(`${useNowMinute()}Z`);
  if (status === null) return null;
  const set = teamClaudeKeyIsSet(status);
  return (
    <Field label="@pair">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-muted-foreground text-xs">
          {set
            ? `Replies use the Team Claude key. ${teamClaudeKeyStatusText(status, viewer.nameOf, now)}`
            : SPACE_PAIR_OFF_HINT}
        </span>
        {!set && canManage ? (
          <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
            Add key
          </Button>
        ) : null}
      </div>
      {adding ? (
        <TeamClaudeKeyDialog
          environmentId={props.environmentId}
          replacing={false}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </Field>
  );
}

function MemberPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly exclude: ReadonlySet<string>;
  readonly emptyText?: string;
  readonly value: ReadonlySet<MemberId>;
  readonly onChange: (value: ReadonlySet<MemberId>) => void;
}) {
  const roster = activeTeamMembers(useTeamMembers(props.environmentId)).filter(
    (member) => !props.exclude.has(member.id),
  );
  if (roster.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {props.emptyText ?? "Everyone on the team is already here."}
      </p>
    );
  }
  return (
    <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
      {roster.map((member) => (
        <label
          key={member.id}
          className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-accent"
        >
          <Checkbox
            checked={props.value.has(member.id)}
            onCheckedChange={(checked) => {
              const next = new Set(props.value);
              if (checked) next.add(member.id);
              else next.delete(member.id);
              props.onChange(next);
            }}
          />
          <MemberAvatar size="sm" member={member} />
          <span className="truncate text-sm">{member.name}</span>
        </label>
      ))}
    </div>
  );
}

function NewSpaceDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly viewer: SpaceViewer;
  readonly onClose: () => void;
}) {
  const mutate = useAtomCommand(spaceEnvironment.mutate, "Create space");
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [repositoryIds, setRepositoryIds] = useState<ReadonlyArray<ProjectId>>([]);
  const [workspaceName, setWorkspaceName] = useState("");
  const [brief, setBrief] = useState("");
  const [memberIds, setMemberIds] = useState<ReadonlySet<MemberId>>(new Set());
  const [busy, setBusy] = useState(false);
  const model = useSpaceModelSelection(
    props.environmentId,
    repositoryIds[0] ?? null,
    null,
  ).selection;
  const ready = name.trim().length > 0 && repositoryIds.length > 0 && model !== null && !busy;

  const create = async () => {
    if (!ready || model === null) return;
    setBusy(true);
    const result = await mutate({
      environmentId: props.environmentId,
      input: {
        type: "create",
        name: name.trim(),
        brief: brief.trim(),
        repositoryIds,
        ...(workspaceName.trim() === "" ? {} : { workspaceName: workspaceName.trim() }),
        memberIds: [...memberIds],
        modelSelection: model,
      },
    });
    setBusy(false);
    toastCommandFailure("Could not create the space", result);
    if (result._tag !== "Success" || result.value.space === null) return;
    props.onClose();
    void navigate({
      to: "/spaces/$environmentId/$spaceId",
      params: { environmentId: props.environmentId, spaceId: result.value.space.id },
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New space</DialogTitle>
          <DialogDescription>A room for your team and Pair, with its own tasks.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <Field label="Name">
              <Input
                autoFocus
                value={name}
                placeholder="Question creation"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Repositories">
              <RepositoryPicker
                environmentId={props.environmentId}
                value={repositoryIds}
                onChange={setRepositoryIds}
              />
              <WorkspaceLine
                environmentId={props.environmentId}
                repositoryIds={repositoryIds}
                spaceName={name}
                workspaceName={workspaceName}
                onWorkspaceName={setWorkspaceName}
              />
            </Field>
            <Field label="Members">
              <MemberPicker
                environmentId={props.environmentId}
                exclude={new Set(props.viewer.memberId === null ? [] : [props.viewer.memberId])}
                value={memberIds}
                onChange={setMemberIds}
              />
            </Field>
            <Field label="Brief">
              <Textarea
                value={brief}
                placeholder="What this space is for. Pair reads it before every reply."
                onChange={(event) => setBrief(event.target.value)}
              />
            </Field>
            <PairField environmentId={props.environmentId} />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="outline" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!ready} onClick={() => void create()}>
            Create space
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function NewTaskDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly viewer: SpaceViewer;
  readonly initialOwnerId: MemberId | null;
  readonly onClose: () => void;
}) {
  const task = useAtomCommand(spaceEnvironment.task, "Create task");
  const navigate = useNavigate();
  const members = orderSpaceMembers(props.space);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<SpaceTaskStatus>("todo");
  const [ownerId, setOwnerId] = useState<MemberId | null>(props.initialOwnerId);
  const [startNow, setStartNow] = useState(false);
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [baseRef, setBaseRef] = useState("");
  const [busy, setBusy] = useState(false);
  const mine = ownerId !== null && ownerId === props.viewer.memberId;
  const starting = mine && startNow;
  const model = useSpaceModelSelection(
    props.environmentId,
    props.space.projectId,
    picked,
  ).selection;
  const statusInfo = SPACE_TASK_STATUSES.find((info) => info.status === status);
  const ready =
    title.trim().length > 0 &&
    description.trim().length > 0 &&
    ownerId !== null &&
    (!starting || model !== null) &&
    !busy;

  const create = async () => {
    if (!ready || ownerId === null) return;
    setBusy(true);
    const result = await task({
      environmentId: props.environmentId,
      input: {
        type: "create",
        spaceId: props.space.id,
        title: title.trim(),
        description: description.trim(),
        ownerId,
        status,
        ...(starting && model !== null
          ? {
              start: {
                projectId: props.space.projectId,
                modelSelection: model,
                base: baseRef.trim() === "" ? {} : { baseRef: baseRef.trim() },
              },
            }
          : {}),
      },
    });
    setBusy(false);
    toastCommandFailure("Could not create the task", result);
    if (result._tag !== "Success") return;
    props.onClose();
    const { threadId, task: created } = result.value;
    if (threadId !== undefined) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: props.environmentId, threadId },
      });
    } else if (created !== null) {
      void navigate({
        to: "/spaces/$environmentId/$spaceId/tasks/$taskId",
        params: {
          environmentId: props.environmentId,
          spaceId: props.space.id,
          taskId: created.id,
        },
      });
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New task in {props.space.name}</DialogTitle>
          <DialogDescription>Space members can see it and its threads.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <Field label="Title">
              <Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
            </Field>
            <Field label="What to do">
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Status">
                <Select
                  value={status}
                  onValueChange={(value) => setStatus(value as SpaceTaskStatus)}
                >
                  <SelectTrigger size="sm" aria-label="Status">
                    <SelectValue>
                      {statusInfo === undefined ? null : (
                        <span className="flex items-center gap-2">
                          <SpaceTaskStatusGlyph icon={statusInfo.icon} tone={statusInfo.tone} />
                          {statusInfo.label}
                        </span>
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {SPACE_TASK_STATUSES.map((info) => (
                      <SelectItem key={info.status} value={info.status}>
                        <span className="flex items-center gap-2">
                          <SpaceTaskStatusGlyph icon={info.icon} tone={info.tone} />
                          {info.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <Field label="Owner">
                <Select
                  value={ownerId ?? ""}
                  onValueChange={(value) => setOwnerId(value as MemberId)}
                >
                  <SelectTrigger size="sm" aria-label="Owner">
                    <SelectValue>
                      {ownerId === null
                        ? "Choose an owner"
                        : ownerId === props.viewer.memberId
                          ? "You"
                          : props.viewer.nameOf(ownerId)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {members.map((member) => (
                      <SelectItem key={member.memberId} value={member.memberId}>
                        {member.memberId === props.viewer.memberId
                          ? "You"
                          : props.viewer.nameOf(member.memberId)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            </div>
            {mine ? (
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={startNow}
                  onCheckedChange={(next) => setStartNow(next === true)}
                />
                Start a thread now, on your account
              </label>
            ) : null}
            {starting ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Model">
                  <SpaceModelPicker
                    environmentId={props.environmentId}
                    projectId={props.space.projectId}
                    value={picked}
                    onChange={setPicked}
                  />
                </Field>
                <Field label="Base">
                  <Input
                    value={baseRef}
                    placeholder="Default branch"
                    onChange={(event) => setBaseRef(event.target.value)}
                  />
                </Field>
              </div>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="outline" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!ready} onClick={() => void create()}>
            {starting ? "Create and start" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function sameIds(a: ReadonlyArray<ProjectId>, b: ReadonlyArray<ProjectId>): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function SpaceSettingsDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly viewer: SpaceViewer;
  readonly tasks: Parameters<typeof SpaceConfirmDialog>[0]["tasks"];
  readonly onClose: () => void;
}) {
  const { space, viewer } = props;
  const canOperate = useCanOperateSpaces(props.environmentId);
  const controls = spaceControls(space, viewer.memberId, canOperate);
  const roster = useTeamMembers(props.environmentId);
  const mutate = useAtomCommand(spaceEnvironment.mutate, "Update space");
  const [name, setName] = useState(space.name);
  const [repositoryIds, setRepositoryIds] = useState<ReadonlyArray<ProjectId>>(space.repositoryIds);
  const [workspaceName, setWorkspaceName] = useState("");
  const [adding, setAdding] = useState<ReadonlySet<MemberId>>(new Set());
  const [confirm, setConfirm] = useState<SpaceConfirm | null>(null);
  const [busy, setBusy] = useState(false);
  const members = orderSpaceMembers(space);
  const reposChanged = !sameIds(repositoryIds, space.repositoryIds);

  const apply = async (input: Parameters<typeof mutate>[0]["input"], failure: string) => {
    setBusy(true);
    const result = await mutate({ environmentId: props.environmentId, input });
    setBusy(false);
    toastCommandFailure(failure, result);
    return result._tag === "Success";
  };
  const addMembers = async (memberIds: ReadonlyArray<MemberId>) => {
    if (
      await apply(
        { type: "member.add", spaceId: space.id, memberIds: [...memberIds] },
        "Could not add",
      )
    ) {
      setAdding(new Set());
    }
  };
  const saveRepositories = () =>
    apply(
      {
        type: "update",
        spaceId: space.id,
        repositoryIds,
        ...(workspaceName.trim() === "" ? {} : { workspaceName: workspaceName.trim() }),
      },
      "Could not change the repositories",
    );

  if (confirm !== null) {
    return (
      <SpaceConfirmDialog
        environmentId={props.environmentId}
        viewer={viewer}
        confirm={confirm}
        tasks={props.tasks}
        onClose={() => {
          setConfirm(null);
          if (confirm.type === "leave") props.onClose();
        }}
      />
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Space settings</DialogTitle>
          <DialogDescription>
            {controls.canManage
              ? "Only you, the owner, can change these."
              : `${viewer.nameOf(space.ownerId)} owns this space.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <Field label="Name">
              <Input
                value={name}
                disabled={!controls.canManage}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => {
                  if (name.trim() !== "" && name.trim() !== space.name)
                    void apply(
                      { type: "update", spaceId: space.id, name: name.trim() },
                      "Could not rename the space",
                    );
                }}
              />
            </Field>
            <Field
              label="Repositories"
              hint="New threads use the new set. Existing threads keep theirs."
            >
              <RepositoryPicker
                environmentId={props.environmentId}
                value={repositoryIds}
                disabled={!controls.canManage}
                onChange={setRepositoryIds}
              />
              {reposChanged ? (
                <>
                  <WorkspaceLine
                    environmentId={props.environmentId}
                    repositoryIds={repositoryIds}
                    spaceName={space.name}
                    spaceId={space.id}
                    workspaceName={workspaceName}
                    onWorkspaceName={setWorkspaceName}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="xs"
                      disabled={busy || repositoryIds.length === 0}
                      onClick={() => void saveRepositories()}
                    >
                      Save repositories
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setRepositoryIds(space.repositoryIds)}
                    >
                      Reset
                    </Button>
                  </div>
                </>
              ) : null}
            </Field>
            <PairField environmentId={props.environmentId} />
            <Field label={`Members (${members.length})`}>
              <div className="flex flex-col gap-1">
                {members.map((member) => {
                  const isOwner = isSpaceOwner(space, member.memberId);
                  const self = member.memberId === viewer.memberId;
                  const memberName = viewer.nameOf(member.memberId);
                  return (
                    <div key={member.memberId} className="flex items-center gap-2 py-0.5">
                      <MemberAvatar
                        size="sm"
                        member={{
                          name: memberName,
                          color: roster.get(member.memberId)?.color ?? "var(--muted-foreground)",
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {memberName}
                        {self ? <span className="text-muted-foreground"> (you)</span> : null}
                      </span>
                      {isOwner ? (
                        <span className="text-muted-foreground text-xs">Owner</span>
                      ) : null}
                      {controls.canManage && !isOwner ? (
                        <>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              setConfirm({ type: "transfer", space, memberId: member.memberId })
                            }
                          >
                            Make owner
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost-destructive"
                            onClick={() =>
                              setConfirm({
                                type: "remove",
                                space,
                                memberId: member.memberId,
                                reassignTo: spaceDefaultReassignTo("remove", space, viewer),
                              })
                            }
                          >
                            Remove
                          </Button>
                        </>
                      ) : null}
                    </div>
                  );
                })}
                <p className="text-muted-foreground text-xs">Only members can see this space.</p>
              </div>
            </Field>
            {controls.canManage && space.joinRequests.length > 0 ? (
              <Field label="Asked to join">
                <div className="flex flex-col gap-1">
                  {space.joinRequests.map((request) => (
                    <div key={request.memberId} className="flex items-center gap-2">
                      <span className="flex-1 truncate text-sm">
                        {viewer.nameOf(request.memberId)}
                      </span>
                      <Button
                        size="xs"
                        disabled={busy}
                        onClick={() => void addMembers([request.memberId])}
                      >
                        Add
                      </Button>
                    </div>
                  ))}
                </div>
              </Field>
            ) : null}
            {controls.canManage ? (
              <Field label="Add members">
                <MemberPicker
                  environmentId={props.environmentId}
                  exclude={
                    new Set([
                      ...members.map((member) => member.memberId),
                      ...space.joinRequests.map((request) => request.memberId),
                    ])
                  }
                  {...(space.joinRequests.length > 0
                    ? { emptyText: "Everyone else on the team has asked to join. Add them above." }
                    : {})}
                  value={adding}
                  onChange={setAdding}
                />
                {adding.size > 0 ? (
                  <Button size="sm" disabled={busy} onClick={() => void addMembers([...adding])}>
                    Add {adding.size}
                  </Button>
                ) : null}
              </Field>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {controls.canLeave ? (
            <Button
              size="sm"
              variant="ghost-destructive"
              onClick={() =>
                setConfirm({
                  type: "leave",
                  space,
                  reassignTo: spaceDefaultReassignTo("leave", space, viewer),
                })
              }
            >
              Leave space
            </Button>
          ) : null}
          {controls.canArchive ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirm({ type: "archive", space })}
            >
              Archive space
            </Button>
          ) : null}
          <Button size="sm" onClick={props.onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
