import {
  SHARED_WITH_YOU_STATE_LABEL,
  SHARED_WITH_YOU_STATE_OPTIONS,
  sharedWithYouPersonOptions,
} from "@t3tools/client-runtime/inbox";
import { FORMER_MEMBER } from "@t3tools/client-runtime/state/team";
import type {
  EnvironmentId,
  MemberId,
  SharedWithYouItem,
  SharedWithYouListInput,
  SharedWithYouPerson,
  SharedWithYouState,
} from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, SearchIcon, Share2Icon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useSharedWithYouPages, useTeamEnvironmentIds } from "../../state/inbox";
import { usePresence } from "../../state/presence";
import { useSpaceViewer } from "../../state/spaces";
import { useTeamMembers } from "../../state/team";
import { RelativeTime } from "../RelativeTime";
import { MemberAvatar } from "../team/MemberAvatar";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ThreadFollowButton } from "./ThreadFollowButton";
import { TeamPage } from "./TeamPage";

const ANYONE = "anyone";
const ANY_STATE = "any";

/** Threads teammates shared with the viewer, by person; filtered and paged on the server. */
export function SharedWithYouPage() {
  const environmentId = useTeamEnvironmentIds()[0] ?? null;
  return (
    <TeamPage title="Shared with you">
      {environmentId === null ? (
        <SharedEmpty />
      ) : (
        <SharedWithYouBody environmentId={environmentId} />
      )}
    </TeamPage>
  );
}

function SharedEmpty() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia>
          <Share2Icon className="size-5 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>Nothing is shared with you by name</EmptyTitle>
        <EmptyDescription>Your spaces' threads are in each space.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

type Line =
  | { readonly kind: "person"; readonly person: SharedWithYouPerson; readonly collapsed: boolean }
  | { readonly kind: "thread"; readonly item: SharedWithYouItem };

function SharedWithYouBody(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(query, { wait: 250 });
  const [personId, setPersonId] = useState<MemberId | null>(null);
  const [state, setState] = useState<SharedWithYouState | null>(null);
  const [includeTaskThreads, setIncludeTaskThreads] = useState(false);
  const [pages, setPages] = useState({ key: "", count: 1 });
  const [collapsed, setCollapsed] = useState<ReadonlySet<MemberId>>(() => new Set());
  const viewer = useSpaceViewer(environmentId);
  const filters: Omit<SharedWithYouListInput, "cursor" | "limit"> = {
    ...(debouncedQuery.trim() === "" ? {} : { query: debouncedQuery.trim() }),
    ...(personId === null ? {} : { personId }),
    ...(state === null ? {} : { state }),
    ...(includeTaskThreads ? { includeTaskThreads: true } : {}),
  };
  // New filters start from the first page.
  const filtersKey = JSON.stringify(filters);
  const pageCount = pages.key === filtersKey ? pages.count : 1;
  const view = useSharedWithYouPages(environmentId, filters, pageCount);
  const filtered = Object.keys(filters).length > 0;
  const people = sharedWithYouPersonOptions(view.people, viewer);

  const byPerson = new Map<MemberId, SharedWithYouItem[]>();
  for (const item of view.items) {
    const list = byPerson.get(item.ownerId);
    if (list === undefined) byPerson.set(item.ownerId, [item]);
    else list.push(item);
  }
  const lines: Line[] = view.people.flatMap((person): Line[] => {
    const shut = collapsed.has(person.memberId);
    return [
      { kind: "person", person, collapsed: shut },
      ...(shut
        ? []
        : (byPerson.get(person.memberId) ?? []).map((item): Line => ({ kind: "thread", item }))),
    ];
  });
  const toggle = (memberId: MemberId) => {
    const next = new Set(collapsed);
    if (!next.delete(memberId)) next.add(memberId);
    setCollapsed(next);
  };

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="min-w-48 flex-1">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            size="sm"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Filter by title"
            aria-label="Filter by title"
          />
        </InputGroup>
        <Select
          value={personId ?? ANYONE}
          onValueChange={(value) => setPersonId(value === ANYONE ? null : (value as MemberId))}
        >
          <SelectTrigger size="sm" aria-label="Person">
            <SelectValue>
              {personId === null
                ? "Anyone"
                : (people.find((option) => option.value === personId)?.label ??
                  viewer.nameOf(personId))}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={ANYONE}>Anyone</SelectItem>
            {people.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          value={state ?? ANY_STATE}
          onValueChange={(value) =>
            setState(
              SHARED_WITH_YOU_STATE_OPTIONS.find((option) => option.value === value)?.value ?? null,
            )
          }
        >
          <SelectTrigger size="sm" aria-label="State">
            <SelectValue>
              {state === null ? "Any state" : SHARED_WITH_YOU_STATE_LABEL[state]}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={ANY_STATE}>Any state</SelectItem>
            {SHARED_WITH_YOU_STATE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            size="sm"
            checked={includeTaskThreads}
            onCheckedChange={(checked) => setIncludeTaskThreads(checked)}
          />
          Include task threads
        </label>
      </div>
      {lines.length === 0 ? (
        view.loading ? null : view.error !== null ? (
          <p className="text-muted-foreground text-sm">{view.error}</p>
        ) : filtered ? (
          <p className="py-6 text-center text-muted-foreground text-sm">No threads match.</p>
        ) : (
          <SharedEmpty />
        )
      ) : (
        // Shared lists grow with the team; only the rows in view are mounted.
        <LegendList<Line>
          data={lines}
          keyExtractor={(line) =>
            line.kind === "person" ? `person:${line.person.memberId}` : line.item.threadId
          }
          getItemType={(line) => line.kind}
          renderItem={({ item: line }) =>
            line.kind === "person" ? (
              <PersonHeader
                environmentId={environmentId}
                person={line.person}
                collapsed={line.collapsed}
                onToggle={() => toggle(line.person.memberId)}
              />
            ) : (
              <SharedRow environmentId={environmentId} item={line.item} />
            )
          }
          estimatedItemSize={52}
          drawDistance={520}
          onEndReached={() => {
            if (view.hasMore) setPages({ key: filtersKey, count: pageCount + 1 });
          }}
          onEndReachedThreshold={0.5}
          className="min-h-0 flex-1 overscroll-contain"
        />
      )}
    </div>
  );
}

function PersonHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly person: SharedWithYouPerson;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}) {
  const members = useTeamMembers(props.environmentId);
  const presence = usePresence(props.environmentId).members.get(props.person.memberId);
  const member = members.get(props.person.memberId) ?? FORMER_MEMBER;
  return (
    <button
      type="button"
      aria-expanded={!props.collapsed}
      onClick={props.onToggle}
      className="mt-2 flex w-full items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-left text-sm"
    >
      <ChevronDownIcon
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          props.collapsed && "-rotate-90",
        )}
      />
      <span className="relative inline-flex shrink-0">
        <MemberAvatar member={member} size="sm" />
        {presence === undefined ? null : (
          <span
            aria-label={presence === "online" ? "Online" : "Away"}
            className={cn(
              "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-muted",
              presence === "online" ? "bg-success" : "bg-muted-foreground",
            )}
          />
        )}
      </span>
      <span className="truncate">{member.name}</span>
      <span className="text-muted-foreground text-xs tabular-nums">{props.person.count}</span>
    </button>
  );
}

function SharedRow(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SharedWithYouItem;
}) {
  const { item } = props;
  const thread = { environmentId: props.environmentId, threadId: item.threadId };
  return (
    <div className="group/shared relative flex items-center gap-2 rounded-md px-2.5 py-2 ps-9 hover:bg-accent/60">
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId: props.environmentId, threadId: item.threadId }}
        className="min-w-0 flex-1 after:absolute after:inset-0 focus-visible:outline-none"
      >
        <span className="block truncate text-sm">{item.title}</span>
        <span className="block truncate text-muted-foreground text-xs">
          {SHARED_WITH_YOU_STATE_LABEL[item.state]}
        </span>
      </Link>
      <ThreadFollowButton
        thread={thread}
        className="relative hidden group-focus-within/shared:inline-flex group-hover/shared:inline-flex"
      />
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
        <RelativeTime timestamp={item.lastActivityAt} />
      </span>
    </div>
  );
}
