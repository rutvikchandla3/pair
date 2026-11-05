import { useAtomValue } from "@effect/atom-react";
import {
  INITIAL_PRESENCE_REPORTER,
  shouldReportKeystroke,
  stepPresenceReporter,
  type PresenceReporterSignal,
  type PresenceReporterState,
} from "@t3tools/client-runtime/presence-reporting";
import {
  EMPTY_PRESENCE,
  createPresenceEnvironmentAtoms,
  type PresenceState,
} from "@t3tools/client-runtime/state/presence";
import type { EnvironmentId, MemberId, ScopedThreadRef, TeamMember } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { subscribePresenceActivity } from "./presenceActivity";
import { serverEnvironment } from "./server";
import { teamEnvironment, useTeamMembers } from "./team";

export const presenceEnvironment = createPresenceEnvironmentAtoms(connectionAtomRuntime, {
  isTeamModeAtom: teamEnvironment.isTeamModeAtom,
  configValueAtom: serverEnvironment.configValueAtom,
});

const NO_PRESENCE_ATOM = Atom.make(EMPTY_PRESENCE).pipe(Atom.withLabel("presence:none"));

/** Other members only; empty unless the environment is in team mode with presence. */
export function usePresence(environmentId: EnvironmentId | null): PresenceState {
  return useAtomValue(
    environmentId === null
      ? NO_PRESENCE_ATOM
      : presenceEnvironment.presenceValueAtom(environmentId),
  );
}

export interface PresentMember extends Pick<TeamMember, "name" | "color"> {
  readonly id: MemberId;
  readonly away: boolean;
}

/** Who else views a thread, and who of them is typing there; members not on the roster are skipped. */
export function useThreadPresence(threadRef: ScopedThreadRef): {
  readonly viewers: ReadonlyArray<PresentMember>;
  readonly typing: ReadonlyArray<PresentMember>;
} {
  const presence = usePresence(threadRef.environmentId);
  const members = useTeamMembers(threadRef.environmentId);
  const present = (memberIds: ReadonlyArray<MemberId> | undefined): PresentMember[] =>
    (memberIds ?? []).flatMap((id) => {
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
  return {
    viewers: present(presence.viewers.get(threadRef.threadId)),
    typing: present(presence.typing.get(threadRef.threadId)),
  };
}

// One reporter per environment with presence, owned by PresenceWatch while it is mounted.
const reporters = new Map<EnvironmentId, { state: PresenceReporterState }>();

export function dispatchPresence(environmentId: EnvironmentId, signal: PresenceReporterSignal) {
  const reporter = reporters.get(environmentId);
  if (reporter === undefined) return;
  const step = stepPresenceReporter(reporter.state, signal, Date.now());
  reporter.state = step.state;
  if (step.report === undefined) return;
  void presenceEnvironment.reportPresence.run(appAtomRegistry, {
    environmentId,
    input: step.report,
  });
}

export function mountPresenceReporter(environmentId: EnvironmentId): () => void {
  reporters.set(environmentId, { state: INITIAL_PRESENCE_REPORTER });
  const unsubscribe = subscribePresenceActivity((signal) =>
    dispatchPresence(environmentId, signal),
  );
  return () => {
    unsubscribe();
    reporters.delete(environmentId);
  };
}

/** Runs on every composer change, so it allocates nothing unless it reports. */
export function reportComposerTyping(threadRef: ScopedThreadRef) {
  const reporter = reporters.get(threadRef.environmentId);
  if (
    reporter === undefined ||
    !shouldReportKeystroke(reporter.state, threadRef.threadId, Date.now())
  ) {
    return;
  }
  dispatchPresence(threadRef.environmentId, { type: "keystroke", threadId: threadRef.threadId });
}

const SENT_SIGNAL: PresenceReporterSignal = { type: "sent" };

export function reportComposerSent(threadRef: ScopedThreadRef) {
  dispatchPresence(threadRef.environmentId, SENT_SIGNAL);
}
