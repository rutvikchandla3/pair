import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  MemberId,
  OrchestrationV2ThreadShell,
  SpaceId,
  ThreadId,
} from "@t3tools/contracts";

/**
 * The space whose row is selected: the open room or task page's, or the space of the open
 * thread's task. Null anywhere else, and in other environments.
 */
export function sidebarSelectedSpaceId(input: {
  readonly environmentId: EnvironmentId;
  readonly route: {
    readonly environmentId?: string | undefined;
    readonly spaceId?: string | undefined;
    readonly threadId?: string | undefined;
  };
  readonly threadSpaceId: (threadId: ThreadId) => SpaceId | null;
}): SpaceId | null {
  const { route } = input;
  if (route.environmentId !== input.environmentId) return null;
  if (route.spaceId !== undefined) return route.spaceId as SpaceId;
  return route.threadId === undefined ? null : input.threadSpaceId(route.threadId as ThreadId);
}

/** The order after dragging `activeId` onto `overId`; unchanged when either is unknown. */
export function reorderSidebarSpaces(
  ids: ReadonlyArray<SpaceId>,
  activeId: SpaceId,
  overId: SpaceId,
): ReadonlyArray<SpaceId> {
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from === -1 || to === -1 || from === to) return ids;
  const next = ids.filter((id) => id !== activeId);
  next.splice(to, 0, activeId);
  return next;
}

type LineageShell = Pick<OrchestrationV2ThreadShell, "space" | "branchLink">;

export type SidebarThreadLead =
  | { readonly glyph: "branch"; readonly label: string }
  | { readonly glyph: "space"; readonly label: string };

/**
 * The glyph a Threads row leads with: a branch's, else a space task thread's, whose tooltip
 * names the space and task ("Question creation › Seed role catalog").
 */
export function sidebarThreadLead(
  shell: LineageShell,
  names: {
    readonly spaceName: (spaceId: SpaceId) => string | null;
    readonly taskTitle: (taskId: string) => string | null;
  },
): SidebarThreadLead | null {
  const source = shell.branchLink?.source;
  if (source != null) {
    return {
      glyph: "branch",
      label:
        source.title === null
          ? "Branched from a thread you can't open"
          : `Branched from ${source.title}`,
    };
  }
  const space = shell.space;
  if (space?.kind !== "task") return null;
  const spaceName = names.spaceName(space.spaceId) ?? "A space";
  const taskTitle = names.taskTitle(space.taskId);
  return { glyph: "space", label: taskTitle === null ? spaceName : `${spaceName} › ${taskTitle}` };
}

type BranchShell = {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly source: Pick<OrchestrationV2ThreadShell, "branchLink" | "ownerId">;
};

/**
 * Who branched each source the viewer can see, by the source's thread key: the branches'
 * owners joined with commas, first branch first, each once.
 */
export function sidebarBranchOwnersBySource(
  shells: ReadonlyArray<BranchShell>,
): ReadonlyMap<string, string> {
  const owners = new Map<string, MemberId[]>();
  for (const shell of shells) {
    const sourceId = shell.source.branchLink?.source?.threadId;
    const ownerId = shell.source.ownerId;
    if (sourceId == null || ownerId == null) continue;
    const key = scopedThreadKey(scopeThreadRef(shell.environmentId, sourceId));
    const list = owners.get(key);
    if (list === undefined) owners.set(key, [ownerId]);
    else if (!list.includes(ownerId)) list.push(ownerId);
  }
  return new Map([...owners].map(([key, ids]) => [key, ids.join(",")]));
}
