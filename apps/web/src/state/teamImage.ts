import { createTeamImageAtoms } from "@t3tools/client-runtime/state/team-image";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSummaries } from "./presentation";
import { serverEnvironment } from "./server";

export const teamImageEnvironment = createTeamImageAtoms(connectionAtomRuntime);

/** Connected environments whose server builds team images; the build toasts watch each. */
export const teamImageEnvironmentIdsAtom = Atom.make((get) =>
  get(environmentSummaries.connectedEnvironmentIdsAtom).filter(
    (environmentId) =>
      get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities.teamImages ===
      true,
  ),
).pipe(Atom.withLabel("team-image-environment-ids"));

/** The active build's number where the server builds team images; null elsewhere, with no subscription. */
export const activeTeamImageBuildNumberAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities.teamImages ===
    true
      ? get(teamImageEnvironment.activeBuildNumberAtom(environmentId))
      : null,
  ).pipe(Atom.withLabel(`team-image-active-build-number-if-built:${environmentId}`)),
);
