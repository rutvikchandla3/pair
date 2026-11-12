import { activeTeamMembers } from "@t3tools/client-runtime/state/team";
import {
  type SpaceConfirm,
  type SpaceViewer,
  isSpaceOwner,
  orderSpaceMembers,
  spaceControls,
  spacePairBillingLabel,
} from "@t3tools/client-runtime/spaces";
import type {
  EnvironmentId,
  MemberId,
  ModelSelection,
  ProjectId,
  Space,
  SpacePairBilling,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { type SpaceDialogRequest, useSpaceDialogStore } from "../../spaceDialogStore";
import { useProjects } from "../../state/entities";
import {
  spaceEnvironment,
  useCanOperateSpaces,
  useSpaceEnvironmentIds,
  useSpaceList,
  useSpaceViewer,
} from "../../state/spaces";
import { useTeamMembers } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { MemberAvatar } from "../team/MemberAvatar";
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
import { SpaceConfirmDialog } from "./SpaceConfirmDialog";
import { SpaceModelPicker, useSpaceModelSelection } from "./SpaceModelPicker";

/** Mounted once in the app shell; the room, sidebar, palette and shortcuts open dialogs here. */
export function SpaceDialogHost() {
  const dialog = useSpaceDialogStore((state) => state.dialog);
  const close = useSpaceDialogStore((state) => state.close);
  const environmentIds = useSpaceEnvironmentIds();
  if (dialog === null) return null;
  const environmentId =
    dialog.type === "new-space"
      ? (dialog.environmentId ?? environmentIds[0] ?? null)
      : dialog.environmentId;
  if (environmentId === null) return null;
  return <SpaceDialogFor dialog={dialog} environmentId={environmentId} onClose={close} />;
}

function SpaceDialogFor(props: {
  readonly dialog: SpaceDialogRequest;
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const viewer = useSpaceViewer(props.environmentId);
  const spaces = useSpaceList(props.environmentId);
  const { dialog } = props;
  if (dialog.type === "new-space") {
    return (
      <NewSpaceDialog environmentId={props.environmentId} viewer={viewer} onClose={props.onClose} />
    );
  }
  const space = spaces.find((candidate) => candidate.id === dialog.spaceId);
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
      onClose={props.onClose}
    />
  );
}

function Field(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{props.label}</Label>
      {props.children}
    </div>
  );
}

function ProjectSelect(props: {
  readonly environmentId: EnvironmentId;
  readonly value: ProjectId | null;
  readonly disabled?: boolean;
  readonly onChange: (projectId: ProjectId) => void;
}) {
  const projects = useProjects().filter(
    (project) => project.environmentId === props.environmentId && project.isScratch !== true,
  );
  const selected = projects.find((project) => project.id === props.value);
  return (
    <Select
      value={props.value ?? ""}
      disabled={props.disabled ?? false}
      onValueChange={(value) => props.onChange(value as ProjectId)}
    >
      <SelectTrigger size="sm" aria-label="Project">
        <SelectValue>{selected?.title ?? "Choose a project"}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.title}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function BillingSelect(props: {
  readonly value: SpacePairBilling;
  readonly viewer: SpaceViewer;
  readonly disabled?: boolean;
  readonly onChange: (billing: SpacePairBilling) => void;
}) {
  const me = props.viewer.memberId;
  const key = props.value.type === "team" ? "team" : props.value.memberId;
  return (
    <Select
      value={key}
      disabled={props.disabled ?? false}
      onValueChange={(value) =>
        props.onChange(
          value === "team" ? { type: "team" } : { type: "member", memberId: value as MemberId },
        )
      }
    >
      <SelectTrigger size="sm" aria-label="Who pays for Pair">
        <SelectValue>{spacePairBillingLabel(props.value, props.viewer)}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="team">Team Claude key</SelectItem>
        {me === null ? null : <SelectItem value={me}>Your Claude account</SelectItem>}
        {props.value.type === "member" && props.value.memberId !== me ? (
          <SelectItem value={props.value.memberId}>
            {spacePairBillingLabel(props.value, props.viewer)}
          </SelectItem>
        ) : null}
      </SelectPopup>
    </Select>
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
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [brief, setBrief] = useState("");
  const [memberIds, setMemberIds] = useState<ReadonlySet<MemberId>>(new Set());
  const [billing, setBilling] = useState<SpacePairBilling>({ type: "team" });
  const [busy, setBusy] = useState(false);
  const model = useSpaceModelSelection(props.environmentId, projectId, null).selection;
  const ready = name.trim().length > 0 && projectId !== null && model !== null && !busy;

  const create = async () => {
    if (!ready || projectId === null || model === null) return;
    setBusy(true);
    const result = await mutate({
      environmentId: props.environmentId,
      input: {
        type: "create",
        name: name.trim(),
        brief: brief.trim(),
        projectId,
        memberIds: [...memberIds],
        pairBilling: billing,
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
            <Field label="Project">
              <ProjectSelect
                environmentId={props.environmentId}
                value={projectId}
                onChange={setProjectId}
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
            <Field label="Pair replies use">
              <BillingSelect value={billing} viewer={props.viewer} onChange={setBilling} />
            </Field>
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
  const [ownerId, setOwnerId] = useState<MemberId | null>(props.initialOwnerId);
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [baseRef, setBaseRef] = useState("main");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const mine = ownerId !== null && ownerId === props.viewer.memberId;
  const model = useSpaceModelSelection(
    props.environmentId,
    props.space.projectId,
    picked,
  ).selection;
  const ready =
    title.trim().length > 0 &&
    description.trim().length > 0 &&
    baseRef.trim().length > 0 &&
    ownerId !== null &&
    model !== null &&
    !busy;

  const create = async () => {
    if (!ready || ownerId === null || model === null) return;
    setBusy(true);
    const result = await task({
      environmentId: props.environmentId,
      input: {
        type: "create",
        spaceId: props.space.id,
        title: title.trim(),
        description: description.trim(),
        ownerId,
        modelSelection: model,
        base: {
          baseRef: baseRef.trim(),
          ...(branch.trim() === "" ? {} : { branch: branch.trim() }),
        },
      },
    });
    setBusy(false);
    toastCommandFailure("Could not create the task", result);
    if (result._tag !== "Success") return;
    props.onClose();
    if (mine) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: props.environmentId, threadId: result.value.threadId },
      });
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New task in {props.space.name}</DialogTitle>
          <DialogDescription>
            {mine
              ? "It starts at once on your account."
              : "It waits for its owner to start it on their account."}
          </DialogDescription>
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
            {mine ? (
              <Field label="Model">
                <SpaceModelPicker
                  environmentId={props.environmentId}
                  projectId={props.space.projectId}
                  value={picked}
                  onChange={setPicked}
                />
              </Field>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Base">
                <Input value={baseRef} onChange={(event) => setBaseRef(event.target.value)} />
              </Field>
              <Field label="Branch (optional)">
                <Input
                  value={branch}
                  placeholder="New from base"
                  onChange={(event) => setBranch(event.target.value)}
                />
              </Field>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="outline" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!ready} onClick={() => void create()}>
            {mine ? "Create and start" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SpaceSettingsDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly viewer: SpaceViewer;
  readonly onClose: () => void;
}) {
  const { space, viewer } = props;
  const canOperate = useCanOperateSpaces(props.environmentId);
  const controls = spaceControls(space, viewer.memberId, canOperate);
  const roster = useTeamMembers(props.environmentId);
  const mutate = useAtomCommand(spaceEnvironment.mutate, "Update space");
  const [name, setName] = useState(space.name);
  const [adding, setAdding] = useState<ReadonlySet<MemberId>>(new Set());
  const [confirm, setConfirm] = useState<SpaceConfirm | null>(null);
  const [busy, setBusy] = useState(false);
  const members = orderSpaceMembers(space);

  const apply = async (input: Parameters<typeof mutate>[0]["input"], failure: string) => {
    setBusy(true);
    const result = await mutate({ environmentId: props.environmentId, input });
    setBusy(false);
    toastCommandFailure(failure, result);
    return result._tag === "Success";
  };
  const update = (patch: {
    name?: string;
    projectId?: ProjectId;
    pairBilling?: SpacePairBilling;
  }) => apply({ type: "update", spaceId: space.id, ...patch }, "Could not update the space");
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

  if (confirm !== null) {
    return (
      <SpaceConfirmDialog
        environmentId={props.environmentId}
        viewer={viewer}
        confirm={confirm}
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
                    void update({ name: name.trim() });
                }}
              />
            </Field>
            <Field label="Project">
              <ProjectSelect
                environmentId={props.environmentId}
                value={space.projectId}
                disabled={!controls.canManage}
                onChange={(projectId) => void update({ projectId })}
              />
            </Field>
            <Field label="Pair replies use">
              <BillingSelect
                value={space.pairBilling}
                viewer={viewer}
                disabled={!controls.canManage}
                onChange={(pairBilling) => void update({ pairBilling })}
              />
            </Field>
            <Field label={`Members (${members.length})`}>
              <div className="flex flex-col gap-1">
                {members.map((member) => {
                  const isOwner = isSpaceOwner(space, member.memberId);
                  const self = member.memberId === viewer.memberId;
                  const name = viewer.nameOf(member.memberId);
                  return (
                    <div key={member.memberId} className="flex items-center gap-2 py-0.5">
                      <MemberAvatar
                        size="sm"
                        member={{
                          name,
                          color: roster.get(member.memberId)?.color ?? "var(--muted-foreground)",
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {name}
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
                              setConfirm({ type: "remove", space, memberId: member.memberId })
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
              onClick={() => setConfirm({ type: "leave", space })}
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
