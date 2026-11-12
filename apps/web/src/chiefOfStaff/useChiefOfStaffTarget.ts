import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { pickTriageEnvironment } from "../lib/triageTarget";
import { chiefOfStaffCommands } from "../state/chiefOfStaff";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";

interface ChiefOfStaffTarget {
  /** The environment a new session would start in. */
  readonly environmentId: EnvironmentId | null;
  readonly available: boolean;
  /** Named only when more than one environment is connected. */
  readonly environmentLabel: string | null;
}

/** The viewed environment when it can run a voice session, else the primary, else any that can. */
export function useChiefOfStaffTarget(): ChiefOfStaffTarget {
  const routeTarget = useThreadRouteTarget();
  const draftEnvironmentId = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft"
      ? (store.getDraftSession(routeTarget.draftId)?.environmentId ?? null)
      : null,
  );
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connected = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const supportsVoice = (environmentId: EnvironmentId) => {
    const serverConfig = connected.find(
      (environment) => environment.environmentId === environmentId,
    )?.serverConfig;
    return (
      serverConfig?.environment.capabilities.chiefOfStaffVoice === true &&
      serverConfig.settings.chiefOfStaff.enabled
    );
  };
  const viewedEnvironmentId =
    routeTarget?.kind === "server" ? routeTarget.threadRef.environmentId : draftEnvironmentId;
  const environmentId = pickTriageEnvironment({
    onScreen:
      viewedEnvironmentId !== null && supportsVoice(viewedEnvironmentId)
        ? viewedEnvironmentId
        : null,
    primary: primaryEnvironmentId,
    connected: connected.map((environment) => environment.environmentId),
    supportsTriage: supportsVoice,
  });
  const permitted = useAtomValue(chiefOfStaffCommands.start.permissionAtom(environmentId));
  const label =
    connected.length > 1
      ? (environments.find((environment) => environment.environmentId === environmentId)?.label ??
        null)
      : null;
  return {
    environmentId,
    available: environmentId !== null && permitted && supportsVoice(environmentId),
    environmentLabel: label,
  };
}
