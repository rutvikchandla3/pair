import { useAtomValue } from "@effect/atom-react";
import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  AuthAccessWriteScope,
  allowsPreviewTunnel,
  isBuiltInBrowserProfileId,
  type BrowserProfile,
  type EnvironmentId,
  type PreviewRuntime,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "~/connection/catalog";
import { isElectron } from "~/env";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import {
  readEnvironmentHasMachineBrowser,
  readEnvironmentSupportsServerBrowser,
  useEnvironmentSupportsServerBrowser,
} from "~/state/entities";
import { environmentServerConfigsAtom } from "~/state/server";
import { environmentSession, sessionHasScope } from "~/state/session";

import { environmentMayTunnelLoopback, tunnelsEnvironmentLoopback } from "./browserTargetResolver";

/** Whether this desktop loads the environment's localhost itself: it is local, or its tunnel is on. */
const desktopLoadsLoopbackAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const target = get(environmentCatalog.catalogValueAtom).entries.get(environmentId)?.target;
    const config = get(environmentServerConfigsAtom).get(environmentId);
    const mayTunnel = environmentMayTunnelLoopback(
      sessionHasScope(
        get(environmentSession.sessionStateAtom(environmentId)),
        AuthAccessWriteScope,
      ),
      config?.environment.capabilities.machineBrowser === true,
    );
    if (!tunnelsEnvironmentLoopback(target, mayTunnel)) return true;
    return config !== undefined && allowsPreviewTunnel(config);
  }).pipe(Atom.withLabel(`preview:desktop-loads-loopback:${environmentId}`)),
);

export function previewRuntimeFor(environmentId: EnvironmentId): PreviewRuntime | undefined {
  if (!readEnvironmentSupportsServerBrowser(environmentId)) return undefined;
  // A desktop webview cannot reach a thread's machine.
  if (readEnvironmentHasMachineBrowser(environmentId)) return "server";
  // Without its tunnel, another environment's tabs stream from it, as on the web.
  if (
    isPreviewSupportedInRuntime() &&
    environmentId !== appAtomRegistry.get(primaryEnvironmentIdAtom) &&
    appAtomRegistry.get(desktopLoadsLoopbackAtom(environmentId))
  ) {
    return undefined;
  }
  return "server";
}

export function alternatePreviewRuntime(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  serverBrowser: boolean,
  machineBrowser: boolean,
  desktopLoadsLoopback: boolean,
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
): PreviewRuntime | null {
  if (!snapshot || !serverBrowser || machineBrowser || !isPreviewSupportedInRuntime()) return null;
  if (environmentId === primaryEnvironmentId) return null;
  if (snapshot.runtime === "server") return desktopLoadsLoopback ? "desktop" : null;
  return "server";
}

export function useDesktopLoadsLoopback(environmentId: EnvironmentId): boolean {
  return useAtomValue(desktopLoadsLoopbackAtom(environmentId));
}

/** A machine's Chrome has one persistent profile and incognito; named profiles stay local (Q2). */
export const MACHINE_BROWSER_PROFILES: ReadonlyArray<BrowserProfile> = BUILT_IN_BROWSER_PROFILES;

export function machineBrowserProfileId(profileId: string): string {
  return isBuiltInBrowserProfileId(profileId) ? profileId : DEFAULT_BROWSER_PROFILE_ID;
}

export function isPreviewAvailableFor(environmentId: EnvironmentId): boolean {
  return isPreviewSupportedInRuntime() || readEnvironmentSupportsServerBrowser(environmentId);
}

export function usePreviewAvailable(environmentId: EnvironmentId | null): boolean {
  const serverBrowser = useEnvironmentSupportsServerBrowser(environmentId);
  return isPreviewSupportedInRuntime() || serverBrowser;
}

export function rendersServerTabNatively(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "headless"> | null | undefined,
): boolean {
  return (
    isElectron &&
    snapshot?.runtime === "server" &&
    !snapshot.headless &&
    primaryEnvironmentId !== null &&
    environmentId === primaryEnvironmentId
  );
}

export function useRendersServerTabNatively(
  environmentId: EnvironmentId,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "headless"> | null | undefined,
): boolean {
  return rendersServerTabNatively(environmentId, useAtomValue(primaryEnvironmentIdAtom), snapshot);
}
