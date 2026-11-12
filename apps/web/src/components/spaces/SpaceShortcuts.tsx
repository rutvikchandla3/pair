import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, Space, SpaceId, ThreadId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { registerCommands } from "../../shortcuts/dispatcher";
import { openSpaceDialog } from "../../spaceDialogStore";
import { useThreadShell } from "../../state/entities";
import { useCanOperateSpaces, useSpaceEnvironmentIds, useSpaceList } from "../../state/spaces";

export interface SpaceShortcutTarget {
  /** Where New space creates one; null without Pair Cloud. */
  readonly environmentId: EnvironmentId | null;
  /** The open room's or task's space, for New task. */
  readonly space: { readonly environmentId: EnvironmentId; readonly spaceId: SpaceId } | null;
  /** Spaces the palette can open, with the environment they live on. */
  readonly spaces: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly space: Space }>;
}

export function useSpaceShortcutTarget(): SpaceShortcutTarget {
  const params = useParams({ strict: false }) as {
    readonly environmentId?: string;
    readonly spaceId?: string;
    readonly threadId?: string;
  };
  const environmentIds = useSpaceEnvironmentIds();
  const routeEnvironmentId = (params.environmentId ?? null) as EnvironmentId | null;
  const shell = useThreadShell(
    routeEnvironmentId !== null && params.threadId !== undefined
      ? scopeThreadRef(routeEnvironmentId, params.threadId as ThreadId)
      : null,
  );
  const environmentId =
    routeEnvironmentId !== null && environmentIds.includes(routeEnvironmentId)
      ? routeEnvironmentId
      : (environmentIds[0] ?? null);
  const canOperate = useCanOperateSpaces(environmentId);
  const spaces = useSpaceList(environmentId);
  const spaceId = (params.spaceId as SpaceId | undefined) ?? shell?.source.space?.spaceId ?? null;
  return {
    environmentId: canOperate ? environmentId : null,
    space:
      canOperate &&
      routeEnvironmentId !== null &&
      spaceId !== null &&
      environmentIds.includes(routeEnvironmentId)
        ? { environmentId: routeEnvironmentId, spaceId }
        : null,
    spaces: environmentId === null ? [] : spaces.map((space) => ({ environmentId, space })),
  };
}

/** `space.new` and `space.newTask`, wherever a space can take them. */
export function SpaceShortcuts() {
  const target = useSpaceShortcutTarget();
  const environmentId = target.environmentId;
  const spaceEnvironmentId = target.space?.environmentId ?? null;
  const spaceId = target.space?.spaceId ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers handlers with the app's keyboard dispatcher for the current target
  useEffect(
    () =>
      registerCommands({
        "space.new": (event) => {
          if (environmentId === null) return false;
          event.preventDefault();
          if (!event.repeat) openSpaceDialog({ type: "new-space", environmentId });
        },
        "space.newTask": (event) => {
          if (spaceEnvironmentId === null || spaceId === null) return false;
          event.preventDefault();
          if (!event.repeat) {
            openSpaceDialog({ type: "new-task", environmentId: spaceEnvironmentId, spaceId });
          }
        },
      }),
    [environmentId, spaceEnvironmentId, spaceId],
  );
  return null;
}
