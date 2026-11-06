import { useAtomValue } from "@effect/atom-react";
import {
  INITIAL_PRESENCE_REPORTER,
  shouldReportKeystroke,
  stepAppPresence,
  stepPresenceReporter,
  type AppPresenceState,
  type PresenceReporterState,
  type PresenceReporterStep,
} from "@t3tools/client-runtime/presence-reporting";
import {
  EMPTY_PRESENCE,
  createPresenceEnvironmentAtoms,
  presentMembers,
  type PresenceState,
  type PresentMember,
} from "@t3tools/client-runtime/state/presence";
import { EMPTY_TEAM_MEMBERS } from "@t3tools/client-runtime/state/team";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { serverEnvironment } from "./server";
import { teamEnvironment } from "./team";

export const presenceEnvironment = createPresenceEnvironmentAtoms(connectionAtomRuntime, {
  isTeamModeAtom: teamEnvironment.isTeamModeAtom,
  configValueAtom: serverEnvironment.configValueAtom,
});

const NO_PRESENCE_ATOM = Atom.make(EMPTY_PRESENCE).pipe(Atom.withLabel("mobile-presence:none"));
const NO_MEMBERS_ATOM = Atom.make(EMPTY_TEAM_MEMBERS).pipe(
  Atom.withLabel("mobile-presence-members:none"),
);

/** Other members only; empty, with no subscription, unless the server is a team with presence. */
export function usePresence(environmentId: EnvironmentId): PresenceState {
  return useAtomValue(presenceEnvironment.presenceValueAtom(environmentId));
}

const NO_MEMBERS: ReadonlyArray<PresentMember> = [];

/** Who else views a thread, and who of them is typing there. */
export function useThreadPresence(
  thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
): {
  readonly viewers: ReadonlyArray<PresentMember>;
  readonly typing: ReadonlyArray<PresentMember>;
} {
  const presence = useAtomValue(
    thread === null
      ? NO_PRESENCE_ATOM
      : presenceEnvironment.presenceValueAtom(thread.environmentId),
  );
  const members = useAtomValue(
    thread === null || presence === EMPTY_PRESENCE
      ? NO_MEMBERS_ATOM
      : teamEnvironment.membersValueAtom(thread.environmentId),
  );
  if (thread === null || presence === EMPTY_PRESENCE) {
    return { viewers: NO_MEMBERS, typing: NO_MEMBERS };
  }
  return {
    viewers: presentMembers(members, presence, presence.viewers.get(thread.threadId)),
    typing: presentMembers(members, presence, presence.typing.get(thread.threadId)),
  };
}

type ViewedThread = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

/** The thread the navigation shows, from the root pathname. */
export const viewedThreadAtom = Atom.make<ViewedThread | null>(null).pipe(
  Atom.withLabel("mobile-presence-viewed-thread"),
);

export function setPresencePathname(pathname: string) {
  const match = /^\/threads\/([^/]+)\/([^/]+)(?:\/|$)/.exec(pathname);
  let next: ViewedThread | null = null;
  try {
    if (match?.[1] && match[2]) {
      next = {
        environmentId: EnvironmentId.make(decodeURIComponent(match[1])),
        threadId: ThreadId.make(decodeURIComponent(match[2])),
      };
    }
  } catch {
    next = null;
  }
  const current = appAtomRegistry.get(viewedThreadAtom);
  if (current?.environmentId === next?.environmentId && current?.threadId === next?.threadId) {
    return;
  }
  appAtomRegistry.set(viewedThreadAtom, next);
}

// One reporter per environment with presence, owned by PresenceWatch while it is mounted.
const reporters = new Map<EnvironmentId, { state: PresenceReporterState }>();

function stepReporter(
  environmentId: EnvironmentId,
  step: (state: PresenceReporterState, now: number) => PresenceReporterStep,
) {
  const reporter = reporters.get(environmentId);
  if (reporter === undefined) return;
  const next = step(reporter.state, Date.now());
  reporter.state = next.state;
  if (next.report === undefined) return;
  void presenceEnvironment.reportPresence.run(appAtomRegistry, {
    environmentId,
    input: next.report,
  });
}

export function mountPresenceReporter(environmentId: EnvironmentId): () => void {
  reporters.set(environmentId, { state: INITIAL_PRESENCE_REPORTER });
  return () => {
    reporters.delete(environmentId);
  };
}

export function reportAppPresence(
  environmentId: EnvironmentId,
  app: { readonly appState: AppPresenceState; readonly threadId: ThreadId | null },
) {
  stepReporter(environmentId, (state, now) => stepAppPresence(state, app, now));
}

export function reportOthersPresent(environmentId: EnvironmentId, others: boolean) {
  stepReporter(environmentId, (state, now) =>
    stepPresenceReporter(state, { type: "others", others }, now),
  );
}

/** Runs on every composer change, so it allocates nothing unless it reports. */
export function reportComposerTyping(environmentId: EnvironmentId, threadId: ThreadId) {
  const reporter = reporters.get(environmentId);
  if (reporter === undefined || !shouldReportKeystroke(reporter.state, threadId, Date.now())) {
    return;
  }
  stepReporter(environmentId, (state, now) =>
    stepPresenceReporter(state, { type: "keystroke", threadId }, now),
  );
}

export function reportComposerSent(environmentId: EnvironmentId) {
  stepReporter(environmentId, (state, now) => stepPresenceReporter(state, { type: "sent" }, now));
}
