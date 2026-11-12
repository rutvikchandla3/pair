import {
  SPACE_OVERVIEW_SECTIONS,
  type SpaceControls,
  type SpaceOverviewSectionId,
  type SpaceViewer,
  groupSpaceOverview,
  spaceTaskDetail,
} from "@t3tools/client-runtime/spaces";
import type { EnvironmentId, OrchestrationV2ThreadShell, Space } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { Maximize2Icon, Minimize2Icon, PanelRightCloseIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { spaceEnvironment } from "../../state/spaces";
import { useTeamMembers } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { RelativeTime } from "../RelativeTime";
import { MemberAvatar } from "../team/MemberAvatar";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Textarea } from "../ui/textarea";
import { SpaceStatusIcon } from "./SpaceStatusIcon";

export type SpacePanelTab = "overview" | "notes";

export function SpaceOverview(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly tasks: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly viewer: SpaceViewer;
  readonly canCreateTask: boolean;
  readonly onNewTask: () => void;
}) {
  const sections = groupSpaceOverview(props.tasks, props.viewer);
  const members = useTeamMembers(props.environmentId);
  const [collapsed, setCollapsed] = useState<ReadonlySet<SpaceOverviewSectionId>>(
    () => new Set(SPACE_OVERVIEW_SECTIONS.filter((s) => s.collapsedByDefault).map((s) => s.id)),
  );
  const toggle = (id: SpaceOverviewSectionId) => {
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    setCollapsed(next);
  };

  return (
    <div className="flex flex-col gap-1 p-2">
      {sections.length === 0 ? (
        <p className="px-2 py-6 text-center text-muted-foreground text-sm">
          No tasks yet. Tasks you and your teammates create here show up in this list.
        </p>
      ) : null}
      {sections.map((section) => {
        const expanded = !collapsed.has(section.id);
        return (
          <section key={section.id}>
            <CollapsibleSectionHeader
              expanded={expanded}
              tone={section.id === "needs-you" ? "accent" : "muted"}
              variant="panel"
              accessory={
                <span className="text-muted-foreground text-xs tabular-nums">
                  {section.rows.length}
                </span>
              }
              onClick={() => toggle(section.id)}
            >
              {section.label}
            </CollapsibleSectionHeader>
            {expanded
              ? section.rows.map(({ thread, status }) => (
                  <Link
                    key={thread.id}
                    to="/$environmentId/$threadId"
                    params={{ environmentId: props.environmentId, threadId: thread.id }}
                    className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
                  >
                    <span className="mt-0.5">
                      <SpaceStatusIcon icon={status.icon} tone={status.tone} label={status.label} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{thread.title}</span>
                      <TaskDetailLine
                        detail={spaceTaskDetail(thread, status, props.space, props.viewer)}
                        owner={thread.ownerId == null ? undefined : members.get(thread.ownerId)}
                      />
                    </span>
                    <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                      <RelativeTime timestamp={DateTime.formatIso(thread.updatedAt)} />
                    </span>
                  </Link>
                ))
              : null}
          </section>
        );
      })}
      {props.canCreateTask ? (
        <button
          type="button"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground text-sm hover:bg-accent hover:text-foreground"
          onClick={props.onNewTask}
        >
          <PlusIcon className="size-3.5" />
          New task
        </button>
      ) : null}
    </div>
  );
}

/** "for [K] Kousik · assigned by you": the owner's avatar leads their name. */
function TaskDetailLine(props: {
  readonly detail: string;
  readonly owner: { readonly name: string; readonly color: string } | undefined;
}) {
  const withOwner = props.owner !== undefined && props.detail.startsWith("for ");
  return (
    <span className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
      {withOwner && props.owner !== undefined ? (
        <>
          <span className="shrink-0">for</span>
          <MemberAvatar member={props.owner} size="sm" className="size-3.5" />
          <span className="truncate">{props.detail.slice(4)}</span>
        </>
      ) : (
        <span className="truncate">{props.detail}</span>
      )}
    </span>
  );
}

function SpaceNotes(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly canEdit: boolean;
}) {
  const mutate = useAtomCommand(spaceEnvironment.mutate, "Edit brief");
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (draft === null || saving) return;
    const brief = draft.trim();
    if (brief === props.space.brief) {
      setDraft(null);
      return;
    }
    setSaving(true);
    const result = await mutate({
      environmentId: props.environmentId,
      input: { type: "update", spaceId: props.space.id, brief },
    });
    setSaving(false);
    toastCommandFailure("Could not save the brief", result);
    if (result._tag === "Success") setDraft(null);
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <section className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-muted-foreground text-xs">Brief</h3>
          {props.canEdit && draft === null ? (
            <Button size="micro" variant="ghost-muted" onClick={() => setDraft(props.space.brief)}>
              Edit
            </Button>
          ) : null}
        </div>
        {draft === null ? (
          <p
            className={cn(
              "whitespace-pre-wrap text-sm",
              props.space.brief === "" && "text-muted-foreground",
            )}
          >
            {props.space.brief === ""
              ? "No brief yet. Pair reads it before every reply here."
              : props.space.brief}
          </p>
        ) : (
          <>
            <Textarea
              autoFocus
              value={draft}
              aria-label="Brief"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setDraft(null);
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save();
              }}
            />
            <div className="flex justify-end gap-2">
              <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button size="xs" disabled={saving} onClick={() => void save()}>
                Save
              </Button>
            </div>
          </>
        )}
      </section>
      {/* Seam: Pair's notes (edit and remove on hover) arrive with @pair; no contract yet. */}
      <section className="flex flex-col gap-1.5">
        <h3 className="font-medium text-muted-foreground text-xs">Pair's notes</h3>
        <p className="text-muted-foreground text-sm">
          Pair keeps notes here as it works in this space.
        </p>
      </section>
    </div>
  );
}

export function SpaceRoomPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly tasks: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly viewer: SpaceViewer;
  readonly controls: SpaceControls;
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
  readonly onHide: () => void;
  readonly onNewTask: () => void;
}) {
  const [tab, setTab] = useState<SpacePanelTab>("overview");
  return (
    <aside
      aria-label="Space panel"
      className={cn(
        "flex min-h-0 shrink-0 flex-col border-border border-l bg-background",
        props.expanded ? "w-[min(42rem,60%)]" : "w-80",
      )}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-border border-b px-2">
        <div role="tablist" className="flex flex-1 items-center gap-1">
          {(["overview", "notes"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={cn(
                "rounded-md px-2 py-1 text-sm",
                tab === id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setTab(id)}
            >
              {id === "overview" ? "Overview" : "Notes"}
            </button>
          ))}
        </div>
        {props.controls.canCreateTask ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="New task"
            onClick={props.onNewTask}
          >
            <PlusIcon />
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={props.expanded ? "Shrink panel" : "Expand panel"}
          onClick={props.onToggleExpanded}
        >
          {props.expanded ? <Minimize2Icon /> : <Maximize2Icon />}
        </Button>
        <Button size="icon-xs" variant="ghost-muted" aria-label="Hide panel" onClick={props.onHide}>
          <PanelRightCloseIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "overview" ? (
          <SpaceOverview
            environmentId={props.environmentId}
            space={props.space}
            tasks={props.tasks}
            viewer={props.viewer}
            canCreateTask={props.controls.canCreateTask}
            onNewTask={props.onNewTask}
          />
        ) : (
          <SpaceNotes
            environmentId={props.environmentId}
            space={props.space}
            canEdit={props.controls.canEditNotes}
          />
        )}
      </div>
    </aside>
  );
}
