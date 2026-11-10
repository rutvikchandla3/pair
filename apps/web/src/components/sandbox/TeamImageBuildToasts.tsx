import { useAtomValue } from "@effect/atom-react";
import { teamImageFinishedMessage } from "@t3tools/client-runtime/team-image-presentation";
import type { EnvironmentId, MemberId, TeamImageBuild, TeamImageBuildId } from "@t3tools/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { useCurrentMemberId } from "~/state/team";
import { teamImageEnvironment, teamImageEnvironmentIdsAtom } from "~/state/teamImage";
import { stackedThreadToast, toastManager } from "../ui/toast";

const TEAM_IMAGE_SECTION = "cloud-team-image";

const isEnded = (status: TeamImageBuild["status"]) =>
  status === "succeeded" || status === "failed" || status === "cancelled";

const requestedByViewer = (build: TeamImageBuild, viewer: MemberId | null) =>
  viewer !== null &&
  (build.requestedBy.kind === "member"
    ? build.requestedBy.memberId === viewer
    : build.requestedBy.authorIds.includes(viewer));

/** Tells whoever started a build, or prompted the agent that did, when it ends. */
export function TeamImageBuildToasts() {
  return useAtomValue(teamImageEnvironmentIdsAtom).map((environmentId) => (
    <EnvironmentBuildToasts key={environmentId} environmentId={environmentId} />
  ));
}

/** Only where the viewer may change the image: others are not pinged (05 §8). */
function EnvironmentBuildToasts({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const mayChange = useAtomValue(teamImageEnvironment.saveRecipe.permissionAtom(environmentId));
  return mayChange ? <WatchBuilds environmentId={environmentId} /> : null;
}

function WatchBuilds({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const snapshot = useEnvironmentQuery(
    teamImageEnvironment.snapshot({ environmentId, input: {} }),
  ).data;
  const viewer = useCurrentMemberId(environmentId);
  const router = useRouter();
  const navigate = useNavigate();
  const statuses = useRef<Map<TeamImageBuildId, TeamImageBuild["status"]> | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- compares each snapshot with the last to toast a build that just ended, an imperative toastManager call
  useEffect(() => {
    if (snapshot === null) return;
    const previous = statuses.current;
    statuses.current = new Map(snapshot.builds.map((build) => [build.id, build.status]));
    // The first snapshot is history, not news. A build we never saw run has nothing to announce.
    if (previous === null) return;
    // Read when the build ends, so a page opened since still counts as open.
    if (router.state.location.pathname.startsWith("/settings/cloud")) return;
    for (const build of snapshot.builds) {
      const was = previous.get(build.id);
      if (was === undefined || isEnded(was) || !isEnded(build.status)) continue;
      if (!requestedByViewer(build, viewer)) continue;
      const message = teamImageFinishedMessage(build, snapshot.activeBuildId);
      if (message === null) continue;
      toastManager.add(
        stackedThreadToast({
          type: build.status === "succeeded" ? "success" : "error",
          title: message,
          actionProps: {
            children: "Open Team image",
            onClick: () =>
              void navigate({
                to: "/settings/cloud",
                search: { machine: environmentId },
                hash: TEAM_IMAGE_SECTION,
                hashScrollIntoView: false,
              }),
          },
        }),
      );
    }
  }, [snapshot, viewer, router, navigate, environmentId]);

  return null;
}
