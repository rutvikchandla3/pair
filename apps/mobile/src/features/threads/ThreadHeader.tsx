import type { PresentMember } from "@t3tools/client-runtime/state/presence";
import type { SandboxAccessChip } from "@t3tools/client-runtime/state/sandbox";
import { Fragment, type ReactElement } from "react";
import { Platform } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";
import { Toolbar } from "../../components/ui/Toolbar";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";
import { ThreadAccessChip } from "./ThreadAccessChip";
import { ThreadViewerStack } from "./ThreadViewerStack";

/** A compact bar has room for one of the thread's own menus; each becomes a submenu of it. */
function foldThreadMenus(menus: ReadonlyArray<AppBarMenu>): ReadonlyArray<AppBarMenu> {
  if (menus.length < 2) return menus;
  const statuses = menus.flatMap((menu) => (menu.status === undefined ? [] : [menu.status]));
  return [
    {
      title: "Thread",
      icon: "ellipsis.circle",
      ...(statuses.length > 0 ? { status: statuses.join(" · ") } : {}),
      separateBackground: false,
      items: menus.map((menu): AppBarMenuItem => ({
        id: `thread-menu-${menu.title}`,
        title: menu.status === undefined ? menu.title : `${menu.title}: ${menu.status}`,
        icon: typeof menu.icon === "string" ? menu.icon : menu.icon.ios,
        items: menu.items,
      })),
    },
  ];
}

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
  /** Follow and Assign; null outside team mode. */
  readonly teamMenu?: AppBarMenu | null;
  /** Add to task, Move and Remove; null off a space. */
  readonly spaceMenu?: AppBarMenu | null;
  /** Wake, sleep, retry and discard; null for a local thread. */
  readonly machineMenu?: AppBarMenu | null;
  /** Teammates viewing this thread; empty outside team mode. */
  readonly viewers?: ReadonlyArray<PresentMember>;
  /** Who can open this cloud thread; null while it is private. */
  readonly accessChip?: SandboxAccessChip | null;
}) {
  const goBack = useWorkspaceBackNavigation("threads");
  const { layout, toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const actions: AppBarAction[] = props.hasThreadCwd
    ? [
        {
          accessibilityLabel: filesVisible ? "Close files" : "Open files",
          icon: "folder",
          selected: filesVisible,
          disabled: !props.gitControls.canOpenFiles,
          separateBackground: false,
          onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
        },
      ]
    : [];
  const threadMenus = [props.machineMenu, props.teamMenu, props.spaceMenu].filter(
    (menu): menu is AppBarMenu => menu != null,
  );
  const menus = [
    gitMenu,
    terminalMenu,
    ...(layout.usesSplitView ? threadMenus : foldThreadMenus(threadMenus)),
  ].filter((menu): menu is AppBarMenu => menu !== null);
  const viewers = props.viewers ?? [];
  const trailingItems: Array<{ readonly key: string; readonly element: ReactElement }> = [
    ...(props.accessChip
      ? [{ key: "access", element: <ThreadAccessChip chip={props.accessChip} /> }]
      : []),
    ...(viewers.length > 0
      ? [
          {
            key: "viewers",
            element: (
              <ThreadViewerStack viewers={viewers} max={layout.usesSplitView ? undefined : 1} />
            ),
          },
        ]
      : []),
  ];
  // iOS reads bar items from Toolbar children; Android draws the elements in its bar.
  const trailing =
    trailingItems.length === 0
      ? undefined
      : trailingItems.map(({ key, element }) =>
          Platform.OS === "ios" ? (
            <Toolbar.Custom key={key}>{element}</Toolbar.Custom>
          ) : (
            <Fragment key={key}>{element}</Fragment>
          ),
        );

  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBackToList={goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: "Return to chat",
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={actions}
      menus={menus}
      trailing={trailing}
      hideBottomBorder
    />
  );
}
