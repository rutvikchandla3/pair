import { type StaticScreenProps, StackActions, useNavigation } from "@react-navigation/native";
import {
  isSpaceTaskLineEntry,
  mergeSpaceThreads,
  orderSpaceMembers,
  spaceLiveTask,
  spaceMemberLabel,
  spaceMergedSuggestion,
  spaceTaskAssignedAt,
  spaceTaskAssignmentNotice,
  spaceTaskControls,
  spaceTaskEntries,
  spaceTaskStatusInfo,
  spaceThreadActivityView,
  spaceThreadRunsIn,
  spaceThreadsByTask,
} from "@t3tools/client-runtime/spaces";
import {
  type EnvironmentId,
  MemberId,
  type OrchestrationV2ThreadShell,
  type Space,
  type SpaceTask,
  SpaceTaskId,
  type SpaceTaskView,
} from "@t3tools/contracts";
import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import * as DateTime from "effect/DateTime";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { MemberAvatar } from "../../components/MemberAvatar";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ControlPill } from "../../components/ui/ControlPill";
import * as Dialog from "../../components/ui/Dialog";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { Toast } from "../../components/ui/Toast";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { relativeTime } from "../../lib/time";
import { useProjects } from "../../state/entities";
import { reportSpaceResult, spaceEnvironment, useSpaceTaskView } from "../../state/spaces";
import { useTeamRoster } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { SpaceRecordLine } from "./SpaceRecordLine";
import { dismissSpaceUndoNotice, showSpaceUndoNotice, useSpaceUndoNotice } from "./space-notices";
import { SpaceActivityGlyph, SpaceTaskStatusIcon, spaceToneTextClass } from "./SpaceStatusIcon";
import type { SpaceTaskSheetParams } from "./SpaceStatusSheet";
import { useSheetSpace } from "./useSheetSpace";

const createdFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

const NO_THREADS: ReadonlyArray<OrchestrationV2ThreadShell> = [];

/** The task page (board 9b): properties, description, its threads and its activity. */
export function SpaceTaskScreen(props: StaticScreenProps<SpaceTaskSheetParams>) {
  const insets = useSafeAreaInsets();
  const sheet = useSheetSpace(props.route.params);
  const taskId = SpaceTaskId.make(props.route.params.taskId);
  const view = useSpaceTaskView(sheet.environmentId, sheet.spaceId, taskId);
  const task = spaceLiveTask(
    sheet.tasks.find((candidate) => candidate.id === taskId) ?? null,
    view.data?.task ?? null,
  );
  const space = sheet.space;
  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
      {space === null || task === null || view.data === null ? (
        <>
          <TaskTopBar environmentId={sheet.environmentId} space={space} task={null} />
          <View className="flex-1 items-center justify-center p-6">
            {view.error !== null || sheet.room === null ? (
              <Text className="text-center text-sm text-foreground-muted">
                {view.error ?? "This task isn't available."}
              </Text>
            ) : (
              <AppActivityIndicator colorClassName="accent-icon-muted" />
            )}
          </View>
        </>
      ) : (
        <TaskPage
          environmentId={sheet.environmentId}
          space={space}
          task={task}
          view={view.data}
          liveThreads={sheet.threads}
          sheet={sheet}
          bottomInset={insets.bottom}
        />
      )}
    </View>
  );
}

function TaskTopBar(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space | null;
  readonly task: SpaceTask | null;
  readonly menu?: React.ReactNode;
}) {
  const navigation = useNavigation();
  return (
    <View className="min-h-14 flex-row items-center gap-1 border-b border-border-subtle px-2">
      <IconButton
        icon="chevron.left"
        accessibilityLabel="Back"
        onPress={() => navigation.goBack()}
      />
      {props.space === null ? (
        <View className="flex-1" />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${props.space.name}`}
          onPress={() =>
            navigation.dispatch(
              StackActions.push("SpaceRoom", {
                environmentId: props.environmentId,
                spaceId: props.space!.id,
              }),
            )
          }
          className="min-h-11 min-w-0 flex-1 flex-row items-center gap-1.5 active:opacity-70"
        >
          <SymbolView name="person.2" size={14} tintColorClassName="accent-icon-muted" />
          <Text numberOfLines={1} className="shrink text-sm text-foreground-muted">
            {props.space.name}
          </Text>
        </Pressable>
      )}
      {props.menu}
    </View>
  );
}

function TaskPage(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly task: SpaceTask;
  readonly view: SpaceTaskView;
  readonly liveThreads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly sheet: ReturnType<typeof useSheetSpace>;
  readonly bottomInset: number;
}) {
  const { environmentId, space, task } = props;
  const { viewer, canOperate } = props.sheet;
  const navigation = useNavigation();
  const { members } = useTeamRoster(environmentId);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const run = useAtomCommand(spaceEnvironment.task, { reportFailure: false });
  const setStatus = useAtomCommand(spaceEnvironment.setTaskStatus, { reportFailure: false });
  const [expanded, setExpanded] = useState(false);
  const threads =
    spaceThreadsByTask(mergeSpaceThreads(props.liveThreads, props.view.threads)).get(task.id) ??
    NO_THREADS;
  const controls = spaceTaskControls(task, space, viewer.memberId, canOperate);
  const status = spaceTaskStatusInfo(task.status);
  const notice = spaceTaskAssignmentNotice(task, threads.length, viewer);
  const merged = spaceMergedSuggestion(task, threads);
  const params = { environmentId, spaceId: space.id, taskId: task.id };
  const tasksById = new Map(props.sheet.tasks.map((candidate) => [candidate.id, candidate]));
  tasksById.set(task.id, task);
  const titles = new Map(threads.map((thread) => [thread.id, thread.title] as const));
  const entries = spaceTaskEntries(props.view.entries, props.sheet.room?.entries ?? [], task.id);
  const records = entries.filter(isSpaceTaskLineEntry);
  const assignedAt = spaceTaskAssignedAt(task, entries);
  const undo = useSpaceUndoNotice();
  const nameOf = (memberId: MemberId) => spaceMemberLabel(space, memberId, viewer);
  const avatar = (memberId: MemberId) => (
    <MemberAvatar
      size="sm"
      member={{
        name: viewer.nameOf(memberId),
        color: members.get(memberId)?.color ?? "#71717a",
      }}
    />
  );

  const act = async (input: Parameters<typeof run>[0]["input"], failure: string) => {
    const result = await run({ environmentId, input });
    return reportSpaceResult(failure, result);
  };
  const edit = () =>
    Dialog.prompt({
      title: "Edit title",
      initialValue: task.title,
      confirmText: "Next",
      onConfirm: (title) => {
        const nextTitle = title.trim();
        if (nextTitle === "") return;
        Dialog.prompt({
          title: "Edit description",
          initialValue: task.description,
          confirmText: "Save",
          onConfirm: (description) =>
            void act(
              {
                type: "edit",
                spaceId: space.id,
                taskId: task.id,
                ...(nextTitle === task.title ? {} : { title: nextTitle }),
                ...(description.trim() === task.description
                  ? {}
                  : { description: description.trim() }),
              },
              "Could not save",
            ),
        });
      },
    });
  const handBack = () =>
    Dialog.prompt({
      title: "Can't take it?",
      message: `It goes back to ${viewer.nameOf(task.assignedBy ?? task.createdBy)}, with your reason in the room.`,
      initialValue: "",
      confirmText: "Hand back",
      onConfirm: (reason) => {
        if (reason.trim() === "") return;
        void act(
          { type: "hand-back", spaceId: space.id, taskId: task.id, reason: reason.trim() },
          "Could not hand it back",
        );
      },
    });
  const reassign = (ownerId: MemberId) => {
    if (ownerId === task.ownerId) return;
    void act(
      { type: "reassign", spaceId: space.id, taskId: task.id, ownerId },
      "Could not reassign",
    );
  };
  const openStatus = () => navigation.dispatch(StackActions.push("SpaceTaskStatus", params));
  const startThread = () => navigation.dispatch(StackActions.push("SpaceStartThread", params));
  const attachThread = () =>
    navigation.dispatch(
      StackActions.push("SpaceAttachThread", { environmentId, spaceId: space.id, taskId: task.id }),
    );

  const others = orderSpaceMembers(space);
  const moreActions = [
    ...(controls.canReassign
      ? [
          {
            id: "reassign",
            title: "Reassign",
            subactions: others.map((member) => ({
              id: `owner:${member.memberId}`,
              title: nameOf(member.memberId),
              state: member.memberId === task.ownerId ? ("on" as const) : ("off" as const),
            })),
          },
        ]
      : []),
    ...(controls.canEdit ? [{ id: "edit", title: "Edit…" }] : []),
    ...(controls.canHandBack ? [{ id: "hand-back", title: "Can't take it…" }] : []),
    ...(controls.canRemind
      ? [{ id: "remind", title: `Remind ${viewer.nameOf(task.ownerId)}` }]
      : []),
    { id: "copy-link", title: "Copy link" },
    ...(controls.canCancel
      ? [{ id: "cancel", title: "Cancel task", attributes: { destructive: true } }]
      : []),
  ];
  const onMore = (id: string) => {
    if (id.startsWith("owner:")) return reassign(MemberId.make(id.slice("owner:".length)));
    switch (id) {
      case "edit":
        return edit();
      case "hand-back":
        return handBack();
      case "copy-link":
        return copyTextWithHaptic(hostedSpaceTaskLink(environmentId, space.id, task.id));
      case "remind":
        return void act(
          { type: "remind", spaceId: space.id, taskId: task.id },
          "Could not remind",
        ).then((reminded) => {
          if (reminded) showSpaceUndoNotice({ title: `Reminded ${viewer.nameOf(task.ownerId)}` });
        });
      case "cancel":
        return void setStatus({
          environmentId,
          input: { spaceId: space.id, taskId: task.id, status: "canceled" },
        }).then((result) => reportSpaceResult("Could not cancel", result));
    }
  };
  const addActions = [
    ...(controls.canStartThread ? [{ id: "start", title: "Start a thread" }] : []),
    ...(controls.canAttachThread ? [{ id: "attach", title: "Add existing thread" }] : []),
  ];

  return (
    <>
      <TaskTopBar
        environmentId={environmentId}
        space={space}
        task={task}
        menu={
          moreActions.length === 0 ? null : (
            <Menu
              accessible
              accessibilityRole="button"
              accessibilityLabel="More"
              actions={moreActions}
              onPressAction={({ nativeEvent }) => onMore(nativeEvent.event)}
            >
              <ControlPill icon="ellipsis" accessibilityLabel="More" />
            </Menu>
          )
        }
      />
      <ScrollView
        contentContainerClassName="gap-5 px-4 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(props.bottomInset, 16) + 16 }}
      >
        <Text selectable className="text-xl font-t3-bold text-foreground">
          {task.title}
        </Text>
        {notice === null ? null : (
          <View className="flex-row items-center gap-2 rounded-xl bg-subtle px-3 py-2">
            <SymbolView
              name={notice.type === "handed-back" ? "arrow.uturn.backward" : "person.crop.circle"}
              size={14}
              tintColorClassName="accent-icon-muted"
            />
            <Text className="min-w-0 flex-1 text-sm text-foreground">
              {notice.text}
              {notice.type === "waiting" && assignedAt !== null ? (
                <Text className="text-sm text-foreground-muted">
                  {" "}
                  · assigned {relativeTime(assignedAt)} ago
                </Text>
              ) : null}
              {notice.type === "waiting" && task.remindedAt !== null ? (
                <Text className="text-sm text-foreground-muted">
                  {" "}
                  · reminded {relativeTime(task.remindedAt)} ago
                </Text>
              ) : null}
            </Text>
          </View>
        )}
        <View className="gap-3">
          <View className="flex-row flex-wrap items-center gap-2">
            <ControlPill
              variant="pill"
              iconNode={
                <SpaceTaskStatusIcon
                  icon={status.icon}
                  tone={status.tone}
                  label={status.label}
                  size={14}
                />
              }
              label={status.label}
              accessibilityLabel={`Status, ${status.label}`}
              disabled={!controls.canSetStatus}
              onPress={openStatus}
            />
            {controls.canReassign ? (
              <Menu
                accessible
                accessibilityRole="button"
                accessibilityLabel={`Owner, ${nameOf(task.ownerId)}`}
                actions={others.map((member) => ({
                  id: member.memberId,
                  title: nameOf(member.memberId),
                  state: member.memberId === task.ownerId ? "on" : "off",
                }))}
                onPressAction={({ nativeEvent }) => reassign(MemberId.make(nativeEvent.event))}
              >
                <ControlPill
                  variant="pill"
                  iconNode={avatar(task.ownerId)}
                  label={nameOf(task.ownerId)}
                />
              </Menu>
            ) : (
              <ControlPill
                variant="pill"
                iconNode={avatar(task.ownerId)}
                label={nameOf(task.ownerId)}
                disabled
              />
            )}
          </View>
          {merged === null ? null : (
            <View className="flex-row items-center gap-2">
              <Text className="text-sm text-foreground-muted">{merged.text}</Text>
              {controls.canSetStatus ? (
                <Button
                  label={merged.action}
                  size="compact"
                  onPress={() =>
                    void setStatus({
                      environmentId,
                      input: { spaceId: space.id, taskId: task.id, status: merged.status },
                    }).then((result) => reportSpaceResult("Could not change the status", result))
                  }
                />
              ) : null}
            </View>
          )}
          <Text className="text-xs text-foreground-muted">
            Created by {task.createdBy === viewer.memberId ? "you" : viewer.nameOf(task.createdBy)}{" "}
            · {createdFormat.format(Date.parse(task.createdAt))}
          </Text>
        </View>
        {task.description === "" ? null : (
          <View className="gap-1">
            <Text
              selectable
              numberOfLines={expanded ? undefined : 4}
              className="text-base text-foreground"
            >
              {task.description}
            </Text>
            {expanded || task.description.length < 200 ? null : (
              <Button label="More" tone="text" size="compact" onPress={() => setExpanded(true)} />
            )}
          </View>
        )}
        <View className="gap-1">
          <View className="min-h-11 flex-row items-center gap-2">
            <Text className="text-sm font-t3-medium text-foreground">Threads</Text>
            <Text className="text-xs text-foreground-muted">{threads.length}</Text>
            <View className="flex-1" />
            {addActions.length === 0 ? null : (
              <Menu
                accessible
                accessibilityRole="button"
                accessibilityLabel="Add a thread"
                title="A thread runs on the Claude account of whoever starts it."
                actions={addActions}
                onPressAction={({ nativeEvent }) =>
                  nativeEvent.event === "start" ? startThread() : attachThread()
                }
              >
                <ControlPill icon="plus" label="Add" variant="pill" />
              </Menu>
            )}
          </View>
          {threads.map((thread) => (
            <TaskThreadRow
              key={thread.id}
              environmentId={environmentId}
              thread={thread}
              runsIn={spaceThreadRunsIn(thread, projects)}
              ownerName={thread.ownerId == null ? null : nameOf(thread.ownerId)}
              avatar={thread.ownerId == null ? null : avatar(thread.ownerId)}
              viewer={viewer}
            />
          ))}
          {controls.canStartThread ? (
            <Button label="Start a thread" icon="play" onPress={startThread} />
          ) : threads.length === 0 ? (
            <Text className="text-sm text-foreground-muted">No threads yet.</Text>
          ) : null}
        </View>
        {records.length === 0 ? null : (
          <View className="gap-1">
            <Text className="text-sm font-t3-medium text-foreground">Activity</Text>
            {records.map((entry) => (
              <SpaceRecordLine
                key={entry.id}
                environmentId={environmentId}
                space={space}
                entry={entry}
                entries={entries}
                tasksById={tasksById}
                viewer={viewer}
                onTask={task.id}
                threadTitle={(threadId) => titles.get(threadId) ?? null}
              />
            ))}
          </View>
        )}
      </ScrollView>
      {undo === null ? null : (
        <View
          className="absolute inset-x-0 px-3"
          style={{ bottom: Math.max(props.bottomInset, 8) }}
          pointerEvents="box-none"
        >
          <Toast message={undo.title} dismissMode="swipe" onDismiss={dismissSpaceUndoNotice} />
        </View>
      )}
    </>
  );
}

function TaskThreadRow(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: OrchestrationV2ThreadShell;
  readonly runsIn: string | null;
  readonly ownerName: string | null;
  readonly avatar: React.ReactNode;
  readonly viewer: ReturnType<typeof useSheetSpace>["viewer"];
}) {
  const navigation = useNavigation();
  const { thread } = props;
  const activity = spaceThreadActivityView(thread, props.viewer);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${thread.title}, ${activity.text}`}
      onPress={() =>
        navigation.dispatch(
          StackActions.push("Thread", { environmentId: props.environmentId, threadId: thread.id }),
        )
      }
      className="min-h-14 gap-1 border-t border-border-subtle py-2 active:opacity-70"
    >
      <View className="flex-row items-center gap-2">
        {activity.glyph === null ? (
          <SymbolView name="circle" size={12} tintColorClassName="accent-icon-muted" />
        ) : (
          <SpaceActivityGlyph glyph={activity.glyph} tone={activity.tone} />
        )}
        <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
          {thread.title}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {relativeTime(DateTime.formatIso(thread.updatedAt))}
        </Text>
      </View>
      <View className="flex-row items-center gap-1.5 ps-5">
        {props.avatar}
        {props.ownerName === null ? null : (
          <Text className="text-xs text-foreground-secondary">{props.ownerName}</Text>
        )}
        {props.runsIn === null ? null : (
          <>
            <SymbolView name="folder" size={11} tintColorClassName="accent-icon-muted" />
            <Text numberOfLines={1} className="shrink text-xs text-foreground-muted">
              {props.runsIn}
            </Text>
          </>
        )}
        <Text className="text-xs text-foreground-muted">·</Text>
        <Text numberOfLines={1} className={`shrink text-xs ${spaceToneTextClass(activity.tone)}`}>
          {activity.text}
        </Text>
      </View>
    </Pressable>
  );
}

/** The hosted app link, as a thread's Copy link builds it; the app opens it on the task screen. */
function hostedSpaceTaskLink(environmentId: string, spaceId: string, taskId: string): string {
  const path = [environmentId, spaceId, "tasks", taskId].map(encodeURIComponent).join("/");
  return new URL(`/spaces/${path}`, DEFAULT_HOSTED_APP_URL).toString();
}
