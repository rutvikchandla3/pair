import type { CloudMachineSize, SandboxSize } from "@t3tools/contracts";
import { machineSpecLabel, SANDBOX_SIZE_LABELS } from "@t3tools/shared/sandbox";
import { ComposerControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { CloudIcon, FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { T, useGT, useMessages } from "gt-react";

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
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { withMachineSize } from "./sandbox/machineSize.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";

const PREVIOUS_WORKTREE_SELECT_VALUE = "previous-worktree";

interface BranchToolbarEnvModeSelectorProps {
  /** Why the workspace is fixed to a new worktree, or null when it can change. */
  forcedWorktreeReason?: string | null;
  /** Why the current checkout is off while other modes stay open, or null. */
  localDisabledReason?: string | null;
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  cloudItem: CloudEnvModeItem | null;
  onEnvModeChange: (mode: EnvMode) => void;
  onCloudRow: (row: CloudEnvModeRow) => void;
  previousWorktreeLabel?: string | null;
  previousWorktreeBranch?: string | null;
  onUsePreviousWorktree?: () => void;
  /** The size Cloud's label names, or null at the team default. */
  cloudSize: SandboxSize | null;
  /** Cloud's sizes to pick from; null hides the Machine group. */
  machine: CloudMachineChoice | null;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  forcedWorktreeReason = null,
  localDisabledReason = null,
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  cloudItem,
  onEnvModeChange,
  onCloudRow,
  previousWorktreeLabel,
  previousWorktreeBranch = null,
  onUsePreviousWorktree,
  cloudSize,
  machine,
}: BranchToolbarEnvModeSelectorProps) {
  const gt = useGT();
  const m = useMessages();
  const composerFloatingLayerProps = useComposerMenuProps();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.workspace",
  );
  const cloudOnly = cloudItem?.only === true;
  const showPreviousWorktree =
    Boolean(previousWorktreeLabel && onUsePreviousWorktree) && !cloudOnly;
  const stopContextMenuMouseDown = (event: ReactMouseEvent) => {
    if (event.button !== 0 || event.ctrlKey) {
      event.stopPropagation();
    }
  };

  if (envLocked || forcedWorktreeReason !== null) {
    const lockedLabel = withMachineSize(
      resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode, m),
      effectiveEnvMode === "cloud" ? cloudSize : null,
    );
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
          {forcedWorktreeReason !== null ? resolveEnvModeLabel("worktree", m) : lockedLabel}
        </ComposerContextLabel>
      </span>
    );

    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>
          {forcedWorktreeReason ??
            (effectiveEnvMode !== "cloud" && activeWorktreePath ? activeWorktreePath : lockedLabel)}
        </TooltipPopup>
      </Tooltip>
    );
  }

  const value = effectiveEnvMode === "cloud" ? (cloudItem?.value ?? "cloud") : effectiveEnvMode;
  const triggerLabel =
    effectiveEnvMode === "local"
      ? resolveCurrentWorkspaceLabel(activeWorktreePath, m)
      : effectiveEnvMode === "cloud"
        ? withMachineSize(
            cloudItem?.rows.find((row) => row.value === value)?.label ??
              resolveEnvModeLabel("cloud", m),
            cloudSize,
          )
        : resolveEnvModeLabel(effectiveEnvMode, m);

  return (
    <Menu modal={false}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  size="xs"
                  className="min-w-0 shrink"
                  aria-label={gt("Workspace")}
                  data-composer-shortcut="composer.workspace"
                  data-composer-context-control
                  onMouseDownCapture={stopContextMenuMouseDown}
                />
              }
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
          <ComposerContextLabel>{triggerLabel}</ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {effectiveEnvMode === "local"
            ? resolveCurrentWorkspaceLabel(activeWorktreePath, m)
            : effectiveEnvMode === "cloud"
              ? withMachineSize(resolveEnvModeLabel("cloud", m), cloudSize)
              : resolveEnvModeLabel(effectiveEnvMode, m)}
          {shortcutLabel ? ` · ${shortcutLabel}` : null}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup
        align="start"
        {...composerFloatingLayerProps}
        className={showPreviousWorktree ? "w-[min(21rem,calc(100vw-2rem))]" : undefined}
      >
        <MenuGroup>
          <MenuGroupLabel>
            <T>Workspace</T>
          </MenuGroupLabel>
          <MenuRadioGroup
            value={value}
            onValueChange={(next: string) => {
              if (next === PREVIOUS_WORKTREE_SELECT_VALUE) {
                onUsePreviousWorktree?.();
                return;
              }
              const cloudRow = cloudItem?.rows.find((row) => row.value === next);
              if (cloudRow) onCloudRow(cloudRow);
              else onEnvModeChange(next as EnvMode);
            }}
          >
            {cloudOnly ? null : (
              <>
                <CloudEnvModeTooltip reason={localDisabledReason}>
                  <MenuRadioItem value="local" disabled={localDisabledReason !== null} closeOnClick>
                    <span className="inline-flex items-center gap-1.5">
                      {activeWorktreePath ? (
                        <FolderGitIcon className="size-3" />
                      ) : (
                        <FolderIcon className="size-3" />
                      )}
                      {resolveCurrentWorkspaceLabel(activeWorktreePath, m)}
                    </span>
                  </MenuRadioItem>
                </CloudEnvModeTooltip>
                <MenuRadioItem value="worktree" closeOnClick>
                  <span className="inline-flex items-center gap-1.5">
                    <FolderGit2Icon className="size-3" />
                    {resolveEnvModeLabel("worktree", m)}
                  </span>
                </MenuRadioItem>
              </>
            )}
            {cloudItem?.rows.map((row) => (
              <CloudEnvModeTooltip key={row.value} reason={row.reason}>
                <MenuRadioItem value={row.value} disabled={row.disabled} closeOnClick>
                  <span className="inline-flex items-center gap-1.5">
                    <CloudIcon className="size-3" />
                    {row.label}
                  </span>
                </MenuRadioItem>
              </CloudEnvModeTooltip>
            ))}
            {showPreviousWorktree && previousWorktreeLabel ? (
              <MenuRadioItem value={PREVIOUS_WORKTREE_SELECT_VALUE} closeOnClick>
                <PreviousWorktreeItemContent branch={previousWorktreeBranch} />
              </MenuRadioItem>
            ) : null}
          </MenuRadioGroup>
        </MenuGroup>
        {machine === null ? null : <CloudMachineMenuGroup machine={machine} />}
      </MenuPopup>
    </Menu>
  );
});

export interface CloudMachineChoice {
  readonly sizes: ReadonlyArray<CloudMachineSize>;
  readonly selected: SandboxSize;
  readonly onChange: (spec: CloudMachineSize) => void;
}

/** Cloud's sizes, below the workspace rows of both pickers while Cloud is chosen. */
export function CloudMachineMenuGroup({ machine }: { machine: CloudMachineChoice }) {
  return (
    <>
      <MenuSeparator />
      <MenuGroup>
        {/* oxlint-disable-next-line t3code/no-untranslated-copy -- Pair copy stays English */}
        <MenuGroupLabel>Machine</MenuGroupLabel>
        <MenuRadioGroup
          value={machine.selected}
          onValueChange={(next: string) => {
            const spec = machine.sizes.find((candidate) => candidate.size === next);
            if (spec) machine.onChange(spec);
          }}
        >
          {machine.sizes.map((spec) => (
            <MenuRadioItem key={spec.size} value={spec.size} closeOnClick>
              <span className="flex min-w-0 items-center gap-1.5">
                <span>{SANDBOX_SIZE_LABELS[spec.size]}</span>
                <span className="truncate text-muted-foreground">{machineSpecLabel(spec)}</span>
                {spec.default ? (
                  <span className="ms-auto shrink-0 ps-2 text-muted-foreground text-xs">
                    {/* oxlint-disable t3code/no-untranslated-copy -- Pair copy stays English */}
                    team default
                    {/* oxlint-enable t3code/no-untranslated-copy */}
                  </span>
                ) : null}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
    </>
  );
}

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
