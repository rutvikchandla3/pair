import { useAtomValue } from "@effect/atom-react";
import {
  type ContinueLocallyOffer,
  resolveContinueLocally,
} from "@t3tools/client-runtime/state/cloud-target";
import { resolveProjectDefaultProviderModelSelection } from "@t3tools/client-runtime/state/provider-instance-entries";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useRouter } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import { toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell, useProjects, useServerConfigs } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { peerLinkEnvironment } from "../state/peerLinks";
import { useEnvironmentQuery } from "../state/query";
import { environmentServerConfigsAtom } from "../state/server";
import { threadMoveEnvironment } from "../state/threadMove";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";

const FAILURE_TITLE = "Could not continue locally";
const UNREPORTED_NOTICE =
  "Pair Cloud didn't record this move, so the cloud thread there stays as it was and doesn't link here.";
const noPermissionAtom = Atom.make(false).pipe(Atom.withLabel("thread-move:to-local:none"));

/**
 * Continue locally for a cloud thread: offered wherever the client's primary environment is the
 * member's own server (the desktop's, or the `npx t3` one), never on app.t3.codes.
 */
export function useContinueLocally() {
  const router = useRouter();
  const primary = usePrimaryEnvironmentId();
  const serverConfigs = useServerConfigs();
  const projects = useProjects();
  const canMove = useAtomValue(
    primary === null ? noPermissionAtom : threadMoveEnvironment.toLocal.permissionAtom(primary),
  );
  // Listing probes every linked peer, so only while some connected environment takes moves.
  const anyCloudImport = [...serverConfigs.values()].some(
    (config) => config?.environment.capabilities.cloudImport === true,
  );
  const links = useEnvironmentQuery(
    primary !== null && anyCloudImport
      ? peerLinkEnvironment.list({ environmentId: primary, input: {} })
      : null,
  );
  const toLocal = useAtomCommand(threadMoveEnvironment.toLocal, { reportFailure: false });

  const offerFor = (threadRef: ScopedThreadRef): ContinueLocallyOffer => {
    const thread = readThreadShell(threadRef);
    if (thread === null) return { kind: "hidden" };
    return resolveContinueLocally({
      thread,
      primaryEnvironmentId: primary,
      serverConfigs,
      canMove,
      projects,
      links: links.data?.links ?? [],
      now: DateTime.nowUnsafe(),
    });
  };

  const fail = (description: string, toastId?: ReturnType<typeof toastManager.add>) => {
    const toast = { type: "error" as const, title: FAILURE_TITLE, description };
    if (toastId === undefined) toastManager.add(toast);
    else toastManager.update(toastId, toast);
  };

  const run = async (threadRef: ScopedThreadRef) => {
    const offer = offerFor(threadRef);
    if (offer.kind === "hidden") return;
    if (offer.kind === "disabled") {
      fail(offer.reason);
      return;
    }
    const local: EnvironmentId = offer.localEnvironmentId;
    // The new thread's model and modes, as a new draft in that project gets them.
    const config = appAtomRegistry.get(environmentServerConfigsAtom).get(local);
    const settings = config?.settings ?? DEFAULT_SERVER_SETTINGS;
    const project = projects.find(
      (candidate) => candidate.environmentId === local && candidate.id === offer.projectId,
    );
    const projectSettings = resolveProjectSettings(settings, offer.projectId, project);
    const modelSelection =
      projectSettings.settings.defaultModelSelection ??
      resolveProjectDefaultProviderModelSelection(
        config?.providers ?? [],
        settings,
        offer.projectId,
      );
    if (modelSelection === null) {
      fail("Set up a provider on this computer first.");
      return;
    }
    // The download can take minutes; the toast is the move's visible state.
    const toastId = toastManager.add({ type: "loading", title: "Continuing locally…" });
    const result = await toLocal({
      environmentId: local,
      input: {
        source: threadRef,
        projectId: offer.projectId,
        modelSelection,
        runtimeMode: projectSettings.settings.defaultRuntimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) {
        toastManager.close(toastId);
        return;
      }
      const error = squashAtomCommandFailure(result);
      fail(error instanceof Error ? error.message : String(error), toastId);
      return;
    }
    const moved = result.value;
    if (!moved.reported) {
      toastManager.update(toastId, {
        type: "warning",
        title: "Continued locally",
        description: UNREPORTED_NOTICE,
      });
    } else if (moved.copy) {
      toastManager.update(toastId, {
        type: "success",
        title: `Continued a copy on ${moved.branch}`,
        description: "The cloud thread stays with its owner.",
      });
    } else {
      toastManager.close(toastId);
    }
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId: local, threadId: moved.threadId }),
    });
  };

  return { offerFor, run };
}
