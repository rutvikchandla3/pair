import { type MyTaskGroup, myTaskRows, myTaskSections } from "@t3tools/client-runtime/inbox";
import {
  type SpaceOverviewRow,
  type SpaceViewer,
  spaceThreadsByTask,
} from "@t3tools/client-runtime/spaces";
import type { EnvironmentId, OrchestrationV2ThreadShell, Space } from "@t3tools/contracts";
import { ListTodoIcon, UsersRoundIcon } from "lucide-react";
import { useState } from "react";

import { useClosedMyTasks, useTeamEnvironmentIds } from "../../state/inbox";
import { useCurrentMemberId } from "../../state/team";
import {
  useCanOperateSpaces,
  useSpaceListResult,
  useSpaceSidebarShells,
  useSpaceViewer,
} from "../../state/spaces";
import { SpaceOverviewTaskRow } from "../spaces/SpaceRoomPanel";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { TeamPage } from "./TeamPage";

/** The open tasks the viewer owns across their spaces, by status or by space. */
export function MyTasksPage() {
  const environmentId = useTeamEnvironmentIds()[0] ?? null;
  const [groupBySpace, setGroupBySpace] = useState(false);
  const list = useSpaceListResult(environmentId);
  const memberId = useCurrentMemberId(environmentId);
  const open =
    memberId === null
      ? 0
      : myTaskSections({ ...list, memberId, groupBySpace: false }).reduce(
          (total, section) =>
            total + section.groups.reduce((sum, group) => sum + group.tasks.length, 0),
          0,
        );
  return (
    <TeamPage
      title="My tasks"
      meta={open > 0 ? `${open} open` : undefined}
      actions={
        <>
          <span className="text-muted-foreground text-xs">Group by</span>
          <ToggleGroup
            aria-label="Group by"
            value={[groupBySpace ? "space" : "status"]}
            onValueChange={(next) => {
              if (next[0] === "space" || next[0] === "status") setGroupBySpace(next[0] === "space");
            }}
          >
            <Toggle value="status">Status</Toggle>
            <Toggle value="space">Space</Toggle>
          </ToggleGroup>
        </>
      }
    >
      {environmentId === null ? (
        <MyTasksEmpty />
      ) : (
        <MyTasksBody environmentId={environmentId} groupBySpace={groupBySpace} />
      )}
    </TeamPage>
  );
}

function MyTasksEmpty() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia>
          <ListTodoIcon className="size-5 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>No open tasks</EmptyTitle>
        <EmptyDescription>Tasks you own in any space show up here.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function MyTasksBody(props: {
  readonly environmentId: EnvironmentId;
  readonly groupBySpace: boolean;
}) {
  const { environmentId } = props;
  const list = useSpaceListResult(environmentId);
  const viewer = useSpaceViewer(environmentId);
  const shells = useSpaceSidebarShells(environmentId);
  const canOperate = useCanOperateSpaces(environmentId);
  const closedTasks = useClosedMyTasks(environmentId);
  // Groups the viewer flipped from their default: Done and Canceled start collapsed.
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(() => new Set());
  if (viewer.memberId === null) return <MyTasksEmpty />;
  const sections = myTaskSections({
    spaces: list.spaces,
    tasks: list.tasks,
    closedTasks,
    memberId: viewer.memberId,
    groupBySpace: props.groupBySpace,
  });
  if (sections.length === 0) return <MyTasksEmpty />;
  const open = sections.some((section) =>
    section.groups.some((group) => group.status !== "done" && group.status !== "canceled"),
  );
  const threadsByTask = spaceThreadsByTask(shells.taskThreads);
  const spaceById = new Map(list.spaces.map((space) => [space.id, space]));
  const toggle = (key: string) => {
    const next = new Set(flipped);
    if (!next.delete(key)) next.add(key);
    setFlipped(next);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
      <div className="mx-auto flex max-w-3xl flex-col gap-2 p-4">
        {open ? null : <MyTasksEmpty />}
        {sections.map((section) => (
          <section key={section.space?.id ?? "all"} className="flex flex-col gap-1">
            {section.space === null ? null : (
              <h2 className="flex items-center gap-1.5 px-2 pt-2 font-medium text-sm">
                <UsersRoundIcon className="size-3.5 text-muted-foreground" />
                {section.space.name}
              </h2>
            )}
            {section.groups.map((group) => {
              const key = `${section.space?.id ?? "all"}:${group.status}`;
              return (
                <TaskGroup
                  key={key}
                  environmentId={environmentId}
                  group={group}
                  expanded={group.collapsed === flipped.has(key)}
                  onToggle={() => toggle(key)}
                  rows={myTaskRows(group.tasks, threadsByTask, viewer)}
                  spaceById={spaceById}
                  showSpace={section.space === null}
                  viewer={viewer}
                  canSetStatus={canOperate}
                />
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

function TaskGroup(props: {
  readonly environmentId: EnvironmentId;
  readonly group: MyTaskGroup;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly rows: ReadonlyArray<SpaceOverviewRow<OrchestrationV2ThreadShell>>;
  readonly spaceById: ReadonlyMap<string, Space>;
  readonly showSpace: boolean;
  readonly viewer: SpaceViewer;
  readonly canSetStatus: boolean;
}) {
  return (
    <div>
      <CollapsibleSectionHeader
        expanded={props.expanded}
        variant="panel"
        accessory={
          <span className="text-muted-foreground text-xs tabular-nums">
            {props.group.tasks.length}
          </span>
        }
        onClick={props.onToggle}
      >
        {props.group.label}
      </CollapsibleSectionHeader>
      {props.expanded
        ? props.rows.map((row) => {
            const space = props.spaceById.get(row.task.spaceId);
            if (space === undefined) return null;
            return (
              <SpaceOverviewTaskRow
                key={row.task.id}
                environmentId={props.environmentId}
                space={space}
                row={row}
                viewer={props.viewer}
                canSetStatus={props.canSetStatus}
                selected={false}
                trailing={
                  props.showSpace ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                      <UsersRoundIcon className="size-3" />
                      {space.name}
                    </span>
                  ) : null
                }
              />
            );
          })
        : null}
    </div>
  );
}
