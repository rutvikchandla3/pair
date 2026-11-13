import { StackActions, useNavigation } from "@react-navigation/native";
import {
  type SpaceRecordContext,
  type SpaceTaskLineEntry,
  type SpaceViewer,
  spaceRecordText,
  spaceStatusUndo,
  spaceTaskStatusInfo,
  spaceUndoneEntryIds,
} from "@t3tools/client-runtime/spaces";
import type {
  EnvironmentId,
  Space,
  SpaceRoomEntry,
  SpaceTask,
  SpaceTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { reportSpaceResult, spaceEnvironment } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { SpaceTaskStatusIcon } from "./SpaceStatusIcon";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function openSpaceTask(
  navigation: { readonly dispatch: (action: ReturnType<typeof StackActions.push>) => void },
  environmentId: EnvironmentId,
  task: Pick<SpaceTask, "spaceId" | "id">,
) {
  navigation.dispatch(
    StackActions.push("SpaceTask", { environmentId, spaceId: task.spaceId, taskId: task.id }),
  );
}

/** A task chip: its status icon and title; opens the task page. */
export function SpaceTaskChip(props: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: Space["id"];
  readonly taskId: SpaceTaskId;
  readonly task: SpaceTask | undefined;
}) {
  const navigation = useNavigation();
  const status = props.task === undefined ? null : spaceTaskStatusInfo(props.task.status);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${props.task?.title ?? "task"}`}
      onPress={() =>
        openSpaceTask(navigation, props.environmentId, {
          spaceId: props.spaceId,
          id: props.taskId,
        })
      }
      hitSlop={6}
      className="max-w-full flex-row items-center gap-1 rounded px-1 active:bg-subtle"
    >
      {status === null ? null : (
        <SpaceTaskStatusIcon icon={status.icon} tone={status.tone} label={status.label} size={12} />
      )}
      <Text numberOfLines={1} className="shrink text-[13px] font-t3-medium text-foreground">
        {props.task?.title ?? "Task"}
      </Text>
    </Pressable>
  );
}

/**
 * One task line: "[actor] moved [chip] to In review · 10:41", with Undo on an agent's or Pair's
 * move. Used by the room and the task page's Activity.
 */
export function SpaceRecordLine(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly entry: SpaceTaskLineEntry;
  readonly entries: ReadonlyArray<SpaceRoomEntry>;
  readonly tasksById: ReadonlyMap<SpaceTaskId, SpaceTask>;
  readonly viewer: SpaceViewer;
  readonly onTask: SpaceTaskId | null;
  readonly threadTitle: (threadId: ThreadId) => string | null;
  readonly className?: string;
}) {
  const navigation = useNavigation();
  const { entry } = props;
  const ctx: SpaceRecordContext = {
    viewer: props.viewer,
    inThread: null,
    onTask: props.onTask,
    threadTitle: props.threadTitle,
    undone: spaceUndoneEntryIds(props.entries),
  };
  const view = spaceRecordText(entry, ctx);
  return (
    <View className={cn("min-h-[22px] flex-row flex-wrap items-center gap-x-1", props.className)}>
      {view.lead === null ? null : (
        <SymbolView
          name={view.lead === "move" ? "arrow.right.circle" : "arrow.uturn.backward"}
          size={12}
          tintColorClassName="accent-icon-muted"
        />
      )}
      {view.segments.map((segment, index) => {
        switch (segment.type) {
          case "text":
            return (
              <Text
                // oxlint-disable-next-line react/no-array-index-key -- segments have no identity
                key={index}
                className={cn(
                  "text-xs leading-[22px] text-foreground-muted",
                  view.muted && "line-through",
                )}
              >
                {segment.text}
              </Text>
            );
          case "task":
            return (
              <SpaceTaskChip
                // oxlint-disable-next-line react/no-array-index-key -- segments have no identity
                key={index}
                environmentId={props.environmentId}
                spaceId={props.space.id}
                taskId={segment.taskId}
                task={props.tasksById.get(segment.taskId)}
              />
            );
          case "thread":
            return (
              <Pressable
                // oxlint-disable-next-line react/no-array-index-key -- segments have no identity
                key={index}
                accessibilityRole="link"
                onPress={() =>
                  navigation.dispatch(
                    StackActions.push("Thread", {
                      environmentId: props.environmentId,
                      threadId: segment.threadId,
                    }),
                  )
                }
                className="active:opacity-70"
              >
                <Text className="text-xs leading-[22px] font-t3-medium text-foreground-secondary underline">
                  {segment.text}
                </Text>
              </Pressable>
            );
        }
      })}
      <Text className="text-xs leading-[22px] text-foreground-muted">
        · {timeFormat.format(Date.parse(entry.createdAt))}
      </Text>
      <SpaceStatusUndoButton
        environmentId={props.environmentId}
        space={props.space}
        entry={entry}
        task={props.tasksById.get(entry.line.taskId) ?? null}
        entries={props.entries}
        viewer={props.viewer}
      />
    </View>
  );
}

/** Undo on an agent's or Pair's status move, or why it can't be undone. */
export function SpaceStatusUndoButton(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly entry: SpaceTaskLineEntry;
  readonly task: SpaceTask | null;
  readonly entries: ReadonlyArray<SpaceRoomEntry>;
  readonly viewer: SpaceViewer;
}) {
  const undoStatus = useAtomCommand(spaceEnvironment.undoTaskStatus, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const undo = spaceStatusUndo(props.entry, props.task, props.space, props.viewer, props.entries);
  if (undo === null) return null;
  if (undo.state !== "available") {
    return <Text className="text-xs text-foreground-muted">· {undo.tooltip}</Text>;
  }
  const runUndo = async () => {
    if (busy) return;
    setBusy(true);
    const result = await undoStatus({ environmentId: props.environmentId, input: undo.input });
    setBusy(false);
    reportSpaceResult("Could not undo", result);
  };
  return (
    <Button
      label="Undo"
      tone="text"
      size="compact"
      disabled={busy}
      onPress={() => void runUndo()}
    />
  );
}
