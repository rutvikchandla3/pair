import { useAtomMount, useAtomRefresh } from "@effect/atom-react";
import {
  type StaticScreenProps,
  StackActions,
  useIsFocused,
  useNavigation,
} from "@react-navigation/native";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type SpaceFeedRow,
  type SpaceRoomMemberState,
  type SpaceRoomState,
  type SpaceViewer,
  joinedSpaceOlderEntries,
  orderSpaceMembers,
  prependSpaceEntries,
  spaceControls,
  spaceFeedRows,
  spaceNewDividerIndex,
  spaceSystemLineText,
  spaceTaskStatus,
  spaceTasksNeedingViewer,
  splitSpacePostText,
} from "@t3tools/client-runtime/spaces";
import { createThreadVisitTracker } from "@t3tools/client-runtime/state/thread-visits";
import {
  EnvironmentId,
  type Space,
  SpaceId,
  type SpaceRoomEntry,
  type ThreadId,
} from "@t3tools/contracts";
import { type ReactNode, useState } from "react";
import { FlatList, Pressable, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { MemberAvatar } from "../../components/MemberAvatar";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { Toast } from "../../components/ui/Toast";
import { cn } from "../../lib/cn";
import { useProject, useThreadShell } from "../../state/entities";
import {
  reportSpaceResult,
  spaceEnvironment,
  useCanOperateSpaces,
  useSpaceOlderEntries,
  useSpaceRoom,
  useSpaceTasks,
  useSpaceViewer,
} from "../../state/spaces";
import { useTeamRoster } from "../../state/team";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { type SpacePost, SpaceComposer } from "./SpaceComposer";
import {
  dismissSpaceUndoNotice,
  markSpaceLeft,
  useSpaceLeft,
  useSpaceUndoNotice,
} from "./space-notices";
import { SpaceStatusIcon } from "./SpaceStatusIcon";

type Params = { readonly environmentId: string; readonly spaceId: string };

const roomVisitTracker = createThreadVisitTracker({
  threadShellAtom: environmentThreadShells.threadShellAtom,
  visit: threadEnvironment.visit,
});

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const formatTime = (iso: string) => timeFormat.format(Date.parse(iso));

export function SpaceRoomScreen(props: StaticScreenProps<Params>) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const spaceId = SpaceId.make(props.route.params.spaceId);
  const result = useSpaceRoom(environmentId, spaceId);
  const viewer = useSpaceViewer(environmentId);
  const insets = useSafeAreaInsets();

  if (result.type === "ready" && result.room.type === "member") {
    return (
      <SpaceRoom
        // A different space starts with fresh drafts, quotes and New divider.
        key={`${environmentId}:${spaceId}`}
        environmentId={environmentId}
        room={result.room}
        viewer={viewer}
      />
    );
  }
  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
      <RoomHeader
        title={result.type === "ready" && result.room.type === "not_member" ? result.room.name : ""}
        subtitle={null}
        members={null}
      />
      {result.type === "loading" ? (
        <View className="flex-1 items-center justify-center">
          <AppActivityIndicator colorClassName="accent-icon-muted" />
        </View>
      ) : result.type === "error" ? (
        <Text className="p-6 text-sm text-foreground-muted">{result.message}</Text>
      ) : result.room.type === "not_member" ? (
        <SpaceNotMember environmentId={environmentId} room={result.room} viewer={viewer} />
      ) : null}
    </View>
  );
}

function RoomHeader(props: {
  readonly title: string;
  readonly subtitle: string | null;
  readonly members: ReactNode;
  readonly trailing?: ReactNode;
}) {
  const navigation = useNavigation();
  return (
    <View className="min-h-14 flex-row items-center gap-1 border-b border-border-subtle px-2">
      <IconButton
        icon="chevron.left"
        accessibilityLabel="Back"
        onPress={() => navigation.goBack()}
      />
      <View className="min-w-0 flex-1 py-1.5">
        <Text numberOfLines={1} className="text-base font-t3-bold text-foreground">
          {props.title}
        </Text>
        {props.members === null && props.subtitle === null ? null : (
          <View className="flex-row items-center gap-1.5">
            {props.members}
            {props.subtitle === null ? null : (
              <Text numberOfLines={1} className="min-w-0 shrink text-xs text-foreground-muted">
                {props.subtitle}
              </Text>
            )}
          </View>
        )}
      </View>
      {props.trailing}
    </View>
  );
}

function SpaceNotMember(props: {
  readonly environmentId: EnvironmentId;
  readonly room: Extract<SpaceRoomState, { type: "not_member" }>;
  readonly viewer: SpaceViewer;
}) {
  const navigation = useNavigation();
  const mutate = useAtomCommand(spaceEnvironment.mutate, { reportFailure: false });
  // Not a member: no room stream to bring the change, so ask for the page again.
  const refreshRoom = useAtomRefresh(
    spaceEnvironment.room({
      environmentId: props.environmentId,
      input: { spaceId: props.room.spaceId },
    }),
  );
  const left = useSpaceLeft(props.environmentId, props.room.spaceId);
  const [busy, setBusy] = useState(false);
  const owner = props.viewer.nameOf(props.room.ownerId);
  const act = async (type: "join.request" | "join.cancel") => {
    setBusy(true);
    const result = await mutate({
      environmentId: props.environmentId,
      input: { type, spaceId: props.room.spaceId },
    });
    setBusy(false);
    refreshRoom();
    if (
      reportSpaceResult(
        type === "join.request" ? "Could not ask to join" : "Could not cancel",
        result,
      )
    ) {
      if (type === "join.request") markSpaceLeft(props.environmentId, props.room.spaceId, false);
    }
  };
  const count = props.room.memberCount;
  return (
    <View className="flex-1 items-center justify-center gap-3 px-8">
      <SymbolView name="person.2" size={28} tintColorClassName="accent-icon-muted" />
      <Text className="text-center text-lg font-t3-bold text-foreground">
        {left && !props.room.requested
          ? `You left ${props.room.name}`
          : `You're not in ${props.room.name}`}
      </Text>
      <Text className="text-center text-sm text-foreground-muted">
        {props.room.archived
          ? `This space is archived. Ask ${owner} if you need what's in it.`
          : props.room.requested
            ? `Request sent · ${owner} was notified.`
            : `Its ${count} ${count === 1 ? "member" : "members"} can see its tasks and chat.`}
      </Text>
      {props.room.archived ? null : props.room.requested ? (
        <Button label="Cancel request" disabled={busy} onPress={() => void act("join.cancel")} />
      ) : (
        <Button
          label={left ? `Ask ${owner} to add you back` : `Ask ${owner} to add you`}
          tone="primary"
          disabled={busy}
          onPress={() => void act("join.request")}
        />
      )}
      <Button label="Back to Pair" tone="text" onPress={() => navigation.goBack()} />
    </View>
  );
}

type RoomMenuAction = "new-task" | "settings" | "archive" | "unarchive" | "leave";

function SpaceRoom(props: {
  readonly environmentId: EnvironmentId;
  readonly room: SpaceRoomMemberState;
  readonly viewer: SpaceViewer;
}) {
  const { environmentId, room, viewer } = props;
  const space = room.space;
  const navigation = useNavigation();
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { members } = useTeamRoster(environmentId);
  const canOperate = useCanOperateSpaces(environmentId);
  const controls = spaceControls(space, viewer.memberId, canOperate);
  const tasks = useSpaceTasks(environmentId, space.id, room.tasks);
  const older = joinedSpaceOlderEntries(
    useSpaceOlderEntries(environmentId, space.id),
    room.entries,
  );
  const project = useProject(scopeProjectRef(environmentId, space.projectId));
  const roomRef = scopeThreadRef(environmentId, space.roomThreadId);
  const roomShell = useThreadShell(roomRef);
  useAtomMount(roomVisitTracker(roomRef));
  const loadOlder = useAtomCommand(spaceEnvironment.loadOlder, { reportFailure: false });
  const mutate = useAtomCommand(spaceEnvironment.mutate, { reportFailure: false });
  const undo = useSpaceUndoNotice();

  // Read once: the visit tracker moves the watermark while the room is open.
  const [visitedAt] = useState(() => roomShell?.lastVisitedAt ?? null);
  const [quote, setQuote] = useState<SpacePost | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const entries = older === null ? room.entries : prependSpaceEntries(older.entries, room.entries);
  const hasOlder = older === null ? room.hasMoreEntries : older.hasMore;
  const newIndex = spaceNewDividerIndex(entries, visitedAt, viewer.memberId);
  const rows = [...spaceFeedRows(entries, [], newIndex)].reverse();
  const tasksById = new Map(tasks.map((task) => [task.id, task] as const));
  const needsYou = spaceTasksNeedingViewer(tasks, viewer).length;
  const ordered = orderSpaceMembers(space);
  const hasRequests = controls.isOwner && space.joinRequests.length > 0;
  const params = { environmentId, spaceId: space.id };

  const onLoadOlder = async () => {
    const first = entries[0];
    if (first === undefined || loadingOlder) return;
    setLoadingOlder(true);
    const result = await loadOlder({
      environmentId,
      input: { spaceId: space.id, before: first.id },
    });
    setLoadingOlder(false);
    reportSpaceResult("Could not load earlier messages", result);
  };
  const unarchive = async () => {
    const result = await mutate({ environmentId, input: { type: "unarchive", spaceId: space.id } });
    reportSpaceResult("Could not unarchive", result);
  };
  const openTask = (threadId: ThreadId) =>
    navigation.dispatch(StackActions.push("Thread", { environmentId, threadId }));

  const menuActions = [
    ...(controls.canCreateTask ? [{ id: "new-task", title: "New task" }] : []),
    { id: "settings", title: "Space settings" },
    ...(controls.canArchive ? [{ id: "archive", title: "Archive space" }] : []),
    ...(controls.canUnarchive ? [{ id: "unarchive", title: "Unarchive" }] : []),
    ...(controls.canLeave
      ? [{ id: "leave", title: "Leave space", attributes: { destructive: true } }]
      : []),
  ];
  const onMenu = (action: RoomMenuAction) => {
    switch (action) {
      case "new-task":
        return navigation.navigate("SpaceNewTask", params);
      case "settings":
        return navigation.navigate("SpaceSettings", params);
      case "archive":
      case "leave":
        return navigation.navigate("SpaceConfirm", { ...params, action });
      case "unarchive":
        return void unarchive();
    }
  };

  const renderTaskChip = (threadId: ThreadId) => {
    const task = tasksById.get(threadId);
    const status = task === undefined ? null : spaceTaskStatus(task, viewer);
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${task?.title ?? "task"}`}
        onPress={() => openTask(threadId)}
        className="min-h-11 flex-row items-center gap-1.5 self-start active:opacity-70"
      >
        {status === null ? null : (
          <SpaceStatusIcon icon={status.icon} tone={status.tone} label={status.label} />
        )}
        <Text numberOfLines={1} className="shrink text-sm font-t3-medium text-foreground">
          {task?.title ?? "Task"}
        </Text>
        {status === null ? null : (
          <Text className="text-xs text-foreground-muted">{status.label}</Text>
        )}
      </Pressable>
    );
  };

  const renderEntry = (entry: SpaceRoomEntry, continued: boolean) => {
    if (entry.type === "system") {
      const line = entry.line;
      const actor = entry.actorId === viewer.memberId ? "You" : viewer.nameOf(entry.actorId);
      return (
        <View className="gap-0.5 py-1 pr-4 pl-[60px]">
          <Text className="text-xs text-foreground-muted">
            <Text className="text-xs font-t3-medium text-foreground-secondary">{actor}</Text>{" "}
            {spaceSystemLineText(line, viewer)}
            {line.type === "task-handed-back" ? ` “${line.reason}”` : ""} ·{" "}
            {formatTime(entry.createdAt)}
          </Text>
          {line.type === "task-created" || line.type === "task-handed-back"
            ? renderTaskChip(line.threadId)
            : null}
        </View>
      );
    }
    const author = members.get(entry.authorId);
    const name = viewer.nameOf(entry.authorId);
    const segments = splitSpacePostText(entry.text, entry.mentions, viewer.nameOf);
    const body = (
      <View className={cn("flex-row gap-3 px-4", continued ? "py-0.5" : "pt-3 pb-0.5")}>
        <View className="w-8 items-center">
          {continued ? null : (
            <MemberAvatar member={{ name, color: author?.color ?? "#71717a" }} size="md" />
          )}
        </View>
        <View className="min-w-0 flex-1">
          {continued ? null : (
            <View className="flex-row items-baseline gap-2">
              <Text className="text-base font-t3-bold text-foreground">{name}</Text>
              {entry.authorKind === "agent" ? (
                <Text className="text-xs text-foreground-muted">agent</Text>
              ) : null}
              <Text className="text-xs text-foreground-muted">{formatTime(entry.createdAt)}</Text>
            </View>
          )}
          {entry.quote === undefined ? null : (
            <Text numberOfLines={1} className="text-xs text-foreground-muted">
              ↳{" "}
              <Text className="text-xs font-t3-medium text-foreground-secondary">
                {viewer.nameOf(entry.quote.authorId)}
              </Text>{" "}
              {entry.quote.text}
            </Text>
          )}
          <Text selectable className="text-base text-foreground">
            {segments.map((segment, index) =>
              segment.type === "text" ? (
                segment.text
              ) : (
                <Text
                  // oxlint-disable-next-line react/no-array-index-key -- segments have no identity
                  key={index}
                  className="text-base font-t3-medium text-primary-text"
                >
                  {segment.text}
                </Text>
              ),
            )}
          </Text>
        </View>
      </View>
    );
    if (!controls.canPost) return body;
    return (
      <Menu
        actions={[{ id: "quote", title: "Quote reply" }]}
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event === "quote") setQuote(entry);
        }}
        shouldOpenOnLongPress
      >
        {body}
      </Menu>
    );
  };

  const renderRow = ({ item }: { item: SpaceFeedRow }) => {
    switch (item.type) {
      case "day":
        return (
          <View className="flex-row items-center gap-3 px-4 pt-4 pb-1">
            <View className="h-px flex-1 bg-border-subtle" />
            <Text className="text-xs text-foreground-muted">{item.label}</Text>
            <View className="h-px flex-1 bg-border-subtle" />
          </View>
        );
      case "new":
        return (
          <View className="flex-row items-center gap-3 px-4 py-2">
            <View className="h-px flex-1 bg-primary" />
            <Text className="text-xs font-t3-medium text-primary-text">New</Text>
          </View>
        );
      case "pair":
        return null;
      case "entry":
        return renderEntry(item.entry, item.continued);
    }
  };

  const avatars = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hasRequests ? "Members, a request is waiting" : "Members"}
      onPress={() => navigation.navigate("SpaceMembers", params)}
      hitSlop={10}
      className="flex-row items-center"
    >
      {ordered.slice(0, 4).map((member, index) => {
        const teamMember = members.get(member.memberId);
        return (
          <View key={member.memberId} style={index === 0 ? undefined : { marginLeft: -5 }}>
            <MemberAvatar
              member={{
                name: viewer.nameOf(member.memberId),
                color: teamMember?.color ?? "#71717a",
              }}
              size="sm"
            />
          </View>
        );
      })}
      {hasRequests ? <View className="ml-0.5 size-2 self-start rounded-full bg-danger" /> : null}
    </Pressable>
  );

  return (
    <KeyboardAvoidingView
      behavior="padding"
      className="flex-1 bg-screen"
      style={{ paddingTop: insets.top }}
    >
      <RoomHeader
        title={space.name}
        subtitle={project?.title ?? null}
        members={avatars}
        trailing={
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={needsYou > 0 ? `Tasks, ${needsYou} need you` : "Tasks"}
              onPress={() => navigation.navigate("SpaceTasks", params)}
              className="min-h-11 flex-row items-center gap-1.5 rounded-full border border-border-subtle px-3 active:opacity-70"
            >
              <Text className="text-sm font-t3-medium text-foreground">Tasks</Text>
              {needsYou > 0 ? (
                <View className="min-w-5 items-center rounded-full bg-warning px-1.5">
                  <Text className="text-xs font-t3-bold text-warning-foreground">{needsYou}</Text>
                </View>
              ) : null}
            </Pressable>
            <Menu
              actions={menuActions}
              onPressAction={({ nativeEvent }) => onMenu(nativeEvent.event as RoomMenuAction)}
            >
              <IconButton icon="ellipsis" accessibilityLabel="Space actions" />
            </Menu>
          </>
        }
      />
      <FlatList
        inverted
        data={rows}
        keyExtractor={(row) => row.key}
        renderItem={renderRow}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        onEndReached={hasOlder ? () => void onLoadOlder() : undefined}
        onEndReachedThreshold={0.3}
        ListFooterComponent={
          hasOlder ? (
            <View className="items-center py-3">
              <Button
                label={loadingOlder ? "Loading…" : "Load earlier messages"}
                tone="text"
                size="compact"
                disabled={loadingOlder}
                onPress={() => void onLoadOlder()}
              />
            </View>
          ) : undefined
        }
        contentContainerClassName="pb-3"
      />
      {undo === null ? null : (
        <View className="px-3 pb-2" pointerEvents="box-none">
          <Toast
            message={undo.title}
            action={{
              label: undo.label,
              onPress: () => {
                dismissSpaceUndoNotice();
                undo.undo();
              },
            }}
            dismissMode="swipe"
            onDismiss={dismissSpaceUndoNotice}
          />
        </View>
      )}
      {/* A sheet over the room hides the composer, so its keyboard never sits under the sheet. */}
      {!focused ? null : controls.archived ? (
        <ArchivedBar
          space={space}
          viewer={viewer}
          canUnarchive={controls.canUnarchive}
          bottomInset={insets.bottom}
          onUnarchive={() => void unarchive()}
        />
      ) : controls.canPost ? (
        <SpaceComposer
          environmentId={environmentId}
          space={space}
          viewer={viewer}
          quote={quote}
          onQuoteChange={setQuote}
          bottomInset={insets.bottom}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

function ArchivedBar(props: {
  readonly space: Space;
  readonly viewer: SpaceViewer;
  readonly canUnarchive: boolean;
  readonly bottomInset: number;
  readonly onUnarchive: () => void;
}) {
  const by = props.space.archivedBy;
  const name = by === null ? null : by === props.viewer.memberId ? "you" : props.viewer.nameOf(by);
  return (
    <View
      className="min-h-14 flex-row items-center justify-center gap-3 border-t border-border-subtle px-4 pt-2"
      style={{ paddingBottom: Math.max(props.bottomInset, 8) }}
    >
      <SymbolView name="archivebox" size={16} tintColorClassName="accent-icon-muted" />
      <Text className="shrink text-sm text-foreground-muted">
        Archived{name === null ? "" : ` by ${name}`} · read-only
      </Text>
      {props.canUnarchive ? (
        <Button label="Unarchive" size="compact" onPress={props.onUnarchive} />
      ) : null}
    </View>
  );
}
