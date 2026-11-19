import { useAtomValue } from "@effect/atom-react";
import {
  type BotsSnapshot,
  type EnvironmentId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { createBotsEnvironmentAtoms } from "@t3tools/client-runtime/state/bots";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { type BotsEnvironmentEntry, botsEnvironmentStatus } from "../features/bots/botsModel";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { useAtomCommand } from "./use-atom-command";

const botsEnvironment = createBotsEnvironmentAtoms(connectionAtomRuntime);

const snapshotValueFamily = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): BotsSnapshot | null =>
    Option.getOrNull(
      AsyncResult.value(get(botsEnvironment.snapshot({ environmentId, input: undefined }))),
    ),
  ).pipe(Atom.withLabel(`mobile-bots-snapshot-value:${environmentId}`)),
);

const NO_SNAPSHOT_ATOM = Atom.make<BotsSnapshot | null>(null).pipe(
  Atom.withLabel("mobile-bots-snapshot:none"),
);

/** The whole Bots snapshot; reading it keeps `bots.subscribe` open. Null while loading. */
export function useBotsSnapshot(environmentId: EnvironmentId | null): BotsSnapshot | null {
  return useAtomValue(
    environmentId === null ? NO_SNAPSHOT_ATOM : snapshotValueFamily(environmentId),
  );
}

/** Every enabled server's Bots, in saved order; reading it keeps each `bots.subscribe` open. */
const botsEnvironmentsAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const entries = [...enabledEnvironmentIds(catalog)].flatMap(
    (environmentId): BotsEnvironmentEntry[] => {
      const presentation = get(environmentPresentations.presentationAtom(environmentId));
      if (presentation === null) return [];
      const result = get(botsEnvironment.snapshot({ environmentId, input: undefined }));
      const status = botsEnvironmentStatus(
        presentation.connection.phase,
        AsyncResult.isSuccess(result)
          ? "success"
          : AsyncResult.isFailure(result)
            ? "failure"
            : "pending",
      );
      return [
        {
          environmentId,
          label: presentation.entry.target.label,
          machineKind: resolveEnvironmentMachineKind(presentation.serverConfig),
          status,
          snapshot: Option.getOrNull(AsyncResult.value(result)),
          canCreate:
            status === "loaded" && get(botsEnvironment.create.permissionAtom(environmentId)),
        },
      ];
    },
  );
  return { catalogReady: catalog.isReady, entries };
}).pipe(Atom.withLabel("mobile-bots-environments"));

export function useBotsEnvironments() {
  return useAtomValue(botsEnvironmentsAtom);
}

/** Restarts a server's Bots subscription after it failed. */
export function retryBotsSnapshot(environmentId: EnvironmentId) {
  appAtomRegistry.refresh(botsEnvironment.snapshot({ environmentId, input: undefined }));
}

/** The Bots mutations the mobile screens run, all against the screen's environment. */
export function useBotsCommands() {
  return {
    create: useAtomCommand(botsEnvironment.create, { reportFailure: false }),
    createJob: useAtomCommand(botsEnvironment.createJob, { reportFailure: false }),
    answerAsk: useAtomCommand(botsEnvironment.answerAsk, { reportFailure: false }),
    rememberAsk: useAtomCommand(botsEnvironment.rememberAsk, { reportFailure: false }),
    stopJob: useAtomCommand(botsEnvironment.stopJob, { reportFailure: false }),
    archiveJob: useAtomCommand(botsEnvironment.archiveJob, { reportFailure: false }),
    markSeen: useAtomCommand(botsEnvironment.markSeen, { reportFailure: false }),
  };
}
