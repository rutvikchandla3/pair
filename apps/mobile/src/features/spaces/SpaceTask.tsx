import { StackActions, useNavigation } from "@react-navigation/native";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  joinNames,
  orderSpaceMembers,
  spaceTaskChangeHint,
  spaceTaskControls,
} from "@t3tools/client-runtime/spaces";
import { isWorkspaceProject } from "@t3tools/client-runtime/state/workspaces";
import type {
  EnvironmentId,
  MemberId,
  ModelSelection,
  OrchestrationV2ThreadShell,
  Space,
  SpaceTaskAction,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { MemberAvatar } from "../../components/MemberAvatar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ControlPill } from "../../components/ui/ControlPill";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { relativeTime } from "../../lib/time";
import { useProject, useThreadShell } from "../../state/entities";
import {
  reportSpaceResult,
  spaceEnvironment,
  useCanOperateSpaces,
  useSpaceList,
  useSpaceViewer,
} from "../../state/spaces";
import { useTeamRoster } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { openSettings } from "../settings/settings-navigation";
import { SpaceModelRow, useSpaceModel } from "./SpaceFields";

/** The task's raw shell and its space, or null for any other thread. */
function useSpaceTask(environmentId: EnvironmentId | null, threadId: ThreadId | null) {
  const shell = useThreadShell(
    environmentId === null || threadId === null ? null : scopeThreadRef(environmentId, threadId),
  );
  const { spaces } = useSpaceList(shell?.source.space?.kind === "task" ? environmentId : null);
  const placement = shell?.source.space;
  if (shell === null || placement?.kind !== "task") return null;
  const space = spaces.find((candidate) => candidate.id === placement.spaceId);
  return space === undefined ? null : { thread: shell.source, space };
}

/** Whose model and Stop this is when the viewer isn't the task's owner; null otherwise. */
export function useSpaceTaskComposerLock(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  const task = useSpaceTask(environmentId, threadId);
  const viewer = useSpaceViewer(environmentId);
  const canOperate = useCanOperateSpaces(environmentId);
  if (task === null) return null;
  const controls = spaceTaskControls(task.thread, task.space, viewer.memberId, canOperate);
  if (!controls.modelLocked) return null;
  const ownerName = task.thread.ownerId == null ? "the owner" : viewer.nameOf(task.thread.ownerId);
  return { ownerName, stopNeedsConfirm: controls.stopNeedsConfirm };
}

/** An unstarted space task, with the viewer's part in it; null once it starts or off a space. */
export function useUnstartedSpaceTask(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  const task = useSpaceTask(environmentId, threadId);
  const viewer = useSpaceViewer(environmentId);
  const canOperate = useCanOperateSpaces(environmentId);
  if (task === null || task.thread.space?.kind !== "task") return null;
  const controls = spaceTaskControls(task.thread, task.space, viewer.memberId, canOperate);
  if (controls.started) return null;
  return { ...task, placement: task.thread.space, controls, viewer };
}

type UnstartedSpaceTask = NonNullable<ReturnType<typeof useUnstartedSpaceTask>>;

const assignedAtFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

function ownerNameOf(task: {
  thread: OrchestrationV2ThreadShell;
  viewer: UnstartedSpaceTask["viewer"];
}) {
  return task.thread.ownerId == null ? "its owner" : task.viewer.nameOf(task.thread.ownerId);
}

function useTaskActions(environmentId: EnvironmentId, task: UnstartedSpaceTask) {
  const run = useAtomCommand(spaceEnvironment.task, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const act = async (action: SpaceTaskAction, failure: string) => {
    if (busy) return false;
    setBusy(true);
    const result = await run({ environmentId, input: action });
    setBusy(false);
    return reportSpaceResult(failure, result);
  };
  const others = orderSpaceMembers(task.space).filter(
    (member) => member.memberId !== task.thread.ownerId,
  );
  return { busy, act, others };
}

function AssignMenu(props: {
  readonly label: string;
  readonly task: UnstartedSpaceTask;
  readonly members: ReadonlyArray<{ readonly memberId: MemberId }>;
  readonly disabled: boolean;
  readonly onPick: (ownerId: MemberId) => void;
}) {
  if (props.members.length === 0) return null;
  const nameOf = (memberId: MemberId) =>
    memberId === props.task.viewer.memberId ? "You" : props.task.viewer.nameOf(memberId);
  return (
    <Menu
      actions={props.members.map((member) => ({
        id: member.memberId,
        title: nameOf(member.memberId),
      }))}
      onPressAction={({ nativeEvent }) => {
        const member = props.members.find((candidate) => candidate.memberId === nativeEvent.event);
        if (member !== undefined) props.onPick(member.memberId);
      }}
    >
      <ControlPill variant="pill" label={props.label} disabled={props.disabled} />
    </Menu>
  );
}

function SpaceChip(props: { readonly environmentId: EnvironmentId; readonly space: Space }) {
  const navigation = useNavigation();
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() =>
        navigation.dispatch(
          StackActions.push("SpaceRoom", {
            environmentId: props.environmentId,
            spaceId: props.space.id,
          }),
        )
      }
      className="flex-row items-center gap-1 active:opacity-70"
    >
      <SymbolView name="person.2" size={12} tintColorClassName="accent-icon-muted" />
      <Text className="text-xs font-t3-medium text-foreground">{props.space.name}</Text>
    </Pressable>
  );
}

/** The top of an unstarted task's feed: who assigned it where, then the unsent description. */
export function SpaceTaskIntro(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const task = useUnstartedSpaceTask(props.environmentId, props.threadId);
  if (task === null) return null;
  return <SpaceTaskIntroFor environmentId={props.environmentId} task={task} />;
}

function SpaceTaskIntroFor(props: {
  readonly environmentId: EnvironmentId;
  readonly task: UnstartedSpaceTask;
}) {
  const { task } = props;
  const { members } = useTeamRoster(props.environmentId);
  const { act } = useTaskActions(props.environmentId, task);
  const { viewer, placement } = task;
  const ownerName = ownerNameOf(task);
  const isOwner = task.controls.isTaskOwner;
  const assigner =
    placement.createdBy === viewer.memberId ? "You" : viewer.nameOf(placement.createdBy);
  const createdAt = DateTime.toEpochMillis(task.thread.createdAt);
  const edit = () =>
    Dialog.prompt({
      title: "Edit task",
      message: task.thread.title,
      initialValue: placement.description,
      confirmText: "Save",
      onConfirm: (description) => {
        if (description.trim() === "") return;
        void act(
          {
            type: "edit",
            threadId: task.thread.id,
            title: task.thread.title,
            description: description.trim(),
          },
          "Could not save",
        );
      },
    });
  return (
    <View className="gap-4 px-4 pt-4 pb-6">
      <View className="flex-row flex-wrap items-center justify-center gap-1">
        <SymbolView name="person.crop.circle" size={12} tintColorClassName="accent-icon-muted" />
        <Text className="text-xs text-foreground-muted">
          {assigner} assigned this to {isOwner ? "you" : ownerName} in
        </Text>
        <SpaceChip environmentId={props.environmentId} space={task.space} />
        <Text className="text-xs text-foreground-muted">
          · {assignedAtFormat.format(createdAt)}
        </Text>
      </View>
      {isOwner ? null : (
        <View className="items-end gap-1.5 ps-12">
          <View className="flex-row items-center gap-1.5">
            <MemberAvatar
              size="sm"
              member={{
                name: viewer.nameOf(placement.createdBy),
                color: members.get(placement.createdBy)?.color ?? "#71717a",
              }}
            />
            <Text className="text-sm font-t3-medium text-foreground">
              {viewer.nameOf(placement.createdBy)}
            </Text>
          </View>
          <View className="rounded-xl border border-dashed border-border px-3 py-2">
            <Text selectable className="text-sm text-foreground">
              {placement.description}
            </Text>
          </View>
          <View className="flex-row flex-wrap items-center justify-end gap-1">
            <SymbolView name="clock" size={12} tintColorClassName="accent-icon-muted" />
            <Text className="text-xs text-foreground-muted">
              Not sent yet · sends when {ownerName} starts the task
            </Text>
            {task.controls.canNudge ? (
              <Button label="Edit" tone="text" size="compact" onPress={edit} />
            ) : null}
          </View>
        </View>
      )}
    </View>
  );
}

/** In place of the composer until the task starts: the owner's start, or who it waits for. */
export function SpaceTaskStartBar(props: {
  readonly environmentId: EnvironmentId;
  readonly task: UnstartedSpaceTask;
  readonly bottomInset: number;
}) {
  const { task } = props;
  const { busy, act, others } = useTaskActions(props.environmentId, task);
  if (task.controls.canStart) {
    return (
      <SpaceTaskStartComposer
        environmentId={props.environmentId}
        task={task}
        bottomInset={props.bottomInset}
      />
    );
  }
  const ownerName = ownerNameOf(task);
  return (
    <View className="px-3 pt-1.5" style={{ paddingBottom: props.bottomInset + 6 }}>
      <View className="gap-2 rounded-2xl border border-border bg-card px-3 py-2.5">
        <View className="flex-row items-center gap-2">
          <SymbolView name="clock" size={16} tintColorClassName="accent-icon-muted" />
          <Text numberOfLines={2} className="min-w-0 flex-1 text-sm text-foreground">
            <Text className="text-sm font-t3-medium">Waiting for {ownerName} to start</Text>
            <Text className="text-sm text-foreground-muted">
              {" "}
              · assigned {relativeTime(DateTime.formatIso(task.thread.createdAt))} ago
            </Text>
          </Text>
        </View>
        {task.controls.canNudge ? (
          <View className="flex-row flex-wrap gap-2">
            <Button
              label={`Remind ${ownerName}`}
              size="compact"
              disabled={busy}
              onPress={() =>
                void act({ type: "remind", threadId: task.thread.id }, "Could not remind")
              }
            />
            <AssignMenu
              label="Reassign"
              task={task}
              members={others}
              disabled={busy}
              onPick={(ownerId) =>
                void act(
                  { type: "reassign", threadId: task.thread.id, ownerId },
                  "Could not reassign",
                )
              }
            />
          </View>
        ) : (
          <Text className="text-xs text-foreground-muted">
            {spaceTaskChangeHint(task.thread, task.viewer)}
          </Text>
        )}
      </View>
    </View>
  );
}

function SpaceTaskStartComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly task: UnstartedSpaceTask;
  readonly bottomInset: number;
}) {
  const { task } = props;
  const navigation = useNavigation();
  const { busy, act, others } = useTaskActions(props.environmentId, task);
  const project = useProject(scopeProjectRef(props.environmentId, task.space.projectId));
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [text, setText] = useState(task.placement.description);
  const model = useSpaceModel(props.environmentId, task.space.projectId, picked).selection;
  const { viewer, placement } = task;
  const ownTask = placement.createdBy === viewer.memberId;
  const body = text.trim();
  const canStart = !busy && model !== null && body !== "";
  const repos = isWorkspaceProject(project)
    ? project.roots.map((root) => root.name)
    : [project?.title ?? "the project"];
  const creatorName = viewer.nameOf(placement.createdBy);

  const start = () => {
    if (!canStart || model === null) return;
    void act(
      {
        type: "start",
        threadId: task.thread.id,
        modelSelection: model,
        ...(body === placement.description ? {} : { text: body }),
      },
      "Could not start",
    );
  };
  const handBack = () =>
    Dialog.prompt({
      title: "Can't take it?",
      message: `It goes back to ${creatorName}, with your reason in the room.`,
      initialValue: "",
      confirmText: "Hand back",
      onConfirm: (reason) => {
        if (reason.trim() === "") return;
        void act(
          { type: "hand-back", threadId: task.thread.id, reason: reason.trim() },
          "Could not hand it back",
        );
      },
    });

  return (
    <View className="gap-1.5 px-3 pt-1.5" style={{ paddingBottom: props.bottomInset + 6 }}>
      <View className="gap-2 rounded-2xl border border-border bg-card p-2">
        <View className="flex-row items-center gap-1.5 rounded-lg bg-subtle px-2.5 py-1.5">
          <SymbolView name="doc.text" size={12} tintColorClassName="accent-icon-muted" />
          <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-foreground-muted">
            <Text className="text-xs font-t3-medium text-foreground">
              {ownTask ? "Your description" : `${creatorName}'s description`}
            </Text>{" "}
            · edit it before you start
          </Text>
        </View>
        <TextInput
          multiline
          accessibilityLabel="Task description"
          value={text}
          onChangeText={setText}
          className="max-h-64 min-h-16 px-2 py-2 text-base text-foreground"
        />
        {model === null ? (
          <View className="flex-row items-center gap-2 rounded-md bg-warning/10 px-3 py-2">
            <Text className="min-w-0 flex-1 text-sm text-warning-foreground">
              Connect a provider account in Settings to start this task. It runs on your account.
            </Text>
            <Button
              label="Open Settings"
              size="compact"
              onPress={() => openSettings(navigation, "SettingsProviderAccounts")}
            />
          </View>
        ) : (
          <SpaceModelRow
            environmentId={props.environmentId}
            projectId={task.space.projectId}
            value={picked}
            disabled={busy}
            onChange={setPicked}
          />
        )}
        <View className="flex-row flex-wrap items-center justify-end gap-2">
          {ownTask ? null : (
            <Button
              label="Can't take it"
              tone="text"
              size="compact"
              disabled={busy}
              onPress={handBack}
            />
          )}
          <AssignMenu
            label="Assign to…"
            task={task}
            members={others}
            disabled={busy}
            onPick={(ownerId) =>
              void act(
                { type: "reassign", threadId: task.thread.id, ownerId },
                "Could not reassign",
              )
            }
          />
          <Button
            label="Start task"
            icon="play"
            tone="primary"
            size="compact"
            loading={busy}
            disabled={!canStart}
            onPress={start}
          />
        </View>
      </View>
      <View className="flex-row items-center gap-1.5 px-2">
        <SymbolView name="cloud" size={12} tintColorClassName="accent-icon-muted" />
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
          Starts a cloud machine with {joinNames(repos)}. Nothing runs until then.
        </Text>
      </View>
    </View>
  );
}
