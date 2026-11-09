import { useAtomValue } from "@effect/atom-react";
import {
  type LinkableMachine,
  linkableMachines,
  linkedEnvironmentNames,
  linkRequestFailureMessage,
  offersAgentLink,
  offersLinkedEnvironments,
} from "@t3tools/client-runtime/link-request";
import { createPeerLinkEnvironmentAtoms } from "@t3tools/client-runtime/state/peerLinks";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessReadScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
  type PeerLink,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { mintPairingCodeOn } from "./peerPairingCode";
import { useEnvironmentIdentities, useEnvironments } from "./environments";
import { environmentPresentations } from "./presentation";
import { relayEnvironmentDiscovery } from "./relay";
import { useEnvironmentQuery } from "./query";
import { useEnvironmentsWithScope } from "./session";
import { useAtomCommand } from "./use-atom-command";

export const peerLinkEnvironment = createPeerLinkEnvironmentAtoms(connectionAtomRuntime);

/** Whether `environmentId` offers links, so its threads may name another machine. */
export const offersLinkedEnvironmentsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    offersLinkedEnvironments(get(environmentPresentations.serverConfigsAtom).get(environmentId)),
  ).pipe(Atom.withLabel(`peer-links:offered:${environmentId}`)),
);

const offersNoLinksAtom = Atom.make(false).pipe(Atom.withLabel("peer-links:offered:none"));

/**
 * The machines `environmentId` links to, by name, while it offers links, and none otherwise.
 * Its agents can read threads there. Listing asks each linked machine whether it answers, so
 * every caller shares one briefly cached list.
 */
export function useLinkedEnvironments(
  environmentId: EnvironmentId | null,
): ReadonlyMap<EnvironmentId, string> {
  const offered = useAtomValue(
    environmentId === null ? offersNoLinksAtom : offersLinkedEnvironmentsAtom(environmentId),
  );
  const identities = useEnvironmentIdentities();
  const links = useEnvironmentQuery(
    offered && environmentId !== null
      ? peerLinkEnvironment.list({ environmentId, input: {} })
      : null,
  );
  return linkedEnvironmentNames({
    links: offered ? (links.data?.links ?? []) : [],
    environments: identities,
  });
}

/** The connected environments that offer links, or at least an agent link to a Pair Cloud. */
export function usePeerLinkHosts() {
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      (offersLinkedEnvironments(environment.serverConfig) ||
        offersAgentLink(environment.serverConfig, environments)),
  );
  const readable = useEnvironmentsWithScope(supported, AuthAccessReadScope);
  return supported.filter((environment) => readable.has(environment.environmentId));
}

/**
 * The user's other machines, for picking one to link `environmentId` to,
 * including those only on their T3 Connect account. Reads that environment's
 * links only while `enabled`, since listing them asks every linked machine
 * whether it answers.
 */
export function useLinkableMachines(environmentId: EnvironmentId, enabled: boolean) {
  const { environments } = useEnvironments();
  const discovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  const refreshDiscovery = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  // Connect hosts are listed only once something asked for them, so ask on open.
  const discoverIfUnasked = useEffectEvent(() => {
    if (discovery.environments.size === 0 && !discovery.refreshing) void refreshDiscovery();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- discovery follows the picker's visibility, which a card's mount or a dialog's open sets
  useEffect(() => {
    if (enabled) discoverIfUnasked();
  }, [enabled]);
  const links = useEnvironmentQuery(
    enabled ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  return linkableMachines({
    environments,
    threadEnvironmentId: environmentId,
    links: links.data?.links ?? [],
    connect: discovery.environments,
  });
}

/** Why linking a machine failed: `minting` when no code could be made there; no message when cancelled. */
interface LinkMachineFailure {
  readonly minting: boolean;
  readonly message: string | null;
}

/**
 * Links `hostEnvironmentId` to `machine` through every address known for it, checked to be it.
 * Without `pairingCode`, mints one there with this client's session, which any member's may.
 */
export function useLinkMachine(hostEnvironmentId: EnvironmentId) {
  const link = useAtomCommand(peerLinkEnvironment.link, { label: "link environment" });
  return async (
    machine: Pick<LinkableMachine, "environmentId" | "label" | "urls">,
    access: AuthMcpClientAccess,
    pairingCode?: string,
  ): Promise<Result.Result<PeerLink, LinkMachineFailure>> => {
    const [url, ...alternateUrls] = machine.urls;
    if (url === undefined) {
      return Result.fail({
        minting: false,
        message: `This app has no address for ${machine.label} that another machine can reach.`,
      });
    }
    const code = pairingCode ?? (await mintPairingCodeOn(machine.environmentId, access));
    if (typeof code !== "string" && Result.isFailure(code)) {
      return Result.fail({ minting: true, message: linkRequestFailureMessage(code.failure) });
    }
    const linked = await link({
      environmentId: hostEnvironmentId,
      input: {
        url,
        ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
        expectedEnvironmentId: machine.environmentId,
        expectedLabel: machine.label,
        pairingCode: typeof code === "string" ? code : code.success,
        access,
      },
    });
    if (linked._tag === "Success") return Result.succeed(linked.value);
    return Result.fail({
      minting: false,
      message: isAtomCommandInterrupted(linked) ? null : String(squashAtomCommandFailure(linked)),
    });
  };
}
