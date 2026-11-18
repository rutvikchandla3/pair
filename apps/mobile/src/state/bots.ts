import { useAtomValue } from "@effect/atom-react";
import { type BotsSnapshot, type EnvironmentId } from "@t3tools/contracts";
import { createBotsEnvironmentAtoms } from "@t3tools/client-runtime/state/bots";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { connectedEnvironmentIdsAtom } from "./presentation";
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

/** Bots live on the primary (first connected) environment. */
export function usePrimaryEnvironmentId(): EnvironmentId | null {
  return useAtomValue(connectedEnvironmentIdsAtom)[0] ?? null;
}

/** The Bots mutations the mobile screens run, all against the screen's environment. */
export function useBotsCommands() {
  return {
    create: useAtomCommand(botsEnvironment.create, { reportFailure: false }),
    createJob: useAtomCommand(botsEnvironment.createJob, { reportFailure: false }),
    answerAsk: useAtomCommand(botsEnvironment.answerAsk, { reportFailure: false }),
    rememberAsk: useAtomCommand(botsEnvironment.rememberAsk, { reportFailure: false }),
    stopJob: useAtomCommand(botsEnvironment.stopJob, { reportFailure: false }),
    markSeen: useAtomCommand(botsEnvironment.markSeen, { reportFailure: false }),
  };
}
