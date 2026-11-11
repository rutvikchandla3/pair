import { ComposerSelectControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { CloudIcon, FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type CloudEnvModeItem,
  type CloudEnvModeRow,
  type EnvMode,
} from "./BranchToolbar.logic";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { PreviousWorktreeItemContent } from "./PreviousWorktreeItemContent";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";

const PREVIOUS_WORKTREE_SELECT_VALUE = "previous-worktree";

interface BranchToolbarEnvModeSelectorProps {
  /** Why the workspace is fixed to a new worktree, or null when it can change. */
  forcedWorktreeReason?: string | null;
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  cloudItem: CloudEnvModeItem | null;
  onEnvModeChange: (mode: EnvMode) => void;
  onCloudRow: (row: CloudEnvModeRow) => void;
  previousWorktreeLabel?: string | null;
  previousWorktreeBranch?: string | null;
  onUsePreviousWorktree?: () => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  forcedWorktreeReason = null,
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  cloudItem,
  onEnvModeChange,
  onCloudRow,
  previousWorktreeLabel,
  previousWorktreeBranch = null,
  onUsePreviousWorktree,
}: BranchToolbarEnvModeSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.workspace",
  );
  const cloudOnly = cloudItem?.only === true;
  const showPreviousWorktree =
    Boolean(previousWorktreeLabel && onUsePreviousWorktree) && !cloudOnly;
  const envModeItems = [
    ...(cloudOnly
      ? []
      : [
          { value: "local", label: resolveCurrentWorkspaceLabel(activeWorktreePath) },
          { value: "worktree", label: resolveEnvModeLabel("worktree") },
        ]),
    ...(cloudItem?.rows.map((row) => ({ value: row.value, label: row.label })) ?? []),
    ...(showPreviousWorktree && previousWorktreeLabel
      ? [{ value: PREVIOUS_WORKTREE_SELECT_VALUE, label: previousWorktreeLabel }]
      : []),
  ];

  const stopContextMenuMouseDown = (event: ReactMouseEvent) => {
    if (event.button !== 0 || event.ctrlKey) {
      event.stopPropagation();
    }
  };

  if (envLocked || forcedWorktreeReason !== null) {
    const lockedRow = (
      <span
        className="inline-flex h-7 min-w-0 items-center gap-1.5 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-sm sm:h-6 sm:text-xs"
        data-composer-context-control
      >
        {effectiveEnvMode === "cloud" ? (
          <CloudIcon className="size-3" />
        ) : activeWorktreePath ? (
          <FolderGitIcon className="size-3" />
        ) : effectiveEnvMode === "worktree" ? (
          <FolderGit2Icon className="size-3" />
        ) : (
          <FolderIcon className="size-3" />
        )}
        <ComposerContextLabel>
          {forcedWorktreeReason !== null
            ? resolveEnvModeLabel("worktree")
            : resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)}
        </ComposerContextLabel>
      </span>
    );

    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>
          {forcedWorktreeReason ??
            resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={effectiveEnvMode === "cloud" ? (cloudItem?.value ?? "cloud") : effectiveEnvMode}
      onValueChange={(value: string | null) => {
        if (value === PREVIOUS_WORKTREE_SELECT_VALUE) {
          onUsePreviousWorktree?.();
          return;
        }
        const cloudRow = cloudItem?.rows.find((row) => row.value === value);
        if (cloudRow) onCloudRow(cloudRow);
        else onEnvModeChange(value as EnvMode);
      }}
      items={envModeItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size="xs"
              className="min-w-0 shrink"
              aria-label="Workspace"
              data-composer-shortcut="composer.workspace"
              data-composer-context-control
              onMouseDownCapture={stopContextMenuMouseDown}
            />
          }
        >
          {effectiveEnvMode === "cloud" ? (
            <CloudIcon className="size-3" />
          ) : effectiveEnvMode === "worktree" ? (
            <FolderGit2Icon className="size-3" />
          ) : activeWorktreePath ? (
            <FolderGitIcon className="size-3" />
          ) : (
            <FolderIcon className="size-3" />
          )}
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {effectiveEnvMode === "local"
            ? resolveCurrentWorkspaceLabel(activeWorktreePath)
            : resolveEnvModeLabel(effectiveEnvMode)}
          {shortcutLabel ? ` · ${shortcutLabel}` : null}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup
        alignItemWithTrigger={false}
        {...composerFloatingLayerProps}
        className={showPreviousWorktree ? "w-[min(21rem,calc(100vw-2rem))]" : undefined}
      >
        <SelectGroup>
          <SelectGroupLabel>Workspace</SelectGroupLabel>
          {cloudOnly ? null : (
            <>
              <SelectItem value="local">
                <span className="inline-flex items-center gap-1.5">
                  {activeWorktreePath ? (
                    <FolderGitIcon className="size-3" />
                  ) : (
                    <FolderIcon className="size-3" />
                  )}
                  {resolveCurrentWorkspaceLabel(activeWorktreePath)}
                </span>
              </SelectItem>
              <SelectItem value="worktree">
                <span className="inline-flex items-center gap-1.5">
                  <FolderGit2Icon className="size-3" />
                  {resolveEnvModeLabel("worktree")}
                </span>
              </SelectItem>
            </>
          )}
          {cloudItem?.rows.map((row) => (
            <CloudEnvModeTooltip key={row.value} reason={row.reason}>
              <SelectItem value={row.value} disabled={row.disabled}>
                <span className="inline-flex items-center gap-1.5">
                  <CloudIcon className="size-3" />
                  {row.label}
                </span>
              </SelectItem>
            </CloudEnvModeTooltip>
          ))}
          {showPreviousWorktree && previousWorktreeLabel ? (
            <SelectItem value={PREVIOUS_WORKTREE_SELECT_VALUE}>
              <PreviousWorktreeItemContent branch={previousWorktreeBranch} />
            </SelectItem>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});

/** A disabled item takes no pointer events, so the reason hangs on a wrapper. */
export function CloudEnvModeTooltip({
  reason,
  children,
}: {
  reason: string | null;
  children: ReactNode;
}) {
  if (reason === null) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={<div />}>{children}</TooltipTrigger>
      <TooltipPopup>{reason}</TooltipPopup>
    </Tooltip>
  );
}
