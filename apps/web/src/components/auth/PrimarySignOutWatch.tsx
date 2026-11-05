import { useAtomValue } from "@effect/atom-react";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { fetchSessionState } from "~/environments/primary/auth";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

const primaryAuthenticationBlockedAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return false;
  const state = AsyncResult.getOrElse(
    get(environmentCatalog.stateAtom(environmentId)),
    () => AVAILABLE_CONNECTION_STATE,
  );
  return state.phase === "blocked" && state.lastFailure?.reason === "authentication";
}).pipe(Atom.withLabel("web-primary-authentication-blocked"));

/** Sends a browser the primary signed out (a removed member, a revoked device) back through the auth gate. */
export function PrimarySignOutWatch() {
  const blocked = useAtomValue(primaryAuthenticationBlockedAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reloads the page when the server's session check says signed out
  useEffect(() => {
    if (!blocked) return;
    let current = true;
    // Only the cookie gate's own answer reloads: desktop's bearer can be refused while its cookie is fine.
    void fetchSessionState().then(
      (session) => {
        if (current && !session.authenticated) window.location.reload();
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [blocked]);
  return null;
}
