import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useComposerDraftStore } from "../composerDraftStore";
import { createNewThreadHandler } from "../hooks/useHandleNewThread";
import { setAppearanceMode } from "../hooks/useTheme";
import type { AppRouter } from "../router";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { environmentProjects } from "../state/projects";
import { primaryServerConfigAtom, primaryServerWelcomeAtom } from "../state/server";
import { environmentShell } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { connectEmbedHost, type EmbedConfig, type EmbedThreadTarget } from "./protocol";
import {
  embedShownThreadId,
  embedThreadSummaries,
  resolveEmbedWorkspaceProject,
} from "./workspace";

// Null until the primary shell has a snapshot, so the host never sees a list that is only empty
// because nothing has loaded yet.
const embedThreadsAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return null;
  if (get(environmentShell.stateValueAtom(environmentId)).status === "empty") return null;
  return embedThreadSummaries(get(environmentThreadShells.threadShellsAtom), environmentId);
}).pipe(Atom.withLabel("web-embed-threads"));

const embedWorkspaceProjectAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return null;
  return resolveEmbedWorkspaceProject({
    environmentId,
    projects: get(environmentProjects.projectsAtom),
    threads: get(environmentThreadShells.threadShellsAtom),
    bootstrapProjectId: get(primaryServerWelcomeAtom)?.bootstrapProjectId ?? null,
    serverCwd: get(primaryServerConfigAtom)?.cwd ?? null,
  });
}).pipe(Atom.withLabel("web-embed-workspace-project"));

/** Runs for the life of an embedded page; see the protocol in `./protocol.ts`. */
export function startEmbedBridge(
  router: AppRouter,
  config: Extract<EmbedConfig, { embedded: true }>,
): void {
  const handleNewThread = createNewThreadHandler(router);
  // The newest request wins; it waits until the environment and its workspace project are known.
  let pendingOpen: EmbedThreadTarget | null = config.thread;
  let openingDraft = false;

  const openPending = () => {
    const target = pendingOpen;
    const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
    if (target === null || openingDraft || environmentId === null) return;
    if (target.kind === "thread") {
      pendingOpen = null;
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: target.threadId },
        replace: true,
      });
      return;
    }
    const project = appAtomRegistry.get(embedWorkspaceProjectAtom);
    if (project === null) return;
    pendingOpen = null;
    openingDraft = true;
    void handleNewThread(scopeProjectRef(environmentId, project.id), { replace: true }).then(
      (opened) => {
        openingDraft = false;
        // The project can be listed before its entity is readable; retry on the next change.
        if (opened === null) pendingOpen ??= target;
        openPending();
      },
      () => {
        openingDraft = false;
        openPending();
      },
    );
  };

  const host = connectEmbedHost({
    self: window,
    host: window.parent,
    onMessage: (message) => {
      if (message.type === "setTheme") {
        setAppearanceMode(message.theme);
        return;
      }
      pendingOpen = message.target;
      openPending();
    },
  });
  host.post({ type: "ready" });

  let shownThreadId: ThreadId | null = null;
  const reportShownThread = () => {
    const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
    const next = embedShownThreadId({
      target,
      draftPromotedTo:
        target?.kind === "draft"
          ? (useComposerDraftStore.getState().getDraftSession(target.draftId)?.promotedTo ?? null)
          : null,
      environmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
    });
    if (next === shownThreadId) return;
    shownThreadId = next;
    host.post({ type: "threadChanged", threadId: next });
  };

  let postedThreads: string | null = null;
  appAtomRegistry.subscribe(
    embedThreadsAtom,
    (threads) => {
      if (threads === null) return;
      const signature = JSON.stringify(threads);
      if (signature === postedThreads) return;
      postedThreads = signature;
      host.post({ type: "threadsChanged", threads });
    },
    { immediate: true },
  );
  appAtomRegistry.subscribe(primaryEnvironmentIdAtom, () => {
    openPending();
    reportShownThread();
  });
  appAtomRegistry.subscribe(embedWorkspaceProjectAtom, openPending, { immediate: true });
  router.subscribe("onResolved", reportShownThread);
  useComposerDraftStore.subscribe((state, previous) => {
    if (state.draftThreadsByThreadKey !== previous.draftThreadsByThreadKey) reportShownThread();
  });
}
