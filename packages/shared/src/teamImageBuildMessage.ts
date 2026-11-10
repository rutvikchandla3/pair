import type { TeamImageBuild, TeamImageBuildId } from "@t3tools/contracts";

/**
 * A build reached an end state; the line its requester is told on web and phone, or null when
 * there is nothing to say. It lives here so the server's push and the web toast share one copy.
 */
export function teamImageFinishedMessage(
  build: Pick<TeamImageBuild, "id" | "number" | "status" | "failure">,
  activeBuildId: TeamImageBuildId | null,
): string | null {
  const label = `Build ${build.number}`;
  switch (build.status) {
    case "succeeded":
      return build.id === activeBuildId
        ? `${label} is active.`
        : `${label} is ready. Activate it in Team image.`;
    case "failed": {
      const phase = build.failure?.phase;
      if (phase === undefined) return `${label} failed.`;
      if (phase === "interrupted") return `${label} was interrupted by a restart.`;
      if (phase === "timed-out") return `${label} ran past 45 minutes.`;
      if (phase === "leak") return `${label} failed: a secret was found in the image.`;
      return `${label} failed at ${phase}.`;
    }
    default:
      return null;
  }
}
