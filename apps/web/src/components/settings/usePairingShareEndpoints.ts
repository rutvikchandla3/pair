import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { desktopNetworkAccessStateAtom } from "~/state/desktopNetworkAccess";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useUiStateStore } from "~/uiStateStore";
import { resolvePairingShareEndpoints } from "./ConnectionsSettings.logic";

const NO_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];

/** What a pairing link needs to name this machine; empty unless the desktop app hosts it. */
export function usePairingShareEndpoints() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canMaintain = useEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope);
  const preferredKey = useUiStateStore((state) => state.defaultAdvertisedEndpointKey);
  const hostsLocally = window.desktopBridge !== undefined && !isLocalEnvironmentDisabled();
  const network = useEnvironmentQuery(
    hostsLocally && canMaintain ? desktopNetworkAccessStateAtom : null,
  ).data;
  const { endpoints, defaultEndpointKey } = resolvePairingShareEndpoints(
    network?.advertisedEndpoints ?? NO_ENDPOINTS,
    network?.serverExposureState.mode === "network-accessible",
    preferredKey,
  );
  return {
    endpointUrl: network?.serverExposureState.endpointUrl,
    endpoints,
    defaultEndpointKey,
  };
}
