import { type StaticScreenProps, StackActions, useNavigation } from "@react-navigation/native";
import {
  SPACE_OVERVIEW_SECTIONS,
  type SpaceOverviewSectionId,
  groupSpaceOverview,
  spaceTaskDetail,
} from "@t3tools/client-runtime/spaces";
import * as DateTime from "effect/DateTime";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { relativeTime } from "../../lib/time";
import { reportSpaceResult, spaceEnvironment } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { SpaceSheetFrame } from "./SpaceSheetFrame";
import { SpaceStatusIcon } from "./SpaceStatusIcon";
import { type SpaceSheetParams, useSheetSpace } from "./useSheetSpace";

type Tab = "overview" | "notes";

export function SpaceTasksSheet(props: StaticScreenProps<SpaceSheetParams>) {
  const navigation = useNavigation();
  const { environmentId, space, controls, viewer, tasks } = useSheetSpace(props.route.params);
  const mutate = useAtomCommand(spaceEnvironment.mutate, { reportFailure: false });
  const [tab, setTab] = useState<Tab>("overview");
  const [collapsed, setCollapsed] = useState<ReadonlySet<SpaceOverviewSectionId>>(
    () => new Set(SPACE_OVERVIEW_SECTIONS.filter((s) => s.collapsedByDefault).map((s) => s.id)),
  );
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
  const sections = groupSpaceOverview(tasks, viewer);
  const toggle = (id: SpaceOverviewSectionId) => {
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    setCollapsed(next);
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
          { value: "overview", label: "Overview" },
          { value: "notes", label: "Notes" },
        ]}
        selected={tab}
        onSelect={setTab}
      />
      {tab === "overview" ? (
        <View className="gap-3">
          {sections.length === 0 ? (
            <Text className="py-6 text-center text-sm text-foreground-muted">
              No tasks yet. Tasks you and your teammates create here show up in this list.
            </Text>
          ) : null}
          {sections.map((section) => {
            const expanded = !collapsed.has(section.id);
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
                  ? section.rows.map(({ thread, status }) => (
                      <Pressable
                        key={thread.id}
                        accessibilityRole="button"
                        accessibilityLabel={`${thread.title}, ${status.label}`}
                        onPress={() => {
                          navigation.goBack();
                          navigation.dispatch(
                            StackActions.push("Thread", { environmentId, threadId: thread.id }),
                          );
                        }}
                        className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle py-2 active:opacity-70"
                      >
                        <SpaceStatusIcon
                          icon={status.icon}
                          tone={status.tone}
                          label={status.label}
                          size={18}
                        />
                        <View className="min-w-0 flex-1">
                          <Text numberOfLines={1} className="text-base text-foreground">
                            {thread.title}
                          </Text>
                          <Text numberOfLines={1} className="text-xs text-foreground-muted">
                            {[status.label, spaceTaskDetail(thread, status, space, viewer)]
                              .filter((part) => part !== "")
                              .join(" · ")}
                          </Text>
                        </View>
                        <Text className="text-xs text-foreground-muted">
                          {relativeTime(DateTime.formatIso(thread.updatedAt))}
                        </Text>
                      </Pressable>
                    ))
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
