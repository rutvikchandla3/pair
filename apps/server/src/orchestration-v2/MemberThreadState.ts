import * as DateTime from "effect/DateTime";
import type {
  MemberId,
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadShell,
  ThreadMemberState,
} from "@t3tools/contracts";

/**
 * A thread's holder (its owner, else the server owner) keeps personal state in the thread row;
 * every other member's lives in `projection_thread_member_state`. See the 1c design.
 */
export const EMPTY_MEMBER_STATE: ThreadMemberState = {
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
  lastVisitedAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  lastSnoozeWakeAt: null,
  opens: null,
  followedAt: null,
};

export type PersonalStateCarrier = OrchestrationV2AppThread | OrchestrationV2ThreadShell;

export type ThreadPayloadEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly payload: OrchestrationV2AppThread }
>;

type ThreadChangeEvent = Exclude<ThreadPayloadEvent, { readonly type: "thread.created" }>;

export type MemberThreadEvent = ThreadChangeEvent & {
  readonly member: NonNullable<ThreadChangeEvent["member"]>;
};

// Shells have no `lastSnoozeWakeAt`; adding it would put a field on the wire the schema lacks.
const isShell = (row: PersonalStateCarrier): row is OrchestrationV2ThreadShell =>
  "itemCount" in row;

export function personalStateOf(row: PersonalStateCarrier): ThreadMemberState {
  return {
    pinnedAt: row.pinnedAt ?? null,
    pinOrderKey: row.pinOrderKey ?? null,
    activeOrderKey: row.activeOrderKey ?? null,
    lastVisitedAt: row.lastVisitedAt ?? null,
    snoozedUntil: row.snoozedUntil ?? null,
    snoozedAt: row.snoozedAt ?? null,
    lastSnoozeWakeAt: isShell(row) ? null : (row.lastSnoozeWakeAt ?? null),
    opens: row.opens ?? null,
    followedAt: row.followedAt ?? null,
    ...(isShell(row) || row.followSource == null ? {} : { followSource: row.followSource }),
  };
}

/**
 * `followedAt` and `followSource` are written only when set, so holder rows and solo payloads
 * never carry the keys. Shells never carry `followSource`.
 */
export function withPersonalState<T extends PersonalStateCarrier>(
  row: T,
  state: ThreadMemberState,
): T {
  const { lastSnoozeWakeAt, followedAt, followSource, ...shared } = state;
  const { followedAt: _previous, ...rest } = row;
  const next = { ...rest, ...shared, ...(followedAt === null ? {} : { followedAt }) };
  if (isShell(row)) return next as T;
  const { followSource: _previousSource, ...thread } = next as OrchestrationV2AppThread;
  return {
    ...thread,
    lastSnoozeWakeAt,
    ...(followSource == null ? {} : { followSource }),
  } as T;
}

/** Following baselines the visit watermark, so the next completion reads as unread. */
export function followedView<T extends PersonalStateCarrier>(view: T, now: DateTime.Utc): T {
  if (view.followedAt != null) return view;
  return { ...view, followedAt: now, lastVisitedAt: view.lastVisitedAt ?? now };
}

/** Sending follows, marked to end on its own; an existing follow keeps its kind. */
export function promptFollowedView(
  view: OrchestrationV2AppThread,
  now: DateTime.Utc,
): OrchestrationV2AppThread {
  if (view.followedAt != null) return view;
  return { ...followedView(view, now), followSource: "prompt" };
}

/** An explicit Follow or Pin keeps a prompt's follow until the member undoes it. */
export function permanentFollowView(view: OrchestrationV2AppThread): OrchestrationV2AppThread {
  if (view.followSource == null) return view;
  const { followSource: _source, ...rest } = view;
  return rest;
}

/**
 * A prompt's follow ends once the member's latest run on the thread has ended and they have read
 * the thread since. `latestRun` is null when they have no run there.
 */
export function promptFollowEnds(
  view: Pick<OrchestrationV2AppThread, "followedAt" | "followSource" | "lastVisitedAt">,
  latestRun: { readonly completedAt: DateTime.Utc | null } | null,
): boolean {
  if (view.followedAt == null || view.followSource !== "prompt") return false;
  if (latestRun === null) return true;
  return (
    latestRun.completedAt !== null &&
    view.lastVisitedAt != null &&
    DateTime.toEpochMillis(view.lastVisitedAt) >= DateTime.toEpochMillis(latestRun.completedAt)
  );
}

export function unfollowedView(view: OrchestrationV2AppThread): OrchestrationV2AppThread {
  const { followSource: _source, ...rest } = view;
  return { ...rest, followedAt: null };
}

export function holderOf(
  thread: Pick<PersonalStateCarrier, "ownerId">,
  serverOwnerId: MemberId,
): MemberId {
  return thread.ownerId ?? serverOwnerId;
}

/** The row as `viewer` sees it; null viewers (guests, member-less readers) see the holder's view. */
export function viewFor<T extends PersonalStateCarrier>(
  row: T,
  viewer: MemberId | null,
  memberState: ThreadMemberState | null,
  serverOwnerId: MemberId,
): T {
  if (viewer === null || viewer === holderOf(row, serverOwnerId)) return row;
  return withPersonalState(row, memberState ?? EMPTY_MEMBER_STATE);
}

/**
 * Pin, order or snooze: the state settle clears and auto-settle respects. Visits, opens and
 * follows are not.
 */
export function hasPersonalState(state: ThreadMemberState): boolean {
  return (
    state.pinnedAt !== null ||
    state.pinOrderKey !== null ||
    state.activeOrderKey !== null ||
    state.snoozedUntil !== null ||
    state.snoozedAt !== null
  );
}

/** Settling also ends a follow that prompting added. */
export function clearedForSettle(state: ThreadMemberState): ThreadMemberState {
  const { followSource, ...rest } = state;
  return {
    ...rest,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    snoozedUntil: null,
    snoozedAt: null,
    ...(followSource === "prompt" ? { followedAt: null } : {}),
  };
}

function permanentState(state: ThreadMemberState): ThreadMemberState {
  const { followSource: _source, ...rest } = state;
  return rest;
}

export function changesOnSettle(state: ThreadMemberState): boolean {
  return hasPersonalState(state) || state.followSource === "prompt";
}

/**
 * Ownership moves from `oldHolderId` to a new holder: the row takes the new holder's member state
 * (empty without one) minus their follow, and the old holder's row state becomes their member row,
 * following. The caller sets `ownerId` and deletes the new holder's member row.
 */
export function transferHolder<T extends PersonalStateCarrier>(
  row: T,
  oldHolderId: MemberId,
  newHolderState: ThreadMemberState | null,
  now: DateTime.Utc,
): {
  readonly row: T;
  readonly demoted: { readonly memberId: MemberId; readonly state: ThreadMemberState };
} {
  return {
    row: withPersonalState(row, {
      ...permanentState(newHolderState ?? EMPTY_MEMBER_STATE),
      followedAt: null,
    }),
    demoted: {
      memberId: oldHolderId,
      state: { ...permanentState(personalStateOf(row)), followedAt: now },
    },
  };
}

export function isThreadPayloadEvent(
  event: OrchestrationV2DomainEvent,
): event is ThreadPayloadEvent {
  return event.type.startsWith("thread.") && event.type !== "thread.pull-request-link-updated";
}

export function isMemberThreadEvent(event: OrchestrationV2DomainEvent): event is MemberThreadEvent {
  return isThreadPayloadEvent(event) && "member" in event && event.member !== undefined;
}

/** True when the event changes only a non-holder's member row; such events never touch the thread row. */
export function isNonHolderMemberEvent(
  event: OrchestrationV2DomainEvent,
  serverOwnerId: MemberId,
): event is MemberThreadEvent {
  return (
    isMemberThreadEvent(event) && event.member.memberId !== holderOf(event.payload, serverOwnerId)
  );
}

/**
 * Maps one thread-stream event for `viewer`, threading the viewer's member state through `cache`
 * (seed it with `getThreadMemberState`, null when absent). `event` is null when the viewer must not
 * see it. The returned event never carries `member`.
 */
export function viewThreadEvent(
  event: OrchestrationV2DomainEvent,
  viewer: MemberId | null,
  serverOwnerId: MemberId,
  cache: ThreadMemberState | null,
): { readonly event: OrchestrationV2DomainEvent | null; readonly cache: ThreadMemberState | null } {
  if (isMemberThreadEvent(event)) {
    if (event.member.memberId !== viewer) return { event: null, cache };
    const { member, ...stripped } = event;
    return { event: stripped, cache: member.state };
  }
  if (!isThreadPayloadEvent(event)) return { event, cache };
  if (viewer === null || viewer === holderOf(event.payload, serverOwnerId)) return { event, cache };
  return {
    event: { ...event, payload: withPersonalState(event.payload, cache ?? EMPTY_MEMBER_STATE) },
    cache,
  };
}
