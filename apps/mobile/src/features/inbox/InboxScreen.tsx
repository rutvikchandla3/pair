import { useAtomValue } from "@effect/atom-react";
import { type StaticScreenProps, StackActions, useNavigation } from "@react-navigation/native";
import { inboxRowCopy } from "@t3tools/client-runtime/inbox";
import { snoozeWakeLabel } from "@t3tools/client-runtime/state/thread-settled";
import type { SpaceViewer } from "@t3tools/client-runtime/spaces";
import { EnvironmentId, type InboxItem } from "@t3tools/contracts";
import type { SnoozePresetSetting } from "@t3tools/contracts/settings";
import { useState } from "react";
import { FlatList, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { Toast } from "../../components/ui/Toast";
import { useNowMinuteMs } from "../../lib/clock";
import { relativeTime } from "../../lib/time";
import { appAtomRegistry } from "../../state/atom-registry";
import { inboxEnvironment, useInboxItems, useInboxSummary } from "../../state/inbox";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import { reportSpaceResult, useSpaceViewer } from "../../state/spaces";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadListActions } from "../home/useThreadListActions";
import { BotAvatar } from "../bots/BotAvatar";
import { resolveThreadListV2SnoozePresets } from "../threads/threadListV2";
import {
  dismissSpaceUndoNotice,
  showSpaceUndoNotice,
  useSpaceUndoNotice,
} from "../spaces/space-notices";
import {
  INBOX_REASON_SYMBOL,
  canMarkInboxItemDone,
  inboxItemSnooze,
  inboxItemTarget,
  inboxSections,
} from "./inboxModel";
import { PageTopBar } from "./PageTopBar";

type Params = { readonly environmentId: string };

type InboxListRow =
  | {
      readonly type: "header";
      readonly key: string;
      readonly label: string;
      readonly count: number;
    }
  | { readonly type: "item"; readonly key: string; readonly item: InboxItem };

const REASON_TINT: Partial<Record<InboxItem["reason"], string>> = {
  approval: "accent-warning-foreground",
  question: "accent-adaptive-indigo-600-300",
};

/** Everything waiting on the viewer, Needs you then For you (spec Part 1, Inbox). */
export function InboxScreen(props: StaticScreenProps<Params>) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const [showSnoozed, setShowSnoozed] = useState(false);
  const inbox = useInboxItems(environmentId, showSnoozed);
  const summary = useInboxSummary(environmentId);
  const snoozedCount = summary?.snoozed ?? 0;
  const viewer = useSpaceViewer(environmentId);
  const undo = useSpaceUndoNotice();
  const snoozePresets = useAtomValue(threadListEnvironmentsAtom).snoozePresetsByEnvironmentId.get(
    environmentId,
  );
  const dismiss = useAtomCommand(inboxEnvironment.dismiss, { reportFailure: false });
  const snoozeItem = useAtomCommand(inboxEnvironment.snooze, { reportFailure: false });
  const unsnoozeItem = useAtomCommand(inboxEnvironment.unsnooze, { reportFailure: false });
  const { snoozeThread } = useThreadListActions();
  const nowMs = useNowMinuteMs();

  const needsYou = summary?.needsYou ?? inbox.items.filter((i) => i.group === "needs-you").length;
  const rows = showSnoozed
    ? inbox.items.map((item): InboxListRow => ({ type: "item", key: item.id, item }))
    : inboxSections(inbox.items).flatMap((section): InboxListRow[] => [
        {
          type: "header",
          key: `header:${section.group}`,
          label: section.label,
          count: section.group === "needs-you" ? needsYou : section.items.length,
        },
        ...section.items.map((item) => ({ type: "item" as const, key: item.id, item })),
      ]);

  const open = (item: InboxItem) => {
    const target = inboxItemTarget(item);
    if (target === null) return;
    switch (target.type) {
      case "request":
        navigation.dispatch(
          StackActions.push("InboxRequest", { environmentId, threadId: target.threadId }),
        );
        return;
      case "thread":
        navigation.dispatch(
          StackActions.push("Thread", { environmentId, threadId: target.threadId }),
        );
        return;
      case "task":
        navigation.dispatch(
          StackActions.push("SpaceTask", {
            environmentId,
            spaceId: target.spaceId,
            taskId: target.taskId,
          }),
        );
        return;
      case "room":
        navigation.dispatch(
          StackActions.push("SpaceRoom", { environmentId, spaceId: target.spaceId }),
        );
        return;
      case "bot":
        navigation.dispatch(
          StackActions.push("BotHome", {
            environmentId: String(environmentId),
            botId: target.botId,
          }),
        );
        return;
    }
  };
  const openThread = (item: InboxItem) => {
    if (item.threadId === undefined) return;
    navigation.dispatch(StackActions.push("Thread", { environmentId, threadId: item.threadId }));
  };
  const markDone = async (item: InboxItem) => {
    reportSpaceResult(
      "Could not mark done",
      await dismiss({ environmentId, input: { itemId: item.id } }),
    );
  };
  const unsnooze = async (item: InboxItem) => {
    reportSpaceResult(
      "Could not unsnooze",
      await unsnoozeItem({ environmentId, input: { itemId: item.id } }),
    );
  };
  const snooze = async (item: InboxItem, until: string) => {
    const kind = inboxItemSnooze(item);
    if (kind === null) return;
    if (kind.type === "thread") {
      const thread = appAtomRegistry.get(
        environmentThreadShells.threadShellAtom({ environmentId, threadId: kind.threadId }),
      );
      if (thread === null) {
        Dialog.alert("Could not snooze thread", "This thread isn't available on this device.");
        return;
      }
      await snoozeThread(thread, until);
      return;
    }
    const result = await snoozeItem({ environmentId, input: { itemId: item.id, until } });
    if (!reportSpaceResult("Could not snooze", result)) return;
    showSpaceUndoNotice({
      title: "Snoozed",
      action: {
        label: "Undo",
        run: () =>
          void unsnoozeItem({ environmentId, input: { itemId: item.id } }).then((undone) =>
            reportSpaceResult("Could not undo snooze", undone),
          ),
      },
    });
  };

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
      <PageTopBar
        title="Inbox"
        trailing={
          <>
            {needsYou > 0 && !showSnoozed ? (
              <Text className="text-sm text-foreground-muted">{needsYou} need you</Text>
            ) : null}
            {showSnoozed || snoozedCount > 0 ? (
              <Chip
                size="small"
                icon="clock"
                label={`Snoozed ${snoozedCount}`}
                selected={showSnoozed}
                accessibilityLabel={showSnoozed ? "Show the Inbox" : "Show snoozed tasks"}
                onPress={() => setShowSnoozed(!showSnoozed)}
              />
            ) : null}
          </>
        }
      />
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24, flexGrow: 1 }}
        renderItem={({ item: row }) =>
          row.type === "header" ? (
            <View className="flex-row items-center gap-2 px-4 pt-4 pb-1">
              <Text className="text-xs font-t3-medium uppercase tracking-wide text-foreground-muted">
                {row.label}
              </Text>
              <Text className="text-xs tabular-nums text-foreground-muted">{row.count}</Text>
            </View>
          ) : showSnoozed ? (
            <SnoozedRow
              item={row.item}
              viewer={viewer}
              nowMs={nowMs}
              onOpen={() => open(row.item)}
              onUnsnooze={() => void unsnooze(row.item)}
            />
          ) : (
            <InboxRow
              item={row.item}
              viewer={viewer}
              snoozePresets={snoozePresets}
              nowMs={nowMs}
              onOpen={() => open(row.item)}
              onOpenThread={() => openThread(row.item)}
              onDone={() => void markDone(row.item)}
              onSnooze={(until) => void snooze(row.item, until)}
            />
          )
        }
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center p-8">
            {inbox.loaded ? (
              <Text className="text-center text-sm text-foreground-muted">
                {showSnoozed ? "Nothing snoozed." : "Nothing needs you."}
              </Text>
            ) : inbox.error !== null ? (
              <Text className="text-center text-sm text-foreground-muted">{inbox.error}</Text>
            ) : (
              <AppActivityIndicator colorClassName="accent-icon-muted" />
            )}
          </View>
        }
      />
      {undo === null ? null : (
        <View
          className="absolute inset-x-0 px-3"
          style={{ bottom: Math.max(insets.bottom, 8) }}
          pointerEvents="box-none"
        >
          <Toast
            message={undo.title}
            dismissMode="swipe"
            onDismiss={dismissSpaceUndoNotice}
            {...(undo.action === undefined
              ? {}
              : {
                  action: {
                    label: undo.action.label,
                    onPress: () => {
                      dismissSpaceUndoNotice();
                      undo.action?.run();
                    },
                  },
                })}
          />
        </View>
      )}
    </View>
  );
}

/** The bot's avatar when the item carries one; the reason's glyph otherwise. */
function InboxRowIcon(props: { readonly item: InboxItem }) {
  const { item } = props;
  if (item.botColor !== undefined) {
    return <BotAvatar bot={{ color: item.botColor, shape: item.botShape ?? "round" }} size={16} />;
  }
  return (
    <SymbolView
      name={INBOX_REASON_SYMBOL[item.reason]}
      size={16}
      tintColorClassName={REASON_TINT[item.reason] ?? "accent-icon-muted"}
    />
  );
}

/** A task item snoozed until later: when it wakes, and Unsnooze. */
function SnoozedRow(props: {
  readonly item: InboxItem;
  readonly viewer: SpaceViewer;
  readonly nowMs: number;
  readonly onOpen: () => void;
  readonly onUnsnooze: () => void;
}) {
  const { item } = props;
  const copy = inboxRowCopy(item, props.viewer);
  const wakes =
    item.snoozedUntil === undefined
      ? null
      : `Wakes in ${snoozeWakeLabel(item.snoozedUntil, { now: new Date(props.nowMs).toISOString() })}`;
  const detail = [copy.detail, wakes].filter((part) => part !== null && part !== "").join(" · ");
  return (
    <View className="min-h-14 flex-row items-center gap-3 border-b border-border-subtle px-4 py-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[copy.title, detail].filter((part) => part !== "").join(", ")}
        disabled={inboxItemTarget(item) === null}
        onPress={props.onOpen}
        className="min-w-0 flex-1 flex-row gap-3 active:opacity-70"
      >
        <View className="pt-0.5">
          <InboxRowIcon item={item} />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={2} className="text-base font-t3-medium text-foreground">
            {copy.title}
          </Text>
          {detail === "" ? null : (
            <Text numberOfLines={1} className="text-sm text-foreground-muted">
              {detail}
            </Text>
          )}
        </View>
      </Pressable>
      <Button label="Unsnooze" tone="secondary" size="compact" onPress={props.onUnsnooze} />
    </View>
  );
}

function InboxRow(props: {
  readonly item: InboxItem;
  readonly viewer: SpaceViewer;
  readonly snoozePresets: ReadonlyArray<SnoozePresetSetting> | undefined;
  /** The minute the snooze menu's times are read at. */
  readonly nowMs: number;
  readonly onOpen: () => void;
  readonly onOpenThread: () => void;
  readonly onDone: () => void;
  readonly onSnooze: (until: string) => void;
}) {
  const { item } = props;
  const copy = inboxRowCopy(item, props.viewer);
  const target = inboxItemTarget(item);
  const snoozeKind = inboxItemSnooze(item);
  const canDone = canMarkInboxItemDone(item);
  const quote =
    (item.reason === "mention" || item.reason === "pair-reply") && item.excerpt !== undefined
      ? `“${item.excerpt}”`
      : null;
  const presets = resolveThreadListV2SnoozePresets({
    secondary: snoozeKind === null ? null : "snooze",
    now: new Date(props.nowMs).toISOString(),
    presets: props.snoozePresets,
  });
  const actions = [
    ...(target?.type === "request"
      ? [{ id: "open-thread", title: "Open thread", image: "arrow.up.right" }]
      : []),
    ...(canDone ? [{ id: "done", title: "Done", image: "checkmark" }] : []),
    ...(presets.length > 0
      ? [
          {
            id: "snooze",
            title: snoozeKind?.type === "task" ? "Snooze" : "Snooze thread",
            image: "clock",
            subactions: presets.map((preset) => ({
              id: `snooze:${preset.id}`,
              title: preset.label,
              subtitle: preset.whenLabel,
            })),
          },
        ]
      : []),
  ];
  const row = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[copy.title, copy.detail, relativeTime(item.at)]
        .filter((part) => part !== "")
        .join(", ")}
      accessibilityHint={actions.length > 0 ? "Long-press for more actions" : undefined}
      disabled={target === null}
      onPress={props.onOpen}
      className="min-h-14 flex-row gap-3 border-b border-border-subtle px-4 py-3 active:opacity-70"
    >
      <View className="pt-0.5">
        <InboxRowIcon item={item} />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={2} className="text-base font-t3-medium text-foreground">
          {copy.title}
        </Text>
        {copy.detail === "" ? null : (
          <Text numberOfLines={1} className="text-sm text-foreground-muted">
            {copy.detail}
          </Text>
        )}
        {quote === null ? null : (
          <Text numberOfLines={2} className="text-sm text-foreground-secondary">
            {quote}
          </Text>
        )}
      </View>
      <Text className="text-xs tabular-nums text-foreground-muted">{relativeTime(item.at)}</Text>
    </Pressable>
  );
  if (actions.length === 0) return row;
  return (
    <Menu
      shouldOpenOnLongPress
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        const event = nativeEvent.event;
        if (event === "open-thread") props.onOpenThread();
        else if (event === "done") props.onDone();
        else if (event.startsWith("snooze:")) {
          const preset = presets.find((candidate) => `snooze:${candidate.id}` === event);
          if (preset !== undefined) props.onSnooze(preset.snoozedUntil);
        }
      }}
    >
      {row}
    </Menu>
  );
}
