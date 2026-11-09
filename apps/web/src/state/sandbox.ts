import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import {
  type CloudTarget,
  cloudTargetEnvironments,
  type ContinueInCloudOffer,
  resolveCloudTarget,
  resolveContinueInCloud,
} from "@t3tools/client-runtime/state/cloud-target";
import {
  createCloudAccountNoticeAtoms,
  createSandboxEnvironmentAtoms,
} from "@t3tools/client-runtime/state/sandbox";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "./projects";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { teamEnvironment } from "./team";
import { environmentThreadShells } from "./threads";

export const sandboxEnvironment = createSandboxEnvironmentAtoms(connectionAtomRuntime, {
  team: teamEnvironment,
  threadShells: environmentThreadShells,
});

export const cloudAccountNoticeAtom = createCloudAccountNoticeAtoms({
  configValueAtom: (environmentId) => serverEnvironment.configValueAtom(environmentId),
  currentMemberAtom: (environmentId) => teamEnvironment.currentMemberAtom(environmentId),
});

const HIDDEN: CloudTarget = { kind: "hidden" };

function cloudTargetOf(
  projectRef: ScopedProjectRef | null,
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>,
  projects: ReadonlyArray<EnvironmentProject>,
): CloudTarget {
  const project =
    projectRef === null
      ? undefined
      : projects.find(
          (candidate) =>
            candidate.environmentId === projectRef.environmentId &&
            candidate.id === projectRef.projectId,
        );
  if (project === undefined) return HIDDEN;
  return resolveCloudTarget({
    project,
    environments: cloudTargetEnvironments(presentations),
    projects,
  });
}

const NO_PRESENTATIONS_ATOM = Atom.make<ReadonlyMap<EnvironmentId, EnvironmentPresentation>>(
  new Map(),
).pipe(Atom.withLabel("web-cloud-target:no-presentations"));
const NO_PROJECTS_ATOM = Atom.make<ReadonlyArray<EnvironmentProject>>([]).pipe(
  Atom.withLabel("web-cloud-target:no-projects"),
);

/** Where Cloud goes for the project: itself, a matching Pair Cloud project, or Add. */
export function useCloudTarget(projectRef: ScopedProjectRef | null): CloudTarget {
  // A null ref subscribes to nothing, so screens that don't need Cloud don't re-render for it.
  return cloudTargetOf(
    projectRef,
    useAtomValue(
      projectRef === null ? NO_PRESENTATIONS_ATOM : environmentPresentations.presentationsAtom,
    ),
    useAtomValue(projectRef === null ? NO_PROJECTS_ATOM : environmentProjects.projectsAtom),
  );
}

/** Read at event time, for shortcuts. */
export function readCloudTarget(projectRef: ScopedProjectRef): CloudTarget {
  return cloudTargetOf(
    projectRef,
    appAtomRegistry.get(environmentPresentations.presentationsAtom),
    appAtomRegistry.get(environmentProjects.projectsAtom),
  );
}

function continueInCloudOfferOf(
  thread: EnvironmentThreadShell | null,
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>,
  projects: ReadonlyArray<EnvironmentProject>,
): ContinueInCloudOffer {
  return thread === null
    ? { kind: "hidden" }
    : resolveContinueInCloud({ thread, projects, presentations });
}

const NO_THREAD_ATOM = Atom.make<EnvironmentThreadShell | null>(null).pipe(
  Atom.withLabel("web-cloud-target:no-thread"),
);

/** Continue in cloud for the palette's active thread. */
export function useContinueInCloudOffer(threadRef: ScopedThreadRef | null): ContinueInCloudOffer {
  // A null ref subscribes to nothing, as useCloudTarget.
  const thread = useAtomValue(
    threadRef === null ? NO_THREAD_ATOM : environmentThreadShells.threadShellAtom(threadRef),
  );
  const presentations = useAtomValue(
    threadRef === null ? NO_PRESENTATIONS_ATOM : environmentPresentations.presentationsAtom,
  );
  const projects = useAtomValue(
    threadRef === null ? NO_PROJECTS_ATOM : environmentProjects.projectsAtom,
  );
  return threadRef === null
    ? { kind: "hidden" }
    : continueInCloudOfferOf(thread, presentations, projects);
}

/** Read at event time, for menus. */
export function readContinueInCloudOffer(threadRef: ScopedThreadRef): ContinueInCloudOffer {
  return continueInCloudOfferOf(
    appAtomRegistry.get(environmentThreadShells.threadShellAtom(threadRef)),
    appAtomRegistry.get(environmentPresentations.presentationsAtom),
    appAtomRegistry.get(environmentProjects.projectsAtom),
  );
}
