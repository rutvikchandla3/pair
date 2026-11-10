import type {
  MemberId,
  TeamImageBuild,
  TeamImageBuildFailure,
  TeamImageBuildId,
  TeamImageBuildPhase,
  TeamImageCurrentBase,
} from "@t3tools/contracts";

/** One words-and-tone rule for a build, written once for web and mobile (05 §8). */
export interface TeamImageBuildPresentation {
  /** The status word: "Active", "Ready", "Succeeded", "Building · install", and so on. */
  readonly status: string;
  readonly tone: "neutral" | "success" | "progress" | "danger";
  /** Queued, launching, running or capturing: a cancel is possible and the log is live. */
  readonly inProgress: boolean;
  /** "Alice", or "agent, prompted by Alice". */
  readonly requester: string;
  /** Why it failed, for a failed build; null otherwise. */
  readonly failure: string | null;
  /** The build can be made active: succeeded, not active, and its image is still there. */
  readonly canActivate: boolean;
}

export interface TeamImageBuildPresentationOptions {
  /** A member's display name; the default says "a member". */
  readonly memberName?: (memberId: MemberId) => string | null | undefined;
  /** The active build's number, so a succeeded agent build newer than it reads "Ready". */
  readonly activeBuildNumber?: number | null | undefined;
}

const PHASE_WORDS: Readonly<Record<TeamImageBuildPhase, string>> = {
  launch: "launch",
  preflight: "preflight",
  clone: "clone",
  install: "install",
  env: "env",
  verify: "verify",
  clean: "clean",
  manifest: "manifest",
  capture: "capture",
};

const IMAGE_REMOVED_WORD = "Image removed";

/**
 * The failure as a sentence. The server's `detail` is already written for people and never holds a
 * secret's value, so a phase with nothing better to say shows it as is.
 */
export function teamImageFailureMessage(failure: TeamImageBuildFailure): string {
  const detail = failure.detail.trim();
  switch (failure.phase) {
    case "clone":
      return "Could not clone a project. Check that the GitHub App can read it.";
    case "install":
      return failure.exitCode === undefined
        ? detail || "The install script failed."
        : `The install script exited with ${failure.exitCode}.`;
    case "verify":
      // Without an exit code the program passed and the server's check of the saved image failed.
      return failure.exitCode === undefined && detail
        ? detail
        : "A provider is not runnable in this build. The log shows which command failed.";
    case "interrupted":
      return "The server restarted during this build.";
    case "timed-out":
      return "The build ran past 45 minutes.";
    case "leak":
      return detail || "A secret's value was found in the image.";
    default:
      return detail || `The build failed during ${PHASE_WORDS[failure.phase]}.`;
  }
}

function requesterLine(
  build: Pick<TeamImageBuild, "requestedBy">,
  options: TeamImageBuildPresentationOptions,
): string {
  const name = (id: MemberId) => options.memberName?.(id)?.trim() || "a member";
  const requester = build.requestedBy;
  if (requester.kind === "member") return name(requester.memberId);
  const authors = [...new Set(requester.authorIds)].map(name);
  return authors.length === 0 ? "agent" : `agent, prompted by ${authors.join(", ")}`;
}

export function teamImageBuildPresentation(
  build: TeamImageBuild,
  activeBuildId: TeamImageBuildId | null,
  options: TeamImageBuildPresentationOptions = {},
): TeamImageBuildPresentation {
  const requester = requesterLine(build, options);
  const base = { requester, failure: null, canActivate: false } as const;
  switch (build.status) {
    case "queued":
      return { ...base, status: "Queued", tone: "progress", inProgress: true };
    case "launching":
    case "running":
    case "capturing": {
      const phase = build.status === "capturing" ? "capture" : (build.phase ?? "launch");
      return {
        ...base,
        status: `Building · ${PHASE_WORDS[phase]}`,
        tone: "progress",
        inProgress: true,
      };
    }
    case "failed":
      return {
        ...base,
        status: "Failed",
        tone: "danger",
        inProgress: false,
        failure: build.failure === undefined ? null : teamImageFailureMessage(build.failure),
      };
    case "cancelled":
      return { ...base, status: "Cancelled", tone: "neutral", inProgress: false };
    case "succeeded": {
      if (build.id === activeBuildId) {
        return { ...base, status: "Active", tone: "success", inProgress: false };
      }
      if (build.imageDeletedAt !== null) {
        return {
          ...base,
          status: IMAGE_REMOVED_WORD,
          tone: "neutral",
          inProgress: false,
        };
      }
      const awaitsActivation =
        !build.activateOnSuccess &&
        (options.activeBuildNumber == null || build.number > options.activeBuildNumber);
      return {
        ...base,
        status: awaitsActivation ? "Ready" : "Succeeded",
        tone: awaitsActivation ? "success" : "neutral",
        inProgress: false,
        canActivate: true,
      };
    }
  }
}

export { teamImageFinishedMessage } from "@t3tools/shared/teamImageBuildMessage";

/** "Build 14 · Pair base 0.1.7": the image line of the active build, as Overview shows it. */
export function teamImageImageLine(build: Pick<TeamImageBuild, "number" | "manifest">): string {
  return build.manifest === undefined
    ? `Build ${build.number}`
    : `Build ${build.number} · Pair base ${build.manifest.base.pairVersion}`;
}

/**
 * "Rebuild to update" for the active build, or null when it is current or the two bases can't be
 * compared. Digests settle it when both are known (a digest names exactly one image); otherwise
 * the versions do, and only when both exist. A pinned override that resolves to the build's own
 * image never nags.
 */
export function rebuildSuggestion(
  activeBuild: Pick<TeamImageBuild, "manifest"> | null | undefined,
  currentBase: TeamImageCurrentBase | null | undefined,
): string | null {
  const built = activeBuild?.manifest?.base;
  if (built === undefined || currentBase == null) return null;
  const stale =
    built.digest !== null && currentBase.digest !== null
      ? built.digest !== currentBase.digest
      : currentBase.version !== null && currentBase.version !== built.pairVersion;
  if (!stale) return null;
  const builtOn = `Built on Pair base ${built.pairVersion}.`;
  return currentBase.version !== null && currentBase.version !== built.pairVersion
    ? `${builtOn} This server runs ${currentBase.version}. Rebuild to update provider CLIs.`
    : `${builtOn} This server's base image has changed. Rebuild to update provider CLIs.`;
}
