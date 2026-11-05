import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";

import {
  clearStashedReturnPath,
  readStashedReturnPath,
  safeReturnPath,
  stashReturnPath,
} from "../authReturnPath";

import {
  HostedPairingRouteSurface,
  PairingPendingSurface,
  PairingRouteSurface,
} from "../components/auth/PairingRouteSurface";

export const Route = createFileRoute("/pair")({
  validateSearch: (raw: Record<string, unknown>): { next?: string } => {
    const next = safeReturnPath(raw.next);
    return next === null ? {} : { next };
  },
  beforeLoad: async ({ context, search }) => {
    const { authGateState } = context;
    if (authGateState.status === "hosted-pairing") {
      return {
        authGateState,
      };
    }

    if (
      authGateState.status === "authenticated" ||
      authGateState.status === "hosted-static" ||
      authGateState.status === "guest"
    ) {
      const returnPath =
        authGateState.status === "authenticated" ? (search.next ?? readStashedReturnPath()) : null;
      clearStashedReturnPath();
      // `href` wins over `to` when the router navigates a redirect.
      throw redirect({ to: "/", replace: true, ...(returnPath ? { href: returnPath } : {}) });
    }
    if (search.next) stashReturnPath(search.next);
    return {
      authGateState,
    };
  },
  component: PairRouteView,
  pendingComponent: PairRoutePendingView,
});

function PairRouteView() {
  const router = useRouter();
  const { authGateState } = Route.useRouteContext();
  const { next } = Route.useSearch();

  if (!authGateState) {
    return null;
  }

  if (authGateState.status === "hosted-pairing") {
    return <HostedPairingRouteSurface />;
  }

  return (
    <PairingRouteSurface
      auth={authGateState.auth}
      hasReturnPath={next !== undefined}
      onAuthenticated={() => {
        // The sign-in link often opens in a new tab with no `next`, so the stash stands in.
        const returnPath = next ?? readStashedReturnPath() ?? "/";
        clearStashedReturnPath();
        // Recreate the connection so WebSocket and cached scopes use the new pairing cookie.
        router.history.replace(returnPath);
        router.history.flush();
        window.location.reload();
      }}
      {...(authGateState.errorMessage ? { initialErrorMessage: authGateState.errorMessage } : {})}
    />
  );
}

function PairRoutePendingView() {
  return <PairingPendingSurface />;
}
