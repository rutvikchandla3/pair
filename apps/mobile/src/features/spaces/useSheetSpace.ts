import { spaceControls } from "@t3tools/client-runtime/spaces";
import { EnvironmentId, SpaceId } from "@t3tools/contracts";

import {
  useCanOperateSpaces,
  useSpaceRoom,
  useSpaceTasks,
  useSpaceViewer,
} from "../../state/spaces";

export type SpaceSheetParams = { readonly environmentId: string; readonly spaceId: string };

const NO_TASKS: never[] = [];

/** The open space a sheet over the room acts on; `space` is null until the room is a member's. */
export function useSheetSpace(params: SpaceSheetParams) {
  const environmentId = EnvironmentId.make(params.environmentId);
  const spaceId = SpaceId.make(params.spaceId);
  const result = useSpaceRoom(environmentId, spaceId);
  const viewer = useSpaceViewer(environmentId);
  const canOperate = useCanOperateSpaces(environmentId);
  const room = result.type === "ready" && result.room.type === "member" ? result.room : null;
  const tasks = useSpaceTasks(environmentId, spaceId, room?.tasks ?? NO_TASKS);
  const space = room?.space ?? null;
  return {
    environmentId,
    spaceId,
    viewer,
    canOperate,
    space,
    tasks,
    controls: space === null ? null : spaceControls(space, viewer.memberId, canOperate),
  };
}
