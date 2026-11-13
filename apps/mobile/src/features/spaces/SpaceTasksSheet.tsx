import { type StaticScreenProps, StackActions, useNavigation } from "@react-navigation/native";
import {
  type SpaceOverviewSectionId,
  groupSpaceOverview,
  spaceThreadsByTask,
} from "@t3tools/client-runtime/spaces";
import * as DateTime from "effect/DateTime";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { MemberAvatar } from "../../components/MemberAvatar";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { relativeTime } from "../../lib/time";
import { reportSpaceResult, spaceEnvironment } from "../../state/spaces";
import { useTeamRoster } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { SpaceSheetFrame } from "./SpaceSheetFrame";
import { SpaceActivityGlyph, SpaceTaskStatusIcon, spaceToneTextClass } from "./SpaceStatusIcon";
import { type SpaceSheetParams, useSheetSpace } from "./useSheetSpace";

type Tab = "tasks" | "notes";

export function SpaceTasksSheet(props: StaticScreenProps<SpaceSheetParams>) {
  const navigation = useNavigation();
  const { environmentId, space, controls, viewer, tasks, threads } = useSheetSpace(
    props.route.params,
  );
  const { members } = useTeamRoster(environmentId);
  const mutate = useAtomCommand(spaceEnvironment.mutate, { reportFailure: false });
  const [tab, setTab] = useState<Tab>("tasks");
  // Toggled against each section's default, so Done and Canceled start collapsed.
  const [toggled, setToggled] = useState<ReadonlySet<SpaceOverviewSectionId>>(new Set());
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const close = () => navigation.goBack();
  if (space === null || controls === null) {
    return (
      <SpaceSheetFrame header={{ title: "Tasks", onClose: close }}>
        <Text className="text-sm text-foreground-muted">This space isn't available.</Text>
      </SpaceSheetFrame>
    );
  }
  const sections = groupSpaceOverview(tasks, spaceThreadsByTask(threads), viewer);
  const toggle = (id: SpaceOverviewSectionId) => {
    const next = new Set(toggled);
    if (!next.delete(id)) next.add(id);
    setToggled(next);
  };
  const params = { environmentId, spaceId: space.id };
  const saveBrief = async () => {
    if (draft === null || saving) return;
    const brief = draft.trim();
    if (brief === space.brief) {
      setDraft(null);
      return;
    }
    setSaving(true);
    const result = await mutate({
      environmentId,
      input: { type: "update", spaceId: space.id, brief },
    });
    setSaving(false);
    if (reportSpaceResult("Could not save the brief", result)) setDraft(null);
  };

  return (
    <SpaceSheetFrame header={{ title: space.name, onClose: close }}>
      <SegmentedControl
        role="tab"
        options={[
          { value: "tasks", label: "Tasks" },
          { value: "notes", label: "Notes" },
        ]}
        selected={tab}
        onSelect={setTab}
      />
      {tab === "tasks" ? (
        <View className="gap-3">
          {sections.length === 0 ? (
            <Text className="py-6 text-center text-sm text-foreground-muted">
              No tasks yet. Tasks you and your teammates create here show up in this list.
            </Text>
          ) : null}
          {sections.map((section) => {
            const expanded = section.collapsedByDefault === toggled.has(section.id);
            return (
              <View key={section.id}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  onPress={() => toggle(section.id)}
                  className="min-h-11 flex-row items-center gap-2 active:opacity-70"
                >
                  <SymbolView
                    name={expanded ? "chevron.down" : "chevron.right"}
                    size={12}
                    tintColorClassName="accent-icon-muted"
                  />
                  <Text
                    className={
                      section.id === "needs-you"
                        ? "text-sm font-t3-bold text-foreground"
                        : "text-sm font-t3-medium text-foreground-muted"
                    }
                  >
                    {section.label}
                  </Text>
                  <Text className="text-xs text-foreground-muted">{section.rows.length}</Text>
                </Pressable>
                {expanded
                  ? section.rows.map(({ task, status, activity, activityAt }) => {
                      const owner =
                        task.ownerId === viewer.memberId ? "You" : viewer.nameOf(task.ownerId);
                      return (
                        <Pressable
                          key={task.id}
                          accessibilityRole="button"
                          accessibilityLabel={`${task.title}, ${status.label}, ${activity.text}`}
                          accessibilityHint="Long-press to change status"
                          onPress={() => {
                            navigation.goBack();
                            navigation.dispatch(
                              StackActions.push("SpaceTask", { ...params, taskId: task.id }),
                            );
                          }}
                          onLongPress={
                            controls.canCreateTask
                              ? () =>
                                  navigation.dispatch(
                                    StackActions.push("SpaceTaskStatus", {
                                      ...params,
                                      taskId: task.id,
                                    }),
                                  )
                              : undefined
                          }
                          className={
                            section.band
                              ? "min-h-14 gap-1 border-t border-border-subtle py-2 opacity-60 active:opacity-40"
                              : "min-h-14 gap-1 border-t border-border-subtle py-2 active:opacity-70"
                          }
                        >
                          <View className="flex-row items-center gap-2.5">
                            <SpaceTaskStatusIcon
                              icon={status.icon}
                              tone={status.tone}
                              label={status.label}
                              size={16}
                            />
                            <Text
                              numberOfLines={1}
                              className="min-w-0 flex-1 text-base text-foreground"
                            >
                              {task.title}
                            </Text>
                            <Text className="text-xs text-foreground-muted">
                              {relativeTime(DateTime.formatIso(DateTime.makeUnsafe(activityAt)))}
                            </Text>
                          </View>
                          <View className="flex-row items-center gap-1.5 ps-[26px]">
                            <MemberAvatar
                              size="sm"
                              member={{
                                name: viewer.nameOf(task.ownerId),
                                color: members.get(task.ownerId)?.color ?? "#71717a",
                              }}
                            />
                            <Text className="text-xs text-foreground-secondary">{owner}</Text>
                            <Text className="text-xs text-foreground-muted">·</Text>
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
                    })
                  : null}
              </View>
            );
          })}
          {controls.canCreateTask ? (
            <Button
              label="New task"
              icon="plus"
              onPress={() => navigation.dispatch(StackActions.replace("SpaceNewTask", params))}
            />
          ) : null}
          {controls.canCreateTask && sections.length > 0 ? (
            <Text className="text-center text-xs text-foreground-muted">
              Long-press a task to change its status.
            </Text>
          ) : null}
        </View>
      ) : (
        <View className="gap-5">
          <View className="gap-2">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-t3-medium text-foreground">Brief</Text>
              {controls.canEditNotes && draft === null ? (
                <Button
                  label="Edit"
                  tone="text"
                  size="compact"
                  onPress={() => setDraft(space.brief)}
                />
              ) : null}
            </View>
            {draft === null ? (
              <Text
                selectable
                className={
                  space.brief === "" ? "text-sm text-foreground-muted" : "text-sm text-foreground"
                }
              >
                {space.brief === ""
                  ? "No brief yet. Pair reads it before every reply here."
                  : space.brief}
              </Text>
            ) : (
              <>
                <TextInput
                  autoFocus
                  multiline
                  accessibilityLabel="Brief"
                  value={draft}
                  onChangeText={setDraft}
                  className="min-h-24 rounded-xl bg-subtle px-4 py-3 text-base text-foreground"
                />
                <View className="flex-row justify-end gap-2">
                  <Button label="Cancel" tone="text" onPress={() => setDraft(null)} />
                  <Button
                    label="Save"
                    tone="primary"
                    disabled={saving}
                    onPress={() => void saveBrief()}
                  />
                </View>
              </>
            )}
          </View>
          <View className="gap-2">
            <Text className="text-sm font-t3-medium text-foreground">Pair's notes</Text>
            <Text className="text-sm text-foreground-muted">
              Pair keeps notes here as it works in this space.
            </Text>
          </View>
        </View>
      )}
    </SpaceSheetFrame>
  );
}
