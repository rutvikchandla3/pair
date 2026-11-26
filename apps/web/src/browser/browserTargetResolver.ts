import {
  AuthAccessWriteScope,
  type BrowserNavigationTarget,
  type EnvironmentId,
  type PreviewUrlResolution,
} from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";
import { isLocalLoopbackHost, isPrivateNetworkHost } from "@t3tools/shared/hostClassification";

import type { ConnectionTarget } from "@t3tools/client-runtime/connection";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { readEnvironmentHasMachineBrowser } from "~/state/entities";
import { readEnvironmentScope, readPreparedConnection } from "~/state/session";

export { normalizeHostname, isLocalLoopbackHost } from "@t3tools/shared/hostClassification";

const readEnvironmentUrl = (environmentId: EnvironmentId): URL => {
  const connection = readPreparedConnection(environmentId);
  if (!connection) throw new Error(`Environment ${environmentId} is not connected.`);
  return new URL(connection.httpBaseUrl);
};

const resolveEnvironmentPortTarget = (
  environmentId: EnvironmentId,
  target: Extract<BrowserNavigationTarget, { readonly kind: "environment-port" }>,
  environmentUrl: URL,
  requestedUrl?: string,
  sourceUrl?: URL,
): PreviewUrlResolution => {
  if (!isPrivateNetworkHost(environmentUrl.hostname)) {
    throw new Error(
      "This environment port needs the planned authenticated preview gateway; its server address is not directly private-network reachable.",
    );
  }
  const protocol = target.protocol ?? "http";
  const path = target.path?.startsWith("/") ? target.path : `/${target.path ?? ""}`;
  const normalizedEnvironmentHost = environmentUrl.hostname.replace(/^\[|\]$/g, "");
  // localhost lets Chromium reach loopback servers bound to either IPv4 or IPv6.
  const resolvedHost = isLocalLoopbackHost(normalizedEnvironmentHost)
    ? "localhost"
    : normalizedEnvironmentHost.includes(":")
      ? `[${normalizedEnvironmentHost}]`
      : normalizedEnvironmentHost;
  const resolved = sourceUrl
    ? new URL(sourceUrl)
    : new URL(path, `${protocol}://${resolvedHost}:${target.port}`);
  if (sourceUrl) {
    resolved.hostname = resolvedHost;
    resolved.port = String(target.port);
  }
  return {
    requestedUrl: requestedUrl ?? `${protocol}://localhost:${target.port}${path}`,
    resolvedUrl: resolved.toString(),
    resolutionKind: isLocalLoopbackHost(normalizedEnvironmentHost)
      ? "direct"
      : "direct-private-network",
    environmentId,
  };
};

// Loopback servers on the desktop's own primary and WSL backends answer on this machine's localhost.
const reachesEnvironmentLoopback = (target: ConnectionTarget): boolean =>
  isElectron &&
  (target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target));

/**
 * Desktop carries every other environment's loopback traffic through the preview tunnel, which
 * the server grants only to access managers. Members and machine-browser threads take the port route.
 */
export const tunnelsEnvironmentLoopback = (
  target: ConnectionTarget | undefined,
  mayTunnel: boolean,
): boolean =>
  isElectron && mayTunnel && !(target !== undefined && reachesEnvironmentLoopback(target));

export const environmentMayTunnelLoopback = (
  canManageAccess: boolean,
  hasMachineBrowser: boolean,
): boolean => canManageAccess && !hasMachineBrowser;

const resolveLoopbackUrl = (
  environmentId: EnvironmentId,
  rawUrl: string,
  tunnelled: boolean,
): string => {
  try {
    const normalizedUrl = normalizePreviewUrl(rawUrl);
    const parsed = new URL(normalizedUrl);
    if (tunnelled || !isLoopbackHost(parsed.hostname)) return normalizedUrl;
    // The thread's machine runs the tab's Chrome, which resolves its own loopback.
    if (readEnvironmentHasMachineBrowser(environmentId)) return normalizedUrl;
    const target = readPreparedConnection(environmentId)?.target;
    if (target && reachesEnvironmentLoopback(target)) return normalizedUrl;
    return resolveEnvironmentPortTarget(
      environmentId,
      {
        kind: "environment-port",
        port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
        protocol: parsed.protocol === "https:" ? "https" : "http",
        path: `${parsed.pathname}${parsed.search}${parsed.hash}`,
      },
      readEnvironmentUrl(environmentId),
      rawUrl,
      parsed,
    ).resolvedUrl;
  } catch {
    return rawUrl;
  }
};

/** The URL an in-app tab loads. A desktop webview keeps localhost; its partition reaches the environment. */
export const resolveDiscoveredServerUrl = (environmentId: EnvironmentId, rawUrl: string): string =>
  resolveLoopbackUrl(
    environmentId,
    rawUrl,
    isElectron &&
      environmentMayTunnelLoopback(
        readEnvironmentScope(environmentId, AuthAccessWriteScope),
        readEnvironmentHasMachineBrowser(environmentId),
      ),
  );

/** The URL for the system browser, which has no tunnel and needs an address it can reach itself. */
export const resolveExternalServerUrl = (environmentId: EnvironmentId, rawUrl: string): string =>
  resolveLoopbackUrl(environmentId, rawUrl, false);
