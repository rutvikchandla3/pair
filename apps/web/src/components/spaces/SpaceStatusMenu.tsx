import { SPACE_TASK_STATUSES, spaceTaskStatusForKey } from "@t3tools/client-runtime/spaces";
import type { EnvironmentId, SpaceTask, SpaceTaskStatus } from "@t3tools/contracts";
import type { KeyboardEvent, ReactElement, ReactNode } from "react";

import { spaceEnvironment } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { CheckIcon } from "lucide-react";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { SpaceTaskStatusGlyph } from "./SpaceStatusIcon";

/** Sets a task's status; writes to one task land in the order they were picked. */
export function useSetSpaceTaskStatus(environmentId: EnvironmentId) {
  const setStatus = useAtomCommand(spaceEnvironment.setTaskStatus, "Set task status");
  return async (task: Pick<SpaceTask, "id" | "spaceId" | "status">, status: SpaceTaskStatus) => {
    if (task.status === status) return;
    const result = await setStatus({
      environmentId,
      input: { spaceId: task.spaceId, taskId: task.id, status },
    });
    toastCommandFailure("Could not set the status", result);
  };
}

/** A focused task row's 1–5 keys pick its status; any other key passes through. */
export function handleSpaceStatusKey(
  event: KeyboardEvent,
  onPick: (status: SpaceTaskStatus) => void,
): void {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  const status = spaceTaskStatusForKey(event.key);
  if (status === null) return;
  event.preventDefault();
  onPick(status);
}

/** The five statuses with their icons and keys, on a trigger the caller renders. */
export function SpaceStatusMenu(props: {
  readonly status: SpaceTaskStatus;
  readonly trigger: ReactElement;
  readonly children?: ReactNode;
  readonly onPick: (status: SpaceTaskStatus) => void;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly align?: "start" | "end";
}) {
  return (
    <Menu
      {...(props.open === undefined ? {} : { open: props.open })}
      {...(props.onOpenChange === undefined ? {} : { onOpenChange: props.onOpenChange })}
    >
      <MenuTrigger render={props.trigger}>{props.children}</MenuTrigger>
      <MenuPopup align={props.align ?? "start"}>
        <MenuGroup>
          <MenuGroupLabel>Change status</MenuGroupLabel>
          {SPACE_TASK_STATUSES.map((info) => (
            <MenuItem
              key={info.status}
              aria-checked={info.status === props.status}
              onClick={() => props.onPick(info.status)}
              onKeyDown={(event) => handleSpaceStatusKey(event, props.onPick)}
            >
              <SpaceTaskStatusGlyph icon={info.icon} tone={info.tone} />
              {info.label}
              <MenuShortcut>{info.key}</MenuShortcut>
              <CheckIcon
                aria-hidden
                className={info.status === props.status ? "size-3.5" : "invisible size-3.5"}
              />
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
