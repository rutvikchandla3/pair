import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import { type SidebarSpaceRow, sidebarSpaceRows } from "@t3tools/client-runtime/inbox";
import { isSpaceOwner } from "@t3tools/client-runtime/spaces";
import type { EnvironmentId, SpaceId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { type AppSymbolName, SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { useInboxSummary } from "../../state/inbox";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import {
  reportSpaceResult,
  spaceEnvironment,
  useCanOperateSpaces,
  useSpaceEnvironmentIds,
  useSpaceList,
  useSpaceSidebarShells,
  useSpaceViewer,
} from "../../state/spaces";
import { useIsTeamMode } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { Preferences as MobilePreferences } from "../../persistence/mobile-preferences";
import {
  homeMoreLabel,
  homeTeamItems,
  moveSpaceInOrder,
  rememberSpaceOrder,
} from "./homeSpaceRows";
import { SpaceMark } from "./SpaceMark";

const ROW = "min-h-11 flex-row items-center gap-3 px-4 active:opacity-70";
const NO_ORDER: ReadonlyArray<SpaceId> = [];

const PLACES = {
  inbox: { label: "Inbox", icon: "tray", route: "Inbox" },
  "my-tasks": { label: "My tasks", icon: "checklist", route: "MyTasks" },
  "shared-with-you": {
    label: "Shared with you",
    icon: "square.and.arrow.up",
    route: "SharedWithYou",
  },
} as const satisfies Record<
  string,
  { label: string; icon: AppSymbolName; route: "Inbox" | "MyTasks" | "SharedWithYou" }
>;

/** Inbox, My tasks, Shared with you and Spaces above the thread list, per environment with spaces. */
export function HomeSpacesSection() {
  const environmentIds = useSpaceEnvironmentIds();
  return (
    <>
      {environmentIds.map((environmentId) => (
        <HomeTeamForEnvironment key={environmentId} environmentId={environmentId} />
      ))}
    </>
  );
}

/** A preferences update that rewrites one environment's space order, or nothing. */
function spaceOrderUpdate(
  environmentId: EnvironmentId,
  next: (stored: ReadonlyArray<string>) => ReadonlyArray<string>,
) {
  return {
    transform: (current: MobilePreferences) => {
      const stored = current.spaceOrders?.[environmentId] ?? NO_ORDER;
      const nextOrder = next(stored);
      return nextOrder === stored
        ? {}
        : { spaceOrders: { ...current.spaceOrders, [environmentId]: nextOrder } };
    },
  };
}

function HomeTeamForEnvironment(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const navigation = useNavigation();
  const { spaces } = useSpaceList(environmentId);
  const shells = useSpaceSidebarShells(environmentId);
  const viewer = useSpaceViewer(environmentId);
  const canOperate = useCanOperateSpaces(environmentId);
  const teamMode = useIsTeamMode(environmentId);
  const summary = useInboxSummary(environmentId);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const registry = useContext(RegistryContext);
  const [expanded, setExpanded] = useState(false);
  const orderLoaded = AsyncResult.isSuccess(preferences);
  // Stored ids are only ever ranked against live spaces, so a stale one is harmless.
  const order = orderLoaded
    ? ((preferences.value.spaceOrders?.[environmentId] as ReadonlyArray<SpaceId> | undefined) ??
      NO_ORDER)
    : NO_ORDER;
  const unreadRoomIds = shells.unreadRoomIds;
  const viewerId = viewer.memberId;
  const items = homeTeamItems({
    spaces,
    order,
    summary,
    unreadRoomIds,
    viewerId,
    teamMode,
    expanded,
  });
  const rows = sidebarSpaceRows(spaces, order, summary, unreadRoomIds, viewerId);
  // The full active order, hidden spaces included.
  const shown = [...rows.visible, ...rows.hidden].map((row) => row.space.id);
  const shownKey = shown.join(",");
  const unremembered = orderLoaded && rememberSpaceOrder(order, shown) !== order;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists the order the user has seen, so a space they're added to later stays on top
  useEffect(() => {
    if (!unremembered) return;
    const ids = shownKey.split(",");
    void runAtomCommand(
      registry,
      saveMobilePreferences,
      spaceOrderUpdate(environmentId, (stored) => rememberSpaceOrder(stored, ids)),
      { reportFailure: false },
    );
  }, [unremembered, shownKey, environmentId, registry]);
  const move = (spaceId: string, delta: -1 | 1) =>
    void runAtomCommand(
      registry,
      saveMobilePreferences,
      spaceOrderUpdate(environmentId, (stored) => moveSpaceInOrder(stored, shown, spaceId, delta)),
      { reportFailure: false },
    );

  return (
    <View className="pb-2">
      {items.map((item) => {
        switch (item.type) {
          case "place":
            return (
              <PlaceRow
                key={item.key}
                place={item.key}
                count={item.count}
                onPress={() =>
                  navigation.dispatch(StackActions.push(PLACES[item.key].route, { environmentId }))
                }
              />
            );
          case "spaces-header":
            return (
              <View key="spaces-header" className="mt-2 flex-row items-center pe-2">
                <Text className="flex-1 px-4 py-2 text-xs font-t3-medium uppercase tracking-wide text-foreground-muted">
                  Spaces
                </Text>
                {canOperate ? (
                  <IconButton
                    icon="plus"
                    accessibilityLabel="New space"
                    onPress={() =>
                      navigation.dispatch(StackActions.push("SpaceNew", { environmentId }))
                    }
                  />
                ) : null}
              </View>
            );
          case "spaces-empty":
            return (
              <Text key="spaces-empty" className="px-4 pb-2 text-sm text-foreground-muted">
                Rooms where your team and Pair work together.
              </Text>
            );
          case "space": {
            const index = shown.indexOf(item.row.space.id);
            return (
              <SpaceRow
                key={item.row.space.id}
                environmentId={environmentId}
                row={item.row}
                canMoveUp={index > 0}
                canMoveDown={index >= 0 && index < shown.length - 1}
                onMove={(delta) => move(item.row.space.id, delta)}
              />
            );
          }
          case "more":
            return (
              <Pressable
                key="more"
                accessibilityRole="button"
                accessibilityState={{ expanded: item.expanded }}
                onPress={() => setExpanded(!expanded)}
                className={ROW}
              >
                <SymbolView
                  name={item.expanded ? "chevron.down" : "chevron.right"}
                  size={14}
                  tintColorClassName="accent-icon-muted"
                />
                <Text className="min-w-0 flex-1 text-base text-foreground-muted">
                  {homeMoreLabel(item)}
                </Text>
                {!item.expanded && item.needsYou > 0 ? (
                  <Text className="text-xs tabular-nums text-foreground-muted">
                    {item.needsYou}
                  </Text>
                ) : null}
              </Pressable>
            );
          case "archived-header":
            return (
              <Text
                key="archived-header"
                className="px-4 pt-2 pb-1 text-xs font-t3-medium uppercase tracking-wide text-foreground-muted"
              >
                Archived
              </Text>
            );
          case "archived-space":
            return (
              <SpaceRow
                key={item.row.space.id}
                environmentId={environmentId}
                row={item.row}
                archivedActions={isSpaceOwner(item.row.space, viewer.memberId) && canOperate}
              />
            );
        }
      })}
    </View>
  );
}

function PlaceRow(props: {
  readonly place: keyof typeof PLACES;
  readonly count: number | null;
  readonly onPress: () => void;
}) {
  const place = PLACES[props.place];
  const count = props.count ?? 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `${place.label}, ${count} need you` : place.label}
      onPress={props.onPress}
      className={ROW}
    >
      <SymbolView name={place.icon} size={16} tintColorClassName="accent-icon-muted" />
      <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
        {place.label}
      </Text>
      {count > 0 ? (
        <View className="min-w-5 items-center rounded-full bg-indigo-500/15 px-1.5 py-0.5">
          <Text className="text-xs font-t3-bold tabular-nums text-adaptive-indigo-600-300">
            {count}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function SpaceRow(props: {
  readonly environmentId: EnvironmentId;
  readonly row: SidebarSpaceRow;
  readonly canMoveUp?: boolean;
  readonly canMoveDown?: boolean;
  readonly onMove?: (delta: -1 | 1) => void;
  readonly archivedActions?: boolean;
}) {
  const navigation = useNavigation();
  const mutate = useAtomCommand(spaceEnvironment.mutate, { reportFailure: false });
  const { space, needsYou, unread } = props.row;
  const archived = space.archivedAt !== null;
  const row = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        needsYou > 0
          ? `${space.name}, ${needsYou} need you`
          : unread
            ? `${space.name}, unread`
            : space.name
      }
      onPress={() =>
        navigation.dispatch(
          StackActions.push("SpaceRoom", { environmentId: props.environmentId, spaceId: space.id }),
        )
      }
      className={ROW}
    >
      <SpaceMark space={space} />
      <Text
        numberOfLines={1}
        className={cn(
          "min-w-0 flex-1 text-base",
          archived ? "text-foreground-muted" : "text-foreground",
        )}
      >
        {space.name}
      </Text>
      {needsYou > 0 ? (
        <Text className="text-xs tabular-nums text-foreground-muted">{needsYou}</Text>
      ) : unread ? (
        <View className="size-1.5 rounded-full bg-foreground-muted" />
      ) : null}
    </Pressable>
  );
  if (archived) {
    if (!props.archivedActions) return row;
    return (
      <Menu
        shouldOpenOnLongPress
        actions={[{ id: "unarchive", title: "Unarchive", image: "archivebox" }]}
        onPressAction={() =>
          void mutate({
            environmentId: props.environmentId,
            input: { type: "unarchive", spaceId: space.id },
          }).then((result) => reportSpaceResult("Could not unarchive", result))
        }
      >
        {row}
      </Menu>
    );
  }
  const actions = [
    ...(props.canMoveUp ? [{ id: "up", title: "Move up", image: "arrow.up" }] : []),
    ...(props.canMoveDown ? [{ id: "down", title: "Move down", image: "arrow.down" }] : []),
  ];
  if (actions.length === 0 || props.onMove === undefined) return row;
  const onMove = props.onMove;
  return (
    <Menu
      shouldOpenOnLongPress
      actions={actions}
      onPressAction={({ nativeEvent }) => onMove(nativeEvent.event === "up" ? -1 : 1)}
    >
      {row}
    </Menu>
  );
}
