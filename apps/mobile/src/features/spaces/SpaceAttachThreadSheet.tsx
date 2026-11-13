import { useAtomValue } from "@effect/atom-react";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import {
  spaceAttachConfirmCopy,
  spaceControls,
  spaceTaskStatusInfo,
  spaceThreadRunsIn,
} from "@t3tools/client-runtime/spaces";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  type Space,
  type SpaceTask,
  SpaceTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { relativeTime } from "../../lib/time";
import { useProjects } from "../../state/entities";
import {
  reportSpaceResult,
  spaceEnvironment,
  useCanOperateSpaces,
  useSpaceList,
  useSpaceViewer,
} from "../../state/spaces";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { SpaceSheetFrame } from "./SpaceSheetFrame";
import { SpaceTaskStatusIcon } from "./SpaceStatusIcon";

/** From a thread (`threadId`): pick a space, then a task. From a task page (`taskId`): pick a thread. */
type Params = {
  readonly environmentId: string;
  readonly threadId?: string;
  readonly spaceId?: string;
  readonly taskId?: string;
};

const ROW = "min-h-12 flex-row items-center gap-3 border-t border-border-subtle active:opacity-70";

export function SpaceAttachThreadSheet(props: StaticScreenProps<Params>) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const viewer = useSpaceViewer(environmentId);
  const canOperate = useCanOperateSpaces(environmentId);
  const { spaces, tasks } = useSpaceList(environmentId);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const shells = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  const linkThread = useAtomCommand(spaceEnvironment.linkThread, { reportFailure: false });
  const fixedThreadId =
    props.route.params.threadId === undefined ? null : ThreadId.make(props.route.params.threadId);
  const fixedTaskId =
    props.route.params.taskId === undefined ? null : SpaceTaskId.make(props.route.params.taskId);
  const writable = spaces.filter(
    (space) => spaceControls(space, viewer.memberId, canOperate).canCreateTask,
  );
  const fixedTask = tasks.find((task) => task.id === fixedTaskId) ?? null;
  const [spacePicked, setSpacePicked] = useState<Space | null>(null);
  const [taskPicked, setTaskPicked] = useState<SpaceTask | null>(null);
  const [threadPicked, setThreadPicked] = useState<OrchestrationV2ThreadShell | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => navigation.goBack();

  const thread = threadPicked ?? shells.find((candidate) => candidate.id === fixedThreadId) ?? null;
  const space =
    spacePicked ??
    writable.find(
      (candidate) => candidate.id === (fixedTask?.spaceId ?? props.route.params.spaceId),
    ) ??
    (writable.length === 1 ? writable[0]! : null);
  const task = taskPicked ?? fixedTask;
  const moving = thread?.space?.kind === "task";

  const add = async () => {
    if (thread === null || task === null || busy) return;
    setBusy(true);
    const result = await linkThread({
      environmentId,
      input: { threadId: thread.id, target: { spaceId: task.spaceId, taskId: task.id } },
    });
    setBusy(false);
    if (
      reportSpaceResult(moving ? "Could not move the thread" : "Could not add the thread", result)
    ) {
      close();
    }
  };

  const title = moving ? "Move to another task" : "Add to task";
  if (thread === null && fixedThreadId === null && task !== null) {
    // From the task page: the viewer's own threads that aren't on a task or a room.
    const mine = shells.filter(
      (candidate) =>
        candidate.ownerId === viewer.memberId &&
        candidate.archivedAt === null &&
        candidate.space == null,
    );
    return (
      <SpaceSheetFrame
        header={{ title: "Add existing thread", subtitle: task.title, onClose: close }}
      >
        {mine.length === 0 ? (
          <Text className="text-sm text-foreground-muted">
            You have no threads here that aren't on a task.
          </Text>
        ) : (
          <View>
            {mine.map((candidate) => (
              <Pressable
                key={candidate.id}
                accessibilityRole="button"
                onPress={() => setThreadPicked(candidate)}
                className={ROW}
              >
                <View className="min-w-0 flex-1">
                  <Text numberOfLines={1} className="text-base text-foreground">
                    {candidate.title}
                  </Text>
                  <Text numberOfLines={1} className="text-xs text-foreground-muted">
                    {[
                      spaceThreadRunsIn(candidate, projects),
                      relativeTime(DateTime.formatIso(candidate.updatedAt)),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </SpaceSheetFrame>
    );
  }
  if (thread === null) {
    return (
      <SpaceSheetFrame header={{ title, onClose: close }}>
        <Text className="text-sm text-foreground-muted">This thread isn't available.</Text>
      </SpaceSheetFrame>
    );
  }
  if (space === null) {
    return (
      <SpaceSheetFrame header={{ title, subtitle: thread.title, onClose: close }}>
        <Text className="text-sm font-t3-medium text-foreground-muted">Your spaces</Text>
        <View>
          {writable.map((candidate) => {
            const count = tasks.filter((entry) => entry.spaceId === candidate.id).length;
            const members = candidate.members.filter((member) => member.removedAt === null).length;
            return (
              <Pressable
                key={candidate.id}
                accessibilityRole="button"
                onPress={() => setSpacePicked(candidate)}
                className={ROW}
              >
                <SymbolView name="person.2" size={16} tintColorClassName="accent-icon-muted" />
                <View className="min-w-0 flex-1">
                  <Text numberOfLines={1} className="text-base text-foreground">
                    {candidate.name}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    {members} {members === 1 ? "member" : "members"} · {count} open{" "}
                    {count === 1 ? "task" : "tasks"}
                  </Text>
                </View>
                <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
              </Pressable>
            );
          })}
        </View>
        <Text className="text-xs text-foreground-muted">
          Only spaces you're a member of. The space's members will see the thread.
        </Text>
      </SpaceSheetFrame>
    );
  }
  if (task === null) {
    const open = tasks.filter(
      (candidate) =>
        candidate.spaceId === space.id &&
        !(thread.space?.kind === "task" && thread.space.taskId === candidate.id),
    );
    return (
      <SpaceSheetFrame
        header={{
          title,
          subtitle: space.name,
          ...(writable.length > 1 && spacePicked !== null
            ? { onCancel: () => setSpacePicked(null) }
            : { onClose: close }),
        }}
      >
        {open.length === 0 ? (
          <Text className="text-sm text-foreground-muted">No open tasks in {space.name}.</Text>
        ) : (
          <View>
            {open.map((candidate) => {
              const status = spaceTaskStatusInfo(candidate.status);
              return (
                <Pressable
                  key={candidate.id}
                  accessibilityRole="button"
                  onPress={() => setTaskPicked(candidate)}
                  className={ROW}
                >
                  <SpaceTaskStatusIcon
                    icon={status.icon}
                    tone={status.tone}
                    label={status.label}
                    size={16}
                  />
                  <View className="min-w-0 flex-1">
                    <Text numberOfLines={1} className="text-base text-foreground">
                      {candidate.title}
                    </Text>
                    <Text className="text-xs text-foreground-muted">
                      {status.label} ·{" "}
                      {candidate.ownerId === viewer.memberId
                        ? "You"
                        : viewer.nameOf(candidate.ownerId)}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </SpaceSheetFrame>
    );
  }
  const taskSpace = writable.find((candidate) => candidate.id === task.spaceId) ?? space;
  const copy = spaceAttachConfirmCopy(taskSpace, viewer, spaceThreadRunsIn(thread, projects));
  return (
    <SpaceSheetFrame
      header={{
        title: moving ? `Move to ${task.title}` : `Add to ${task.title}`,
        subtitle: thread.title,
        onCancel: close,
        dismissDisabled: busy,
      }}
    >
      <Text className="text-base text-foreground">{copy.description}</Text>
      <View className="flex-row gap-3">
        <Button label="Cancel" disabled={busy} onPress={close} />
        <Button
          label={moving ? "Move" : copy.action}
          tone="primary"
          loading={busy}
          onPress={() => void add()}
        />
      </View>
    </SpaceSheetFrame>
  );
}
