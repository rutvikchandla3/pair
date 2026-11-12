import { groupSpaceNotes, spaceNoteByline } from "@t3tools/client-runtime/spaceAgent";
import {
  SPACE_OVERVIEW_SECTIONS,
  type SpaceControls,
  type SpaceOverviewSectionId,
  type SpaceViewer,
  groupSpaceOverview,
  spaceTaskDetail,
} from "@t3tools/client-runtime/spaces";
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  Space,
  SpaceNoteChange,
  SpaceNoteItem,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { Maximize2Icon, Minimize2Icon, PanelRightCloseIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { spaceAgentEnvironment } from "../../state/spaceAgent";
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

function SpacePairNote(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly note: SpaceNoteItem;
  readonly viewer: SpaceViewer;
  readonly canEdit: boolean;
}) {
  const { note } = props;
  const change = useAtomCommand(spaceAgentEnvironment.notes, "Edit Pair's notes");
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (next: SpaceNoteChange, label: string) => {
    setBusy(true);
    const result = await change({
      environmentId: props.environmentId,
      input: { spaceId: props.space.id, changes: [next] },
    });
    setBusy(false);
    toastCommandFailure(label, result);
    if (result._tag === "Success") setDraft(null);
  };
  const save = () => {
    const text = draft?.trim() ?? "";
    if (text === "" || text === note.text) return setDraft(null);
    void send(
      { op: "edit", noteId: note.id, version: note.version, text },
      "Could not save the note",
    );
  };

  if (draft !== null) {
    return (
      <li className="flex flex-col gap-1.5">
        <Textarea
          autoFocus
          value={draft}
          aria-label="Note"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setDraft(null);
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save();
          }}
        />
        <div className="flex justify-end gap-2">
          <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
            Cancel
          </Button>
          <Button size="xs" disabled={busy} onClick={save}>
            Save
          </Button>
        </div>
      </li>
    );
  }
  return (
    <li className="group/note flex flex-col gap-0.5">
      <p className="whitespace-pre-wrap text-sm">{note.text}</p>
      <div className="flex min-h-5 items-center gap-1 text-muted-foreground text-xs">
        <span className="min-w-0 flex-1 truncate">{spaceNoteByline(note, props.viewer)}</span>
        {props.canEdit ? (
          <span className="flex gap-0.5 opacity-0 group-focus-within/note:opacity-100 group-hover/note:opacity-100">
            <Button size="micro" variant="ghost-muted" onClick={() => setDraft(note.text)}>
              Edit
            </Button>
            <Button
              size="micro"
              variant="ghost-destructive"
              disabled={busy}
              onClick={() =>
                void send(
                  { op: "remove", noteId: note.id, version: note.version },
                  "Could not remove the note",
                )
              }
            >
              Remove
            </Button>
          </span>
        ) : null}
      </div>
    </li>
  );
}

function SpaceNotes(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly notes: ReadonlyArray<SpaceNoteItem>;
  readonly viewer: SpaceViewer;
  readonly canEdit: boolean;
}) {
  const sections = groupSpaceNotes(props.notes);
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
      {sections.length === 0 ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="font-medium text-muted-foreground text-xs">Pair's notes</h3>
          <p className="text-muted-foreground text-sm">
            Pair adds decisions here as the room talks. You can edit or remove any of them.
          </p>
        </section>
      ) : (
        sections.map((section) => (
          <section key={section.id} className="flex flex-col gap-1.5">
            <h3 className="font-medium text-muted-foreground text-xs">{section.label}</h3>
            <ul className="flex flex-col gap-3">
              {section.notes.map((note) => (
                <SpacePairNote
                  key={note.id}
                  environmentId={props.environmentId}
                  space={props.space}
                  note={note}
                  viewer={props.viewer}
                  canEdit={props.canEdit}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

export function SpaceRoomPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly tasks: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly notes: ReadonlyArray<SpaceNoteItem>;
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
            notes={props.notes}
            viewer={props.viewer}
            canEdit={props.controls.canEditNotes}
          />
        )}
      </div>
    </aside>
  );
}
