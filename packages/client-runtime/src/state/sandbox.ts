import {
  isSecretReference,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  type EnvironmentId,
  type MemberId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Sandbox,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShellSandbox,
  type SandboxDriverHealth,
  type SandboxId,
  type SandboxOverview,
  type SandboxState,
  type ScopedThreadRef,
  type ServerSettings,
  type TeamMember,
  type TerminalStoppedBy,
} from "@t3tools/contracts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { discardSandbox, retrySandbox, sleepSandbox, wakeSandbox } from "../operations/commands.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import { canMemberDeleteThread, type createTeamEnvironmentAtoms } from "./team.ts";

export type SandboxAction = "wake" | "sleep" | "retry" | "discard";

export interface SandboxStatePresentation {
  /** Header and status line; null says nothing. */
  readonly label: string | null;
  /** Sidebar and mobile list. */
  readonly rowWord: "Starting" | "Waiting" | "Asleep" | "Failed" | null;
  readonly tone: "neutral" | "warning" | "danger";
  readonly composer: "normal" | "queues" | "disabled";
  /** Before the owner-or-admin check: callers hide what actionAllowedAtom denies. */
  readonly actions: ReadonlyArray<SandboxAction>;
  /** Shown disabled with "Only the owner or an admin" when denied, not hidden. */
  readonly ownerOnly: ReadonlyArray<SandboxAction>;
}

const OWNER_ONLY: ReadonlyArray<SandboxAction> = ["sleep", "discard"];

/** The thread menu's words on web and mobile; web's palette names the machine in each instead. */
export const SANDBOX_ACTION_MENU_LABELS: Readonly<Record<SandboxAction, string>> = {
  wake: "Wake machine",
  sleep: "Sleep now",
  retry: "Retry machine",
  discard: "Discard machine",
};

export const SANDBOX_OWNER_ONLY_REASON = "Only the owner or an admin";

export const SANDBOX_DISCARD_CONFIRMATION =
  "Discard this machine? Its disk is deleted; transcript and diffs stay.";

export const SANDBOX_ACTION_FAILURE_TITLES: Readonly<Record<SandboxAction, string>> = {
  wake: "Could not wake the machine",
  sleep: "Could not put the machine to sleep",
  retry: "Could not retry the machine",
  discard: "Could not discard the machine",
};

export const SANDBOX_ISOLATION_LABELS: Readonly<Record<SandboxDriverHealth["isolation"], string>> =
  {
    rootless: "Rootless Docker",
    gvisor: "gVisor",
    runc: "Plain Docker (runc)",
    unknown: "Isolation unknown",
  };

export function sandboxMachineCountsLabel(machines: SandboxOverview["machines"]): string {
  return `${machines.ready} running · ${machines.sleeping} asleep · ${machines.waiting} waiting · ${machines.failed} failed`;
}

const ADMISSION_COPY = {
  "team-cap": "Waiting for a machine: team limit reached",
  "member-cap": "Waiting for a machine: your limit reached",
  "rate-limit": "Waiting for a machine: starting soon",
  draining: "Waiting: Pair Cloud is restarting for an upgrade",
} as const;

/** Why new turns wait while an admin drains the server (`t3 drain`); null when not draining. */
export function drainNoticeLabel(drainingSince: DateTime.Utc | null | undefined): string | null {
  return drainingSince == null
    ? null
    : "Pair Cloud is restarting for an upgrade. New turns start when it's back.";
}

const FAILURE_COPY: Readonly<Record<string, string>> = {
  "driver-removed": "The machine's driver was removed",
  "workspace-failed": "The workspace could not be prepared",
  workspace_preparation_failed: "The workspace could not be prepared",
};

function presentation(
  fields: Omit<SandboxStatePresentation, "ownerOnly" | "tone" | "rowWord" | "actions"> &
    Partial<Pick<SandboxStatePresentation, "tone" | "rowWord" | "actions">>,
): SandboxStatePresentation {
  return { tone: "neutral", rowWord: null, actions: [], ownerOnly: OWNER_ONLY, ...fields };
}

/** A GitHub App with an id and a private key; redacted settings carry the key as a reference. */
export function githubAppConfigured(settings: Pick<ServerSettings, "sourceControlHosts">): boolean {
  const github = settings.sourceControlHosts.github;
  const key = github?.appPrivateKey;
  return (
    typeof github?.appId === "string" &&
    github.appId !== "" &&
    (isSecretReference(key) || (typeof key === "string" && key !== ""))
  );
}

/**
 * Which credential a cloud thread's pushes get: the GitHub App's, else the thread owner's own
 * GitHub (connected or a pasted token), else none, and the push is refused.
 */
export function cloudPushCredential(input: {
  readonly appConfigured: boolean;
  readonly owner: TeamMember | undefined;
}): "app" | "owner" | "missing" {
  if (input.appConfigured) return "app";
  return input.owner?.github?.connected === true ? "owner" : "missing";
}

/**
 * A thread on a machine another member owns, as a fork of a teammate's cloud thread is: its
 * agent can read every credential that machine holds. False on solo servers and local threads.
 */
export function sharesOtherOwnersMachine(
  thread: Pick<OrchestrationV2AppThread, "sandboxId" | "ownerId">,
  sandbox: Pick<OrchestrationV2Sandbox, "ownerMemberId"> | undefined,
): boolean {
  const ownerId = thread.ownerId ?? null;
  return (
    thread.sandboxId !== undefined &&
    ownerId !== null &&
    sandbox?.ownerMemberId != null &&
    sandbox.ownerMemberId !== ownerId
  );
}

export function sandboxStatePresentation(
  summary: OrchestrationV2ThreadShellSandbox,
  thread: { readonly hasActiveRun: boolean },
): SandboxStatePresentation {
  switch (summary.state) {
    case "provisioning":
      return summary.admission === undefined
        ? presentation({ label: "Starting machine", rowWord: "Starting", composer: "queues" })
        : presentation({
            label:
              summary.admission.reason === null
                ? "Waiting for a machine"
                : ADMISSION_COPY[summary.admission.reason],
            rowWord: "Waiting",
            tone: "warning",
            composer: "queues",
          });
    case "ready":
      return summary.runnerConnected === false
        ? presentation({ label: "Reconnecting to machine", tone: "warning", composer: "queues" })
        : presentation({
            label: null,
            composer: "normal",
            actions: thread.hasActiveRun ? [] : ["sleep", "discard"],
          });
    case "sleeping":
      return presentation({
        label: "Asleep",
        rowWord: "Asleep",
        composer: "queues",
        actions: ["wake", "discard"],
      });
    case "waking":
      return presentation({ label: "Waking machine", composer: "queues" });
    case "failed":
      return presentation({
        label:
          (summary.failureCode === undefined ? undefined : FAILURE_COPY[summary.failureCode]) ??
          "Machine failed",
        rowWord: "Failed",
        tone: "danger",
        composer: "disabled",
        actions: ["retry", "discard"],
      });
    case "destroyed":
      return presentation({ label: "Machine discarded", composer: "normal" });
    case null:
      return presentation({ label: "Machine status unknown", composer: "normal" });
  }
}

/** A cloud thread whose machine is not reachable: the server reads its files from the mirror. */
export interface StoppedFiles {
  readonly sandboxId: SandboxId;
  readonly state: SandboxState;
  readonly ownerMemberId: MemberId | null;
  /** The newest ready checkpoint's turn; null before the first. */
  readonly turn: number | null;
  /** Set while the sleep snapshot is what the server reads: no checkpoint is newer. */
  readonly sleepSnapshotAt: DateTime.Utc | null;
}

/** Null for a local thread or a running machine, so file surfaces read the machine as before. */
export function stoppedFilesFromProjection(
  projection: Pick<OrchestrationV2ThreadProjection, "sandbox" | "checkpoints">,
): StoppedFiles | null {
  const sandbox = projection.sandbox;
  if (sandbox == null || (sandbox.state === "ready" && sandbox.runnerLostAt === null)) return null;
  let newest: (typeof projection.checkpoints)[number] | undefined;
  for (const checkpoint of projection.checkpoints) {
    if (checkpoint.status !== "ready" || checkpoint.appRunOrdinal === null) continue;
    if (newest === undefined || DateTime.isGreaterThan(checkpoint.capturedAt, newest.capturedAt)) {
      newest = checkpoint;
    }
  }
  const snapshotAt = sandbox.sleepSnapshotAt ?? null;
  return {
    sandboxId: sandbox.id,
    state: sandbox.state,
    ownerMemberId: sandbox.ownerMemberId,
    turn: newest?.appRunOrdinal ?? null,
    // The server ranks reads by capture time, so a turn after a later wake beats the snapshot.
    sleepSnapshotAt:
      snapshotAt !== null &&
      (newest === undefined || !DateTime.isGreaterThan(newest.capturedAt, snapshotAt))
        ? snapshotAt
        : null,
  };
}

export function sameStoppedFiles(left: StoppedFiles | null, right: StoppedFiles | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.sandboxId === right.sandboxId &&
      left.state === right.state &&
      left.ownerMemberId === right.ownerMemberId &&
      left.turn === right.turn &&
      (left.sleepSnapshotAt === null || right.sleepSnapshotAt === null
        ? left.sleepSnapshotAt === right.sleepSnapshotAt
        : DateTime.Equivalence(left.sleepSnapshotAt, right.sleepSnapshotAt)))
  );
}

/** "14:02" today, with the date on other days, in the viewer's locale. */
function stoppedClockLabel(at: DateTime.Utc, now: DateTime.Utc = DateTime.nowUnsafe()): string {
  const date = DateTime.toDateUtc(at);
  const time = { hour: "2-digit", minute: "2-digit" } as const;
  return date.toDateString() === DateTime.toDateUtc(now).toDateString()
    ? date.toLocaleTimeString(undefined, time)
    : date.toLocaleString(undefined, { month: "short", day: "numeric", ...time });
}

/** What an asleep file, search or Changes read shows, so the viewer knows how old it is. */
export function stoppedReadLabel(
  stopped: Pick<StoppedFiles, "sleepSnapshotAt" | "turn">,
  formatTime: (at: DateTime.Utc) => string = stoppedClockLabel,
): string {
  if (stopped.sleepSnapshotAt !== null) {
    return `As of ${formatTime(stopped.sleepSnapshotAt)}, when the machine slept`;
  }
  return stopped.turn === null ? "No saved turn to show yet" : `As of turn ${stopped.turn}`;
}

/** Why a terminal the server stopped is not running. */
export function terminalStoppedLabel(
  stoppedBy: TerminalStoppedBy,
  formatTime: (at: DateTime.Utc) => string = stoppedClockLabel,
): string {
  const at = DateTime.make(stoppedBy.at);
  const when = Option.isSome(at) ? ` at ${formatTime(DateTime.toUtc(at.value))}` : "";
  return stoppedBy.reason === "sleep"
    ? `Stopped when the machine slept${when}`
    : `Stopped by the server${when}`;
}

export const TERMINAL_ASLEEP_LABEL = "This machine is asleep";

/** A scheduled run's thread whose new machine waits for a slot, as its task shows it; else null. */
export function sandboxWaitingLabel(
  summary: OrchestrationV2ThreadShellSandbox | undefined,
): string | null {
  return summary?.state === "provisioning" && summary.admission !== undefined
    ? sandboxStatePresentation(summary, { hasActiveRun: false }).label
    : null;
}

/** A cloud thread's machine as every surface shows it: one rule for its line, notice and menus. */
export interface SandboxThreadMachine {
  readonly sandboxId: SandboxId;
  readonly state: OrchestrationV2ThreadShellSandbox["state"];
  readonly presentation: SandboxStatePresentation;
  /** What the viewer is offered; empty when this connection cannot operate threads. */
  readonly actions: ReadonlyArray<SandboxAction>;
  /** Offered but shown disabled with SANDBOX_OWNER_ONLY_REASON. */
  readonly ownerOnlyDenied: ReadonlyArray<SandboxAction>;
}

export function createSandboxEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | SecureRandom.SecureRandom | R, E>,
  deps: {
    readonly team: ReturnType<typeof createTeamEnvironmentAtoms>;
    readonly threadShells: {
      readonly quietThreadShellAtom: (
        ref: ScopedThreadRef,
      ) => Atom.Atom<EnvironmentThreadShell | null>;
    };
  },
) {
  const command = (action: SandboxAction, execute: typeof wakeSandbox) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:sandbox:${action}`,
      tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
      execute,
    });
  const commands = {
    wake: command("wake", wakeSandbox),
    sleep: command("sleep", sleepSandbox),
    retry: command("retry", retrySandbox),
    discard: command("discard", discardSandbox),
  };

  const allowedFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.family((action: SandboxAction) =>
      Atom.family((ownerMemberId: MemberId | null) =>
        Atom.make((get) => {
          const scoped = get(
            commands[action].permissionAtom(environmentId, { type: `sandbox.${action}` }),
          );
          if (!scoped || !OWNER_ONLY.includes(action)) return scoped;
          return canMemberDeleteThread({
            members: get(deps.team.membersValueAtom(environmentId)),
            memberId: get(deps.team.currentMemberIdAtom(environmentId)),
            ownerId: ownerMemberId,
          });
        }),
      ),
    ),
  );

  const actionAllowedAtom = (key: {
    readonly environmentId: EnvironmentId;
    readonly action: SandboxAction;
    readonly ownerMemberId: MemberId | null | undefined;
  }) => allowedFamily(key.environmentId)(key.action)(key.ownerMemberId ?? null);

  const machineFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get): SandboxThreadMachine | null => {
      const shell = get(deps.threadShells.quietThreadShellAtom(ref));
      const sandboxId = shell?.source.sandboxId;
      const summary = shell?.source.sandbox;
      if (shell == null || sandboxId === undefined || summary === undefined) return null;
      // A fork or side chat shares its owner thread's machine, which that thread's owner owns;
      // the shell summary has no owner member of its own.
      const ownerThread =
        summary.ownerThreadId === shell.id
          ? shell
          : (get(
              deps.threadShells.quietThreadShellAtom({
                environmentId: ref.environmentId,
                threadId: summary.ownerThreadId,
              }),
            ) ?? shell);
      const ownerMemberId = ownerThread.source.ownerId ?? null;
      const presentation = sandboxStatePresentation(summary, {
        hasActiveRun: shell.runtime?.activeRunId != null,
      });
      const allowed = (action: SandboxAction) =>
        get(actionAllowedAtom({ environmentId: ref.environmentId, action, ownerMemberId }));
      // Wake needs only the command's scope, so it says whether this connection may act at all.
      const actions = allowed("wake") ? presentation.actions : [];
      return {
        sandboxId,
        state: summary.state,
        presentation,
        actions,
        ownerOnlyDenied: actions.filter(
          (action) => presentation.ownerOnly.includes(action) && !allowed(action),
        ),
      };
    }).pipe(Atom.withLabel(`sandbox-thread-machine:${key}`));
  });

  return {
    ...commands,
    /** Settings → Cloud's Overview; health runs each driver's checks, so it is read on demand. */
    overview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:sandbox:overview",
      tag: WS_METHODS.sandboxOverview,
      staleTimeMs: 30_000,
    }),
    /** The thread view's viewer lease (`sandbox.viewing`); see `stepViewerLease`. */
    viewing: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandbox:viewing",
      tag: WS_METHODS.sandboxViewing,
    }),
    /** Boots and discards one machine; settings:write, like the driver it tests. */
    checkDriver: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandbox:check-driver",
      tag: WS_METHODS.sandboxCheckDriver,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.driverId}`,
      },
    }),
    /** Ends a drain (`t3 drain`), which releases the turns it held; environment:maintain. */
    cancelDrain: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:cancel-drain",
      tag: WS_METHODS.serverCancelDrain,
    }),
    /** The command's scope, then the delete rule (owner or admin in team mode) for sleep and discard. */
    actionAllowedAtom,
    /** Null for a local thread. Read from the shell, so it never subscribes to the transcript. */
    threadMachineAtom: (ref: ScopedThreadRef) => machineFamily(threadKey(ref)),
  };
}
