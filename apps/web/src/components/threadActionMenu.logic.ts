import type { ContextMenuItem, MemberId } from "@t3tools/contracts";
import type { SandboxAction } from "@t3tools/client-runtime/state/sandbox";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

import type { DraftThreadEnvMode } from "../composerDraftStore";
import { SANDBOX_ACTION_MENU_LABELS } from "@t3tools/client-runtime/state/sandbox";
import { CONTINUE_IN_CLOUD_LABEL } from "@t3tools/client-runtime/state/threadMove";

export type ThreadActionMenuId =
  | "find"
  | "new-thread-on-branch"
  | "filter-by-project"
  | "turn-into-project"
  | "project-settings"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "assign"
  | `assign:${MemberId}`
  | "follow"
  | "unfollow"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "continue-in-cloud"
  | `machine:${SandboxAction}`
  | "continue-locally"
  | "share-guest"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread"
  | "copy-thread-id"
  | "archive"
  | "delete";

export type DraftActionMenuId =
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "project-settings"
  | "discard";

export function buildDraftActionMenuItems(options: {
  readonly hasPath: boolean;
  readonly hasBranch: boolean;
  readonly hasProject: boolean;
}): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  return [
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath ? [{ id: "copy-path" as const, label: "Path", icon: "folder" }] : []),
        ...(options.hasBranch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
      ],
    },
    ...(options.hasProject
      ? [{ id: "project-settings" as const, label: "Project settings", icon: "settings" }]
      : []),
    {
      id: "discard",
      label: "Discard draft",
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean;
  readonly canFind?: boolean;
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects attached providers, so disable it while running. */
  readonly isRunning: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly autoSettleOptOut: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /** Guest links need their own grant, so the caller checks it instead of `canOperate`. */
  readonly canShareWithGuest?: boolean;
  /** A No project thread with its own folder, on a server that can promote it. */
  readonly canTurnIntoProject?: boolean;
  /** Set only on a server with a team; without it the menu is the single-user menu. */
  readonly team?: {
    readonly members: ReadonlyArray<{ readonly id: MemberId; readonly name: string }>;
    readonly ownerId: MemberId | null;
    /** Only the thread's owner or an admin may delete it. */
    readonly canDelete: boolean;
    /** Absent hides Follow: the viewer owns the thread, or the server cannot follow. */
    readonly following?: boolean;
  };
  /** Set only for a cloud thread, which has no local path to copy. */
  readonly machine?: {
    readonly actions: ReadonlyArray<SandboxAction>;
    /** Shown disabled with the owner-or-admin suffix, not hidden. */
    readonly ownerOnlyDenied: ReadonlyArray<SandboxAction>;
  };
  /** Set only when a Pair Cloud can take this thread; absent hides the item. */
  readonly continueInCloud?: {
    /** Why it can't now: the offer's short label, never its sentence. */
    readonly label: string | null;
  };
  /** Set only when the member's own server can take this cloud thread. */
  readonly continueLocally?: {
    /** Why it can't now, shown in the label as the owner-only items are. */
    readonly disabledLabel: string | null;
  };
}

const MACHINE_ACTION_ICONS: Readonly<Record<SandboxAction, string>> = {
  wake: "cloud",
  sleep: "power",
  retry: "refresh-cw",
  discard: "trash",
};

/**
 * Local navigation, read markers, and copying remain available to read-only clients. Continue
 * locally acts on the member's own server, which checks its own permission.
 */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  return ![
    "continue-locally",
    "find",
    "new-thread-on-branch",
    "project-settings",
    "mark-unread",
    "share-guest",
    "copy",
    "copy-path",
    "copy-branch",
    "copy-thread",
    "copy-thread-id",
  ].includes(action);
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.canFind
      ? [{ id: "find" as const, label: "Find in thread", icon: "text-search" }]
      : []),
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `New thread on ${state.branch}`,
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: "Unpin thread", icon: "pin-off" }
            : { id: "pin" as const, label: "Pin thread", icon: "pin" },
        ]
      : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "Un-settle thread", icon: "circle-check" }
            : { id: "settle" as const, label: "Settle thread", icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "Wake thread", icon: "clock" }
            : {
                id: "snooze" as const,
                label: "Snooze",
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: `${preset.label} (${preset.whenLabel})`,
                  })),
                  {
                    id: "snooze:custom" as const,
                    label: "Custom…",
                    separatorBefore: state.snoozePresets.length > 0,
                  },
                ],
              },
        ]
      : []),
    ...(state.team
      ? [
          {
            id: "assign" as const,
            label: "Assign to…",
            icon: "user-plus",
            children: state.team.members.map((member) => ({
              id: `assign:${member.id}` as const,
              label: member.name,
              checked: member.id === state.team?.ownerId,
            })),
          },
        ]
      : []),
    ...(state.team?.following === undefined
      ? []
      : [
          state.team.following
            ? { id: "unfollow" as const, label: "Unfollow thread", icon: "eye-off" }
            : { id: "follow" as const, label: "Follow thread", icon: "eye" },
        ]),
    { id: "rename", label: "Rename thread", icon: "pencil", separatorBefore: true },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: "Mark unread", icon: "mail-open" },
    ...(state.continueInCloud
      ? [
          {
            id: "continue-in-cloud" as const,
            // "…": it opens a dialog.
            label:
              state.continueInCloud.label === null
                ? `${CONTINUE_IN_CLOUD_LABEL}…`
                : `${CONTINUE_IN_CLOUD_LABEL} (${state.continueInCloud.label})`,
            icon: "cloud-upload",
            separatorBefore: true,
            ...(state.continueInCloud.label === null ? {} : { disabled: true }),
          },
        ]
      : []),
    ...(state.machine?.actions ?? []).map((action, index) => {
      const denied = state.machine?.ownerOnlyDenied.includes(action) === true;
      return {
        id: `machine:${action}` as const,
        label: denied
          ? `${SANDBOX_ACTION_MENU_LABELS[action]} (owner or admin only)`
          : SANDBOX_ACTION_MENU_LABELS[action],
        icon: MACHINE_ACTION_ICONS[action],
        ...(index === 0 ? { separatorBefore: true } : {}),
        ...(action === "discard" ? { destructive: true } : {}),
        ...(denied ? { disabled: true } : {}),
      };
    }),
    ...(state.continueLocally
      ? [
          {
            id: "continue-locally" as const,
            label:
              state.continueLocally.disabledLabel === null
                ? "Continue locally"
                : `Continue locally (${state.continueLocally.disabledLabel})`,
            icon: "laptop",
            ...((state.machine?.actions.length ?? 0) === 0 ? { separatorBefore: true } : {}),
            ...(state.continueLocally.disabledLabel === null ? {} : { disabled: true }),
          },
        ]
      : []),
    ...(state.canShareWithGuest
      ? [{ id: "share-guest" as const, label: "Share with guest", icon: "user-plus" }]
      : []),
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? "Show all projects"
              : `Filter by ${state.projectFilter.label}`,
            icon: "folder-tree",
          },
        ]
      : []),
    ...(state.canTurnIntoProject
      ? [
          {
            id: "turn-into-project" as const,
            label: "Turn into project",
            icon: "folder-plus",
            disabled: state.isRunning,
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: "Auto-settle behavior",
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: "Enabled",
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: "Disabled",
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      separatorBefore: true,
      children: [
        ...(state.machine ? [] : [{ id: "copy-path" as const, label: "Path", icon: "folder" }]),
        ...(state.branch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
        { id: "copy-thread", label: "Thread", icon: "message-square" },
        { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
      ],
    },
    { id: "project-settings", label: "Project settings", icon: "settings" },
    {
      id: "archive",
      label: "Archive thread",
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: state.team?.canDelete === false ? "Delete (owner or admin only)" : "Delete",
      destructive: true,
      icon: "trash",
      ...(state.team?.canDelete === false ? { disabled: true } : {}),
    },
  ];
  return state.canOperate
    ? items
    : items.map((item) =>
        threadActionRequiresOperate(item.id)
          ? {
              ...item,
              disabled: true,
              ...(item.children
                ? { children: item.children.map((child) => ({ ...child, disabled: true })) }
                : {}),
            }
          : item,
      );
}

export function machineMenuAction(id: ThreadActionMenuId): SandboxAction | null {
  switch (id) {
    case "machine:wake":
      return "wake";
    case "machine:sleep":
      return "sleep";
    case "machine:retry":
      return "retry";
    case "machine:discard":
      return "discard";
    default:
      return null;
  }
}

/** A cloud thread's worktree path is inside its machine, so its branch starts a cloud draft. */
export function newThreadOnBranchOptions(thread: {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly source: { readonly sandboxId?: unknown };
}): { branch: string | null; worktreePath: string | null; envMode: DraftThreadEnvMode } {
  if (thread.source.sandboxId !== undefined) {
    return { branch: thread.branch, worktreePath: null, envMode: "cloud" };
  }
  return {
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    envMode: thread.worktreePath ? "worktree" : "local",
  };
}
