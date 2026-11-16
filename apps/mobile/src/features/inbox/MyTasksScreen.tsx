import { useAtomValue } from "@effect/atom-react";
import { type StaticScreenProps, StackActions, useNavigation } from "@react-navigation/native";
import { myTaskSections } from "@t3tools/client-runtime/inbox";
import {
  spaceTaskActivity,
  spaceTaskStatusInfo,
  spaceThreadsByTask,
} from "@t3tools/client-runtime/spaces";
import { EnvironmentId, type Space, type SpaceTask } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";
import { relativeTime } from "../../lib/time";
import { myTasksGroupBySpaceAtom, useClosedMyTasks } from "../../state/inbox";
import { useSpaceList, useSpaceSidebarShells, useSpaceViewer } from "../../state/spaces";
import {
  SpaceActivityGlyph,
  SpaceTaskStatusIcon,
  spaceToneTextClass,
} from "../spaces/SpaceStatusIcon";
import { SpaceMark } from "../spaces/SpaceMark";
import { PageTopBar } from "./PageTopBar";

type Params = { readonly environmentId: string };

/** The tasks the viewer owns in every space, by status (spec Part 1, My tasks). */
export function MyTasksScreen(props: StaticScreenProps<Params>) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { spaces, tasks, loaded } = useSpaceList(environmentId);
  const shells = useSpaceSidebarShells(environmentId);
  const viewer = useSpaceViewer(environmentId);
  const closedTasks = useClosedMyTasks(environmentId);
  const groupBySpace = useAtomValue(myTasksGroupBySpaceAtom(environmentId));
  // Toggled against each group's default, so Done and Canceled start collapsed.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const sections =
    viewer.memberId === null
      ? []
      : myTaskSections({ spaces, tasks, closedTasks, memberId: viewer.memberId, groupBySpace });
  const threadsByTask = spaceThreadsByTask(shells.taskThreads);
  const spaceById = new Map(spaces.map((space) => [space.id, space]));
  const open = sections.some((section) =>
    section.groups.some((group) => group.status !== "done" && group.status !== "canceled"),
  );
  const toggle = (key: string) => {
    const next = new Set(toggled);
    if (!next.delete(key)) next.add(key);
    setToggled(next);
  };

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
      <PageTopBar
        title="My tasks"
        trailing={
          <IconButton
            icon={
              groupBySpace
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            accessibilityLabel="Filters"
            onPress={() =>
              navigation.dispatch(StackActions.push("MyTasksFilters", { environmentId }))
            }
          />
        }
      />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        {!loaded ? (
          <View className="items-center p-8">
            <AppActivityIndicator colorClassName="accent-icon-muted" />
          </View>
        ) : open ? null : (
          <Text className="p-8 text-center text-sm text-foreground-muted">
            No open tasks. Tasks you own in any space show up here.
          </Text>
        )}
        {sections.map((section) => (
          <View key={section.space?.id ?? "all"} className="pt-2">
            {section.space === null ? null : (
              <View className="flex-row items-center gap-2 px-4 pt-3 pb-1">
                <SpaceMark space={section.space} size="sm" />
                <Text numberOfLines={1} className="text-sm font-t3-medium text-foreground">
                  {section.space.name}
                </Text>
              </View>
            )}
            {section.groups.map((group) => {
              const key = `${section.space?.id ?? "all"}:${group.status}`;
              const expanded = group.collapsed === toggled.has(key);
              return (
                <View key={key}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded }}
                    onPress={() => toggle(key)}
                    className="min-h-10 flex-row items-center gap-2 px-4 active:opacity-70"
                  >
                    <SymbolView
                      name={expanded ? "chevron.down" : "chevron.right"}
                      size={12}
                      tintColorClassName="accent-icon-muted"
                    />
                    <Text className="text-sm font-t3-medium text-foreground-muted">
                      {group.label}
                    </Text>
                    <Text className="text-xs tabular-nums text-foreground-muted">
                      {group.tasks.length}
                    </Text>
                  </Pressable>
                  {expanded
                    ? group.tasks.map((task) => (
                        <MyTaskRow
                          key={task.id}
                          task={task}
                          space={spaceById.get(task.spaceId) ?? null}
                          showSpace={section.space === null}
                          activity={spaceTaskActivity(
                            threadsByTask.get(task.id) ?? [],
                            viewer,
                            task,
                          )}
                          onPress={() =>
                            navigation.dispatch(
                              StackActions.push("SpaceTask", {
                                environmentId,
                                spaceId: task.spaceId,
                                taskId: task.id,
                              }),
                            )
                          }
                        />
                      ))
                    : null}
                </View>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function MyTaskRow(props: {
  readonly task: SpaceTask;
  readonly space: Space | null;
  readonly showSpace: boolean;
  readonly activity: ReturnType<typeof spaceTaskActivity>;
  readonly onPress: () => void;
}) {
  const { task, activity } = props;
  const status = spaceTaskStatusInfo(task.status);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[task.title, status.label, props.space?.name, activity.text]
        .filter((part) => part !== undefined)
        .join(", ")}
      onPress={props.onPress}
      className="min-h-14 gap-1 border-t border-border-subtle px-4 py-2 active:opacity-70"
    >
      <View className="flex-row items-center gap-2.5">
        <SpaceTaskStatusIcon icon={status.icon} tone={status.tone} label={status.label} size={16} />
        <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
          {task.title}
        </Text>
        <Text className="text-xs tabular-nums text-foreground-muted">
          {relativeTime(task.statusChangedAt)}
        </Text>
      </View>
      <View className="flex-row items-center gap-1.5 ps-[26px]">
        {props.showSpace && props.space !== null ? (
          <>
            <Text numberOfLines={1} className="shrink text-xs text-foreground-secondary">
              {props.space.name}
            </Text>
            <Text className="text-xs text-foreground-muted">·</Text>
          </>
        ) : null}
        {activity.glyph === null ? null : (
          <SpaceActivityGlyph glyph={activity.glyph} tone={activity.tone} />
        )}
        <Text
          numberOfLines={1}
          className={`min-w-0 flex-1 text-xs ${spaceToneTextClass(activity.tone)}`}
        >
          {activity.text}
        </Text>
      </View>
    </Pressable>
  );
}
