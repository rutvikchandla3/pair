import { useWorkspaceSidebarHeaderItem } from "../layout/useWorkspaceSidebarHeaderItem";
import { StackActions, useNavigation } from "@react-navigation/native";
import { threadHeaderAppearance } from "./thread-header-appearance";
import { isDuoDevice } from "../../lib/device-type";
import type { AppNativeStackNavigationOptions } from "../../native/StackHeader";
import { useDeviceType } from "../../native/native-layout-metrics";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import type { AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";
import type { PresentMember } from "@t3tools/client-runtime/state/presence";
import type { SandboxAccessChip } from "@t3tools/client-runtime/state/sandbox";
import { ThreadAccessChip } from "./ThreadAccessChip";
import { ThreadViewerStack } from "./ThreadViewerStack";
import {
  ThreadGitControls,
  useThreadGitCenterHeaderItems,
  useThreadGitRightHeaderItems,
} from "./ThreadGitControls";

type NativeHeaderItems = ReadonlyArray<Record<string, unknown>>;

function nativeMenuItems(items: ReadonlyArray<AppBarMenuItem>): NativeHeaderItems {
  return items.map((item) => ({
    label: item.title ?? "",
    ...(item.icon ? { icon: { name: item.icon, type: "sfSymbol" as const } } : {}),
    ...("items" in item
      ? { type: "submenu" as const, items: nativeMenuItems(item.items) }
      : {
          type: "action" as const,
          ...(item.subtitle ? { subtitle: item.subtitle } : {}),
          state: item.selected ? ("on" as const) : undefined,
          disabled: item.disabled,
          onPress: item.onPress,
        }),
  }));
}

function nativeHeaderMenu(menu: AppBarMenu, identifier: string) {
  return {
    accessibilityLabel: menu.status === undefined ? menu.title : `${menu.title}: ${menu.status}`,
    icon: { name: typeof menu.icon === "string" ? menu.icon : menu.icon.ios, type: "sfSymbol" },
    identifier,
    label: menu.title,
    menu: { title: menu.status ?? menu.title, items: nativeMenuItems(menu.items) },
    sharesBackground: true,
    type: "menu",
    variant: "plain",
  };
}

export function useThreadHeaderOptions(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly headerColor: string;
  readonly usesNativeHeaderGlass: boolean;
  readonly gitControls: Parameters<typeof ThreadGitControls>[0];
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  /** Follow and Assign; null outside team mode. */
  readonly teamMenu?: AppBarMenu | null;
  /** Wake, sleep, retry and discard; null for a local thread. */
  readonly machineMenu?: AppBarMenu | null;
  /** Teammates viewing this thread; empty outside team mode. */
  readonly viewers?: ReadonlyArray<PresentMember>;
  /** Who can open this cloud thread; null while it is private. */
  readonly accessChip?: SandboxAccessChip | null;
}) {
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const deviceType = useDeviceType();
  const usesDuoHeader = usesNativeWorkspaceColumns && isDuoDevice(deviceType);
  const navigation = useNavigation();
  const { layout, startNewTask } = useAdaptiveWorkspaceLayout();
  const sidebarHeaderItem = useWorkspaceSidebarHeaderItem();
  const gitRightHeaderItems = useThreadGitRightHeaderItems(props.gitControls);
  const gitCenterHeaderItems = useThreadGitCenterHeaderItems(props.gitControls);
  const teamHeaderItems: NativeHeaderItems = [
    ...(props.machineMenu ? [nativeHeaderMenu(props.machineMenu, "thread-right-machine")] : []),
    ...(props.teamMenu ? [nativeHeaderMenu(props.teamMenu, "thread-right-team")] : []),
  ];
  const viewers = props.viewers ?? [];
  const accessChip = props.accessChip ?? null;
  const accessHeaderItems: NativeHeaderItems =
    accessChip === null
      ? []
      : [
          {
            element: <ThreadAccessChip chip={accessChip} />,
            hidesSharedBackground: true,
            identifier: "thread-right-access",
            type: "custom",
          },
        ];
  const viewerHeaderItems: NativeHeaderItems =
    viewers.length > 0
      ? [
          {
            element: <ThreadViewerStack viewers={viewers} />,
            hidesSharedBackground: true,
            identifier: "thread-right-viewers",
            type: "custom",
          },
        ]
      : [];
  const compactRightHeaderItems = [
    ...gitRightHeaderItems,
    ...teamHeaderItems,
    ...accessHeaderItems,
    ...viewerHeaderItems,
  ];
  const threadCenterHeaderItems = [
    ...gitCenterHeaderItems,
    ...teamHeaderItems,
    ...accessHeaderItems,
    ...viewerHeaderItems,
  ];
  const splitLeftHeaderItems: NativeHeaderItems = [
    ...(!usesDuoHeader
      ? [
          {
            spacing: 18,
            type: "spacing" as const,
          },
        ]
      : []),
    ...(props.onReturnToThread
      ? [
          withNativeGlassHeaderItem({
            accessibilityLabel: "Return to chat",
            icon: { name: "chevron.left", type: "sfSymbol" as const },
            identifier: "thread-left-return",
            onPress: props.onReturnToThread,
            type: "button" as const,
          }),
        ]
      : []),
    ...(sidebarHeaderItem ? [sidebarHeaderItem] : []),
    ...(!usesDuoHeader && !props.draft
      ? [
          withNativeGlassHeaderItem({
            accessibilityLabel: "New task",
            icon: { name: "square.and.pencil", type: "sfSymbol" as const },
            identifier: "thread-left-new-task",
            label: "New task",
            onPress: startNewTask,
            type: "button" as const,
          }),
        ]
      : []),
  ];
  const canGoBack = navigation.canGoBack();
  const compactHomeHeaderItems: NativeHeaderItems = [
    withNativeGlassHeaderItem({
      accessibilityLabel: "Go to threads list",
      icon: { name: "list.bullet", type: "sfSymbol" as const },
      identifier: "thread-left-home",
      onPress: () => navigation.dispatch(StackActions.replace("Home")),
      type: "button" as const,
    }),
  ];

  const options: AppNativeStackNavigationOptions = {
    ...threadHeaderAppearance(props.usesNativeHeaderGlass),
    headerTitle: props.title,
    title: props.title,
    headerBackVisible: !layout.usesSplitView,
    unstable_headerLeftItems: layout.usesSplitView
      ? () => splitLeftHeaderItems
      : canGoBack
        ? undefined
        : () => compactHomeHeaderItems,
    // The workspace navigator adds compose to the Duo detail column's bar.
    unstable_headerRightItems: () =>
      usesDuoHeader || layout.usesSplitView ? threadCenterHeaderItems : compactRightHeaderItems,
    unstable_headerToolbarItems: () => [],
    unstable_headerSubtitle: props.usesNativeHeaderGlass ? props.subtitle : undefined,
    contentStyle: undefined,
  };
  const { environmentId, threadId, gitStatus, workspace } = props.gitControls;
  return {
    options,
    // Factories re-read only on version changes; include displayed items and hidden callback state such as default refs.
    optionsVersion: [
      splitLeftHeaderItems,
      threadCenterHeaderItems,
      compactRightHeaderItems,
      props.teamMenu,
      props.machineMenu,
      accessChip?.label,
      viewers.map((viewer) => `${viewer.id}:${viewer.away}`).join(","),
      usesDuoHeader,
      environmentId,
      threadId,
      gitStatus?.isDefaultRef,
      gitStatus?.refName,
      gitStatus?.pr?.url,
      // Menu callbacks act on the selected repository, which item labels may not reveal.
      workspace?.selected?.cwd ?? null,
    ],
    fallback:
      !layout.usesSplitView && !props.usesNativeHeaderGlass ? (
        <ThreadGitControls {...props.gitControls} showActionControls />
      ) : null,
  };
}
