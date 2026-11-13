import { useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  spaceControls,
  spaceTaskStatusInfo,
  spaceThreadControls,
} from "@t3tools/client-runtime/spaces";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import type { AppBarMenu } from "../../components/ui/AppBar.types";
import * as Dialog from "../../components/ui/Dialog";
import { useThreadShell } from "../../state/entities";
import {
  reportSpaceResult,
  spaceEnvironment,
  useCanOperateSpaces,
  useSpaceEnvironmentIds,
  useSpaceList,
  useSpaceTaskView,
  useSpaceViewer,
} from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { SpaceTaskChip } from "./SpaceRecordLine";

/** A thread's place on a space task: the thread, its space and its task, or null off a task. */
function useSpaceThreadTask(environmentId: EnvironmentId | null, threadId: ThreadId | null) {
  const shell = useThreadShell(
    environmentId === null || threadId === null ? null : scopeThreadRef(environmentId, threadId),
  );
  const placement = shell?.source.space?.kind === "task" ? shell.source.space : null;
  const { spaces } = useSpaceList(environmentId);
  const view = useSpaceTaskView(
    placement === null ? null : environmentId,
    placement?.spaceId ?? null,
    placement?.taskId ?? null,
  );
  if (shell === null) return null;
  const space =
    placement === null
      ? null
      : (spaces.find((candidate) => candidate.id === placement.spaceId) ?? null);
  return { thread: shell.source, placement, space, task: view.data?.task ?? null };
}

/**
 * The thread screen's space parts: the "Space / Task · Status" breadcrumb, the header menu's
 * Add to task / Move / Remove, and whose model and Stop this is on someone else's thread.
 */
export function useSpaceThreadHeader(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  const navigation = useNavigation();
  const found = useSpaceThreadTask(environmentId, threadId);
  const viewer = useSpaceViewer(environmentId);
  const canOperate = useCanOperateSpaces(environmentId);
  const spaceEnvironments = useSpaceEnvironmentIds();
  const { spaces } = useSpaceList(environmentId);
  const linkThread = useAtomCommand(spaceEnvironment.linkThread, { reportFailure: false });
  if (found === null || environmentId === null) return null;
  const { thread, placement, space, task } = found;
  if (thread.space?.kind === "room") return null;

  if (placement === null) {
    // Off a task: the owner can add it to a task in a space they can write to.
    const canAdd =
      spaceEnvironments.includes(environmentId) &&
      thread.ownerId === viewer.memberId &&
      spaces.some(
        (candidate) => spaceControls(candidate, viewer.memberId, canOperate).canCreateTask,
      );
    if (!canAdd) return null;
    const menu: AppBarMenu = {
      title: "Space",
      icon: "person.2",
      items: [
        {
          id: "space-attach",
          title: "Add to task…",
          icon: "plus",
          onPress: () =>
            navigation.navigate("SpaceAttachThread", { environmentId, threadId: thread.id }),
        },
      ],
    };
    return { subtitle: null, menu, lock: null };
  }

  const status = task === null ? null : spaceTaskStatusInfo(task.status);
  const subtitle = [space?.name ?? "Space", task?.title ?? null, status?.label ?? null]
    .filter(Boolean)
    .join(" · ");
  if (space === null || task === null) return { subtitle, menu: null, lock: null };
  const controls = spaceThreadControls(thread, task, space, viewer.memberId, canOperate);
  const ownerName = thread.ownerId == null ? "the owner" : viewer.nameOf(thread.ownerId);
  const remove = () =>
    Dialog.confirm({
      title: "Remove from task?",
      message: `Stops sharing it with ${space.name}.`,
      confirmText: "Remove",
      destructive: true,
      onConfirm: () =>
        void linkThread({ environmentId, input: { threadId: thread.id, target: null } }).then(
          (result) => reportSpaceResult("Could not remove the thread", result),
        ),
    });
  const menu: AppBarMenu = {
    title: task.title,
    icon: "person.2",
    items: [
      {
        id: "space-open-task",
        title: "Open task",
        icon: "arrow.right.circle",
        onPress: () =>
          navigation.navigate("SpaceTask", {
            environmentId,
            spaceId: space.id,
            taskId: task.id,
          }),
      },
      {
        id: "space-move",
        title: "Move to another task…",
        icon: "arrow.right.circle",
        ...(controls.canMove ? {} : { disabled: true, subtitle: `Only ${ownerName} can move it.` }),
        onPress: () =>
          navigation.navigate("SpaceAttachThread", {
            environmentId,
            threadId: thread.id,
            spaceId: space.id,
          }),
      },
      {
        id: "space-remove",
        title: "Remove from task",
        icon: "trash",
        ...(controls.canRemove
          ? { subtitle: `Stops sharing it with ${space.name}.` }
          : { disabled: true, subtitle: `Only ${ownerName} can remove it.` }),
        onPress: remove,
      },
    ],
  };
  const lock = controls.modelLocked
    ? { ownerName, stopNeedsConfirm: controls.stopNeedsConfirm }
    : null;
  return { subtitle, menu, lock };
}

/** Above a task thread's first message: "You started this thread on [task] · Tue 10:36". */
export function SpaceThreadBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const found = useSpaceThreadTask(props.environmentId, props.threadId);
  const viewer = useSpaceViewer(props.environmentId);
  if (found?.placement == null) return null;
  const { placement, task } = found;
  const who = placement.linkedBy === viewer.memberId ? "You" : viewer.nameOf(placement.linkedBy);
  const verb = placement.via === "start" ? "started this thread on" : "added this thread to";
  const at = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(Date.parse(placement.linkedAt));
  return (
    <View className="flex-row flex-wrap items-center justify-center gap-1 px-4 pt-4 pb-2">
      <SymbolView name="person.2" size={12} tintColorClassName="accent-icon-muted" />
      <Text className="text-xs text-foreground-muted">
        {who} {verb}
      </Text>
      <SpaceTaskChip
        environmentId={props.environmentId}
        spaceId={placement.spaceId}
        taskId={placement.taskId}
        task={task ?? undefined}
      />
      <Text className="text-xs text-foreground-muted">· {at}</Text>
    </View>
  );
}
