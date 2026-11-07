import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type MemberId,
  type OrchestrationV2ThreadShellSandbox,
  type TeamMember,
} from "@t3tools/contracts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { discardSandbox, retrySandbox, sleepSandbox, wakeSandbox } from "../operations/commands.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";
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

const ADMISSION_COPY = {
  "team-cap": "Waiting for a machine: team limit reached",
  "member-cap": "Waiting for a machine: your limit reached",
  "rate-limit": "Waiting for a machine: starting soon",
} as const;

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

export function createSandboxEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | SecureRandom.SecureRandom | R, E>,
  deps: { readonly team: ReturnType<typeof createTeamEnvironmentAtoms> },
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

  return {
    ...commands,
    /** The command's scope, then the delete rule (owner or admin in team mode) for sleep and discard. */
    actionAllowedAtom: (key: {
      readonly environmentId: EnvironmentId;
      readonly action: SandboxAction;
      readonly ownerMemberId: MemberId | null | undefined;
    }) => allowedFamily(key.environmentId)(key.action)(key.ownerMemberId ?? null),
  };
}
