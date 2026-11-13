import { StackActions, useNavigation } from "@react-navigation/native";
import {
  isSpaceOwner,
  spaceSidebarTasks,
  spaceTaskStatusInfo,
} from "@t3tools/client-runtime/spaces";
import type { EnvironmentId, Space, SpaceTask } from "@t3tools/contracts";
import { type ReactNode, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import {
  reportSpaceResult,
  spaceEnvironment,
  useCanOperateSpaces,
  useSpaceEnvironmentIds,
  useSpaceList,
  useSpaceSidebarShells,
  useSpaceViewer,
} from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { SpaceTaskStatusIcon } from "./SpaceStatusIcon";

const ROW = "min-h-11 flex-row items-center gap-3 px-4 active:opacity-70";

/** Assigned to me and Spaces, above the thread list, for each environment that hosts spaces. */
export function HomeSpacesSection() {
  const environmentIds = useSpaceEnvironmentIds();
  return (
    <>
      {environmentIds.map((environmentId) => (
        <HomeSpacesForEnvironment key={environmentId} environmentId={environmentId} />
      ))}
    </>
  );
}

function SectionHeader(props: {
  readonly label: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly count?: number;
  readonly trailing?: ReactNode;
}) {
  return (
    <View className="flex-row items-center pe-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        onPress={props.onToggle}
        className={cn(ROW, "flex-1")}
      >
        <Text className="text-sm font-t3-medium text-foreground-muted">{props.label}</Text>
        <SymbolView
          name={props.expanded ? "chevron.down" : "chevron.right"}
          size={11}
          tintColorClassName="accent-icon-muted"
        />
        <View className="flex-1" />
        {props.count === undefined || props.count === 0 ? null : (
          <View className="rounded-full bg-subtle px-2 py-0.5">
            <Text className="text-xs font-t3-medium text-foreground">{props.count}</Text>
          </View>
        )}
      </Pressable>
      {props.trailing}
    </View>
  );
}

function TaskRow(props: {
  readonly environmentId: EnvironmentId;
  readonly task: SpaceTask;
  readonly detail?: string;
}) {
  const navigation = useNavigation();
  const { task } = props;
  const status = spaceTaskStatusInfo(task.status);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${task.title}, ${props.detail ?? status.label}`}
      onPress={() =>
        navigation.dispatch(
          StackActions.push("SpaceTask", {
            environmentId: props.environmentId,
            spaceId: task.spaceId,
            taskId: task.id,
          }),
        )
      }
      className={cn(ROW, "ps-11")}
    >
      <SpaceTaskStatusIcon icon={status.icon} tone={status.tone} label={status.label} size={16} />
      <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
        {task.title}
      </Text>
    </Pressable>
  );
}

function HomeSpacesForEnvironment(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const navigation = useNavigation();
  const { spaces, tasks } = useSpaceList(environmentId);
  const shells = useSpaceSidebarShells(environmentId);
  const viewer = useSpaceViewer(environmentId);
  const canOperate = useCanOperateSpaces(environmentId);
  const [assignedOpen, setAssignedOpen] = useState(false);
  const [spacesOpen, setSpacesOpen] = useState(true);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const activeSpaces = spaces.filter((space) => space.archivedAt === null);
  const archived = spaces.filter((space) => space.archivedAt !== null);
  const sidebar = spaceSidebarTasks({ spaces, tasks }, shells.taskThreads, viewer);
  const assigned = sidebar.assignedToMe;

  return (
    <View className="pb-2">
      <SectionHeader
        label="Assigned to me"
        expanded={assignedOpen}
        count={assigned.length}
        onToggle={() => setAssignedOpen(!assignedOpen)}
      />
      {assignedOpen ? (
        assigned.length === 0 ? (
          <Text className="px-11 pb-2 text-sm text-foreground-muted">No open tasks.</Text>
        ) : (
          assigned.map((task) => (
            <TaskRow key={task.id} environmentId={environmentId} task={task} />
          ))
        )
      ) : null}
      <SectionHeader
        label="Spaces"
        expanded={spacesOpen}
        onToggle={() => setSpacesOpen(!spacesOpen)}
        trailing={
          canOperate ? (
            <IconButton
              icon="plus"
              accessibilityLabel="New space"
              onPress={() => navigation.dispatch(StackActions.push("SpaceNew", { environmentId }))}
            />
          ) : null
        }
      />
      {spacesOpen ? (
        <>
          {activeSpaces.length === 0 ? (
            <Text className="px-4 pb-2 text-sm text-foreground-muted">
              Rooms where your team and Pair work together.
            </Text>
          ) : null}
          {activeSpaces.map((space) => {
            const entry = sidebar.spaces.get(space.id);
            const more = entry?.more ?? 0;
            return (
              <View key={space.id}>
                <SpaceRow
                  environmentId={environmentId}
                  space={space}
                  unread={shells.unreadRoomIds.has(space.roomThreadId)}
                />
                {entry?.needsYou.map((row) => (
                  <TaskRow
                    key={row.task.id}
                    environmentId={environmentId}
                    task={row.task}
                    detail={row.activity.text}
                  />
                ))}
                {more > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      navigation.dispatch(
                        StackActions.push("SpaceRoom", { environmentId, spaceId: space.id }),
                      )
                    }
                    className={cn(ROW, "ps-11")}
                  >
                    <Text className="text-sm text-foreground-muted">
                      {more === 1 ? "1 more task" : `${more} more tasks`}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </>
      ) : null}
      {archived.length > 0 ? (
        <>
          <SectionHeader
            label="Archived"
            expanded={archivedOpen}
            onToggle={() => setArchivedOpen(!archivedOpen)}
          />
          {archivedOpen
            ? archived.map((space) => (
                <SpaceRow
                  key={space.id}
                  environmentId={environmentId}
                  space={space}
                  unread={false}
                  archivedActions={isSpaceOwner(space, viewer.memberId) && canOperate}
                />
              ))
            : null}
        </>
      ) : null}
    </View>
  );
}

function SpaceRow(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly unread: boolean;
  readonly archivedActions?: boolean;
}) {
  const navigation = useNavigation();
  const mutate = useAtomCommand(spaceEnvironment.mutate, { reportFailure: false });
  const archived = props.space.archivedAt !== null;
  const row = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.unread ? `${props.space.name}, unread` : props.space.name}
      onPress={() =>
        navigation.dispatch(
          StackActions.push("SpaceRoom", {
            environmentId: props.environmentId,
            spaceId: props.space.id,
          }),
        )
      }
      className={ROW}
    >
      <SymbolView name="person.2" size={16} tintColorClassName="accent-icon-muted" />
      <Text
        numberOfLines={1}
        className={cn(
          "min-w-0 flex-1 text-base",
          archived ? "text-foreground-muted" : "text-foreground",
          props.unread && "font-t3-bold",
        )}
      >
        {props.space.name}
      </Text>
      {props.unread ? <View className="size-2 rounded-full bg-primary" /> : null}
    </Pressable>
  );
  if (!props.archivedActions) return row;
  return (
    <Menu
      shouldOpenOnLongPress
      actions={[{ id: "unarchive", title: "Unarchive", image: "archivebox" }]}
      onPressAction={() =>
        void mutate({
          environmentId: props.environmentId,
          input: { type: "unarchive", spaceId: props.space.id },
        }).then((result) => reportSpaceResult("Could not unarchive", result))
      }
    >
      {row}
    </Menu>
  );
}
