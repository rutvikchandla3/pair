import type {
  EnvironmentId,
  MemberId,
  PresenceStatus,
  PresenceUpdate,
  TeamMember,
  ThreadId,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { subscribeDynamicWithSession } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createEnvironmentRpcCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";
import type { TeamMembers } from "./team.ts";

/** Other members only: the server never includes the viewer's own member. */
export interface PresenceState {
  readonly members: ReadonlyMap<MemberId, PresenceStatus>;
  readonly viewers: ReadonlyMap<ThreadId, ReadonlyArray<MemberId>>;
  readonly typing: ReadonlyMap<ThreadId, ReadonlyArray<MemberId>>;
}

export const EMPTY_PRESENCE: PresenceState = {
  members: new Map(),
  viewers: new Map(),
  typing: new Map(),
};

export interface PresentMember extends Pick<TeamMember, "name" | "color"> {
  readonly id: MemberId;
  readonly away: boolean;
}

/** Roster members for these ids, with away flags; members not on the roster are skipped. */
export function presentMembers(
  members: TeamMembers,
  presence: PresenceState,
  memberIds: ReadonlyArray<MemberId> | undefined,
): PresentMember[] {
  return (memberIds ?? []).flatMap((id) => {
    const member = members.get(id);
    return member === undefined
      ? []
      : [
          {
            id,
            name: member.name,
            color: member.color,
            away: presence.members.get(id) === "away",
          },
        ];
  });
}

/** The composer's typing line for the members typing in a thread. */
export function presenceTypingText(names: ReadonlyArray<string>): string {
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return `${names.length} people are typing`;
}

const sameIds = (left: ReadonlyArray<MemberId>, right: ReadonlyArray<MemberId>) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

function replaceThreadMembers(
  current: ReadonlyMap<ThreadId, ReadonlyArray<MemberId>>,
  entries: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly memberIds: ReadonlyArray<MemberId>;
  }>,
) {
  let next: Map<ThreadId, ReadonlyArray<MemberId>> | undefined;
  for (const { threadId, memberIds } of entries) {
    const previous = (next ?? current).get(threadId);
    if (memberIds.length === 0) {
      if (previous === undefined) continue;
      next ??= new Map(current);
      next.delete(threadId);
    } else if (previous === undefined || !sameIds(previous, memberIds)) {
      next ??= new Map(current);
      next.set(threadId, memberIds);
    }
  }
  return next ?? current;
}

function replaceMembers(
  current: ReadonlyMap<MemberId, PresenceStatus>,
  members: NonNullable<PresenceUpdate["members"]>,
) {
  const unchanged =
    members.length === current.size &&
    members.every(({ memberId, status }) => current.get(memberId) === status);
  return unchanged
    ? current
    : new Map(members.map(({ memberId, status }) => [memberId, status] as const));
}

/** Each key replaces what it names; `[]` removes a thread, and unchanged values keep identity. */
export function applyPresenceUpdate(state: PresenceState, update: PresenceUpdate): PresenceState {
  const members =
    update.members === undefined ? state.members : replaceMembers(state.members, update.members);
  const viewers =
    update.viewers === undefined
      ? state.viewers
      : replaceThreadMembers(state.viewers, update.viewers);
  const typing =
    update.typing === undefined
      ? state.typing
      : replaceThreadMembers(state.typing, [update.typing]);
  return members === state.members && viewers === state.viewers && typing === state.typing
    ? state
    : { members, viewers, typing };
}

export interface PresenceSessionState<Session> {
  readonly session: Session | null;
  readonly presence: PresenceState;
}

/**
 * Follows the environment's current RPC session (`update` absent) and its updates. A new session
 * starts empty, because a server with nothing to say sends no reset; updates from a session that
 * is no longer current are dropped.
 */
export function applyPresenceSessionEvent<Session>(
  state: PresenceSessionState<Session>,
  session: Session | null,
  update?: PresenceUpdate,
): PresenceSessionState<Session> {
  if (update === undefined) {
    return session === state.session ? state : { session, presence: EMPTY_PRESENCE };
  }
  if (session !== state.session) return state;
  const presence = applyPresenceUpdate(state.presence, update);
  return presence === state.presence ? state : { session, presence };
}

const presenceStream = Stream.unwrap(
  Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const sessions = SubscriptionRef.changes(supervisor.session).pipe(
      Stream.map((session) => [Option.getOrNull(session), undefined] as const),
    );
    const updates = subscribeDynamicWithSession(WS_METHODS.presenceSubscribe, () =>
      Effect.succeed({}),
    );
    const initial: PresenceSessionState<RpcSession> = { session: null, presence: EMPTY_PRESENCE };
    return Stream.merge(sessions, updates).pipe(
      Stream.mapAccum(
        () => initial,
        (state, [session, update]: readonly [RpcSession | null, PresenceUpdate | undefined]) => {
          const next = applyPresenceSessionEvent(state, session, update);
          return [next, next.presence === state.presence ? [] : [next.presence]];
        },
      ),
    );
  }),
);

export function createPresenceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  deps: {
    readonly isTeamModeAtom: (environmentId: EnvironmentId) => Atom.Atom<boolean>;
    readonly configValueAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<{ readonly presence?: boolean } | null>;
  },
) {
  const presenceFamily = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:presence",
    subscribe: () => presenceStream,
  });
  const presenceAtom = (environmentId: EnvironmentId) =>
    presenceFamily({ environmentId, input: {} });

  /** Solo servers and servers without presence never see a subscribe or a report. */
  const presenceEnabledAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) =>
        get(deps.isTeamModeAtom(environmentId)) &&
        get(deps.configValueAtom(environmentId))?.presence === true,
    ).pipe(Atom.withLabel(`environment-presence-enabled:${environmentId}`)),
  );

  const presenceValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): PresenceState => {
      if (!get(presenceEnabledAtom(environmentId))) return EMPTY_PRESENCE;
      return Option.getOrElse(
        AsyncResult.value(get(presenceAtom(environmentId))),
        () => EMPTY_PRESENCE,
      );
    }).pipe(Atom.withLabel(`environment-presence-value:${environmentId}`)),
  );

  return {
    presenceEnabledAtom,
    presenceValueAtom,
    reportPresence: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:presence:report",
      tag: WS_METHODS.presenceReport,
      // Typing is bound to the viewed thread, so reports must reach the server in order.
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
  };
}
