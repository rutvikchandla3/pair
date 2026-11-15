import { useAtomValue } from "@effect/atom-react";
import { type StaticScreenProps, StackActions, useNavigation } from "@react-navigation/native";
import { SHARED_WITH_YOU_STATE_LABEL } from "@t3tools/client-runtime/inbox";
import { FORMER_MEMBER } from "@t3tools/client-runtime/state/team";
import { EnvironmentId, type MemberId, type SharedWithYouItem } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { FlatList, Pressable, type TextInputInstance, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { MemberAvatar } from "../../components/MemberAvatar";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { SearchField } from "../../components/ui/SearchField";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useThreadShell } from "../../state/entities";
import {
  hasSharedWithYouFilters,
  sharedWithYouFiltersAtom,
  useSharedWithYouPages,
} from "../../state/inbox";
import { usePresence } from "../../state/presence";
import { useDebouncedValue } from "../../state/queries";
import { useTeamRoster, useThreadTeamActions } from "../../state/team";
import { PageTopBar } from "./PageTopBar";
import { sharedWithYouRows } from "./inboxModel";

type Params = { readonly environmentId: string };

const SEARCH_DEBOUNCE_MS = 200;

/** Threads teammates shared with the viewer, by person (spec Part 1, Shared with you). */
export function SharedWithYouScreen(props: StaticScreenProps<Params>) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const searchRef = useRef<TextInputInstance | null>(null);
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);
  const filters = useAtomValue(sharedWithYouFiltersAtom(environmentId));
  const shared = useSharedWithYouPages(environmentId, filters, query);
  const { members } = useTeamRoster(environmentId);
  const presence = usePresence(environmentId);
  const rows = sharedWithYouRows(shared.items, shared.people);
  const filtered = hasSharedWithYouFilters(filters) || query !== "";
  const memberOf = (memberId: MemberId) => members.get(memberId) ?? FORMER_MEMBER;

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
      <PageTopBar
        title="Shared with you"
        trailing={
          <IconButton
            icon={
              hasSharedWithYouFilters(filters)
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            accessibilityLabel="Filters"
            onPress={() =>
              navigation.dispatch(StackActions.push("SharedWithYouFilters", { environmentId }))
            }
          />
        }
      />
      <View className="flex-row px-4 py-2">
        <SearchField
          autoFocus={false}
          inputRef={searchRef}
          accessibilityLabel="Search shared threads"
          clearAccessibilityLabel="Clear search"
          placeholder="Search"
          value={search}
          onChangeText={setSearch}
        />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24, flexGrow: 1 }}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (shared.hasMore) shared.loadMore();
        }}
        renderItem={({ item: row }) =>
          row.type === "person" ? (
            <View className="flex-row items-center gap-2 px-4 pt-4 pb-1">
              <View>
                <MemberAvatar member={memberOf(row.memberId)} size="sm" />
                <PresenceDot status={presence.members.get(row.memberId)} />
              </View>
              <Text numberOfLines={1} className="shrink text-sm font-t3-medium text-foreground">
                {memberOf(row.memberId).name}
              </Text>
              <Text className="text-xs tabular-nums text-foreground-muted">{row.count}</Text>
            </View>
          ) : (
            <SharedThreadRow
              environmentId={environmentId}
              item={row.item}
              onPress={() =>
                navigation.dispatch(
                  StackActions.push("Thread", { environmentId, threadId: row.item.threadId }),
                )
              }
            />
          )
        }
        ListFooterComponent={
          shared.loadingMore ? (
            <View className="items-center p-4">
              <AppActivityIndicator colorClassName="accent-icon-muted" />
            </View>
          ) : undefined
        }
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center p-8">
            {shared.error !== null ? (
              <Text className="text-center text-sm text-foreground-muted">{shared.error}</Text>
            ) : !shared.loaded ? (
              <AppActivityIndicator colorClassName="accent-icon-muted" />
            ) : (
              <Text className="text-center text-sm text-foreground-muted">
                {filtered
                  ? "No shared threads match."
                  : "Nothing is shared with you by name. Your spaces' threads are in each space."}
              </Text>
            )}
          </View>
        }
      />
    </View>
  );
}

function PresenceDot(props: { readonly status: "online" | "away" | undefined }) {
  if (props.status === undefined) return null;
  return (
    <View
      accessibilityLabel={props.status === "online" ? "Online" : "Away"}
      className={cn(
        "absolute -right-0.5 -bottom-0.5 size-2 rounded-full border border-screen",
        props.status === "online" ? "bg-emerald-500" : "bg-warning-foreground",
      )}
    />
  );
}

function SharedThreadRow(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SharedWithYouItem;
  readonly onPress: () => void;
}) {
  const { item } = props;
  const shell = useThreadShell({ environmentId: props.environmentId, threadId: item.threadId });
  const { setFollowed } = useThreadTeamActions();
  const following = shell?.followedAt != null;
  const state = SHARED_WITH_YOU_STATE_LABEL[item.state];
  return (
    <Menu
      shouldOpenOnLongPress
      actions={[
        following
          ? { id: "unfollow", title: "Unfollow", image: "bell.slash" }
          : { id: "follow", title: "Follow", image: "bell" },
      ]}
      onPressAction={() =>
        void setFollowed({ environmentId: props.environmentId, id: item.threadId }, !following)
      }
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.title}, ${state}`}
        accessibilityHint={following ? "Long-press to unfollow" : "Long-press to follow"}
        onPress={props.onPress}
        className="min-h-12 flex-row items-center gap-3 border-b border-border-subtle px-4 py-2 active:opacity-70"
      >
        {item.taskId === undefined ? null : (
          <SymbolView name="person.2" size={13} tintColorClassName="accent-icon-muted" />
        )}
        <View className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={1} className="text-base text-foreground">
            {item.title}
          </Text>
          <Text numberOfLines={1} className="text-xs text-foreground-muted">
            {following ? `${state} · Following` : state}
          </Text>
        </View>
        <Text className="text-xs tabular-nums text-foreground-muted">
          {relativeTime(item.lastActivityAt)}
        </Text>
      </Pressable>
    </Menu>
  );
}
