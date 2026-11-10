import {
  WS_METHODS,
  type EnvironmentId,
  type TeamImageBuildLogChunk,
  type TeamImageSaveRecipeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { requestGuarded } from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** A log tail longer than this loses its oldest lines on the client; the server keeps 5 MiB. */
export const TEAM_IMAGE_LOG_VIEW_MAX_CHARS = 256_000;

export interface TeamImageLogView {
  readonly text: string;
  /** The build ended and `text` is everything the server kept. */
  readonly done: boolean;
  /** Older lines were dropped on this client. */
  readonly truncated: boolean;
}

export const EMPTY_TEAM_IMAGE_LOG: TeamImageLogView = { text: "", done: false, truncated: false };

export function applyTeamImageLogChunk(
  view: TeamImageLogView,
  chunk: TeamImageBuildLogChunk,
): TeamImageLogView {
  let text = view.text + chunk.text;
  let truncated = view.truncated;
  if (text.length > TEAM_IMAGE_LOG_VIEW_MAX_CHARS) {
    text = text.slice(text.length - TEAM_IMAGE_LOG_VIEW_MAX_CHARS);
    // Start on a whole line.
    const firstBreak = text.indexOf("\n");
    if (firstBreak >= 0) text = text.slice(firstBreak + 1);
    truncated = true;
  }
  return { text, done: chunk.done, truncated };
}

export function createTeamImageAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  /** Snapshot, then each change. Mount it for one environment with `input: {}`. */
  const snapshot = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:team-image:snapshot",
    tag: WS_METHODS.teamImageSubscribe,
  });

  /** One build's redacted log. Mounted only while its panel is open, so closing it ends the stream. */
  const buildLog = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:team-image:build-log",
    tag: WS_METHODS.teamImageSubscribeBuildLog,
    idleTtlMs: 0,
    completeWhen: (view: TeamImageLogView) => view.done,
    // `scan` emits its seed first; skipping it keeps the panel "loading" until the first chunk.
    transform: (chunks) =>
      chunks.pipe(
        Stream.scan(() => EMPTY_TEAM_IMAGE_LOG, applyTeamImageLogChunk),
        Stream.filter((view) => view !== EMPTY_TEAM_IMAGE_LOG),
      ),
  });

  const activeBuildNumberFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): number | null => {
      const value = AsyncResult.value(get(snapshot({ environmentId, input: {} })));
      if (Option.isNone(value)) return null;
      const { activeBuildId, builds } = value.value;
      return builds.find((build) => build.id === activeBuildId)?.number ?? null;
    }).pipe(Atom.withLabel(`team-image-active-build-number:${environmentId}`)),
  );

  return {
    snapshot,
    buildLog,
    /** The active build's number; null while loading or with none. Re-renders only when it changes. */
    activeBuildNumberAtom: (environmentId: EnvironmentId) => activeBuildNumberFamily(environmentId),
    /** Settings write on the server, as each command below whose permissionAtom says so. */
    saveRecipe: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team-image:save-recipe",
      tag: WS_METHODS.teamImageSaveRecipe,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    startBuild: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team-image:start-build",
      tag: WS_METHODS.teamImageStartBuild,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    /** Saves the recipe, then builds the revision the save returned, so no one else's save slips in. */
    saveAndBuild: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team-image:save-and-build",
      tag: WS_METHODS.teamImageStartBuild,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
      execute: (input: TeamImageSaveRecipeInput) =>
        requestGuarded(WS_METHODS.teamImageSaveRecipe, input).pipe(
          Effect.flatMap((saved) =>
            requestGuarded(WS_METHODS.teamImageStartBuild, { recipeRevision: saved.revision }),
          ),
        ),
    }),
    cancelBuild: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team-image:cancel-build",
      tag: WS_METHODS.teamImageCancelBuild,
    }),
    /** Activating an older succeeded build is the rollback. */
    activateBuild: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team-image:activate-build",
      tag: WS_METHODS.teamImageActivateBuild,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    dismissProposal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team-image:dismiss-proposal",
      tag: WS_METHODS.teamImageDismissProposal,
    }),
    /** Write-only: the value never comes back, only its name in an admin's snapshot. */
    setSecret: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team-image:set-secret",
      tag: WS_METHODS.teamImageSetSecret,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    removeSecret: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team-image:remove-secret",
      tag: WS_METHODS.teamImageRemoveSecret,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    /** A saved revision, for Restore recipe; open to anyone who can read the page. */
    readRecipe: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team-image:read-recipe",
      tag: WS_METHODS.teamImageReadRecipe,
    }),
  };
}
