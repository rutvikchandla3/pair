import type { CloudTarget, PairCloudWorkspace } from "@t3tools/client-runtime/state/cloud-target";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { type EnvironmentId, type ProjectId, repositoryGroupingKeyOf } from "@t3tools/contracts";

interface NewTaskCloudOption {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly disabledReason: string | null;
  /** Create this workspace on that Pair Cloud from its repositories there, then launch. */
  readonly create?: { readonly label: string; readonly workspace: PairCloudWorkspace };
}

/** The selected project's Cloud entry, mapped from `resolveCloudTarget`. */
export interface NewTaskCloud {
  /** False when no paired environment reports cloudLaunch: the phone shows nothing new (D17). */
  readonly offered: boolean;
  readonly options: ReadonlyArray<NewTaskCloudOption>;
  readonly available: boolean;
  /** Why Cloud can't launch, while it is offered. */
  readonly message: string | null;
  /** Where Cloud launches, while available. */
  readonly target: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly label: string;
  } | null;
  /** The target is a Pair Cloud project other than the selected one. */
  readonly routed: boolean;
}

export const NO_NEW_TASK_CLOUD: NewTaskCloud = {
  offered: false,
  options: [],
  available: false,
  message: null,
  target: null,
  routed: false,
};

/** The draft's pick (`cloudEnvironmentId`) wins, else the first launchable target. */
export function resolveNewTaskCloud(input: {
  readonly cloudTarget: CloudTarget;
  readonly project: Pick<EnvironmentProject, "environmentId" | "repositoryIdentity">;
  readonly cloudEnvironmentId: EnvironmentId | undefined;
}): NewTaskCloud {
  const { cloudTarget, project } = input;
  if (cloudTarget.kind === "hidden") return NO_NEW_TASK_CLOUD;
  if (cloudTarget.kind === "unavailable") {
    return { ...NO_NEW_TASK_CLOUD, offered: true, message: cloudTarget.message };
  }
  const repository = project.repositoryIdentity
    ? repositoryGroupingKeyOf(project.repositoryIdentity).replace(/^github\.com\//i, "")
    : "this repo";
  const several = cloudTarget.targets.length > 1;
  const options = cloudTarget.targets.map((target) => ({
    target,
    option: {
      environmentId: target.environmentId,
      title: target.createWorkspace
        ? several
          ? `Create on ${target.label}`
          : "Create on Pair Cloud"
        : several
          ? `Cloud on ${target.label}`
          : "Cloud",
      disabledReason:
        target.disabledReason ??
        (target.projectId === null && !target.createWorkspace
          ? `Add ${repository} to ${target.label} first.`
          : null),
      ...(target.createWorkspace
        ? { create: { label: target.label, workspace: target.createWorkspace } }
        : {}),
    } satisfies NewTaskCloudOption,
  }));
  // A launchable target beats one that must create the workspace first.
  const chosen =
    options.find(({ target }) => target.environmentId === input.cloudEnvironmentId) ??
    options.find(({ option, target }) => option.disabledReason === null && target.projectId) ??
    options.find(({ option }) => option.disabledReason === null) ??
    options[0];
  const launchable =
    chosen !== undefined && chosen.option.disabledReason === null && chosen.target.projectId
      ? {
          environmentId: chosen.target.environmentId,
          projectId: chosen.target.projectId,
          label: chosen.target.label,
        }
      : null;
  const message =
    launchable !== null || chosen === undefined
      ? null
      : (chosen.option.disabledReason ??
        (chosen.option.create ? `Create this workspace on ${chosen.target.label} first.` : null));
  return {
    offered: true,
    options: options.map(({ option }) => option),
    available: launchable !== null,
    message,
    target: launchable,
    routed: launchable !== null && launchable.environmentId !== project.environmentId,
  };
}
