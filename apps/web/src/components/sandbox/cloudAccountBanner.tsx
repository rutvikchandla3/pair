import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { KeyRoundIcon } from "lucide-react";

import { cloudAccountNoticeAtom } from "../../state/sandbox";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { Button } from "../ui/button";

const NO_NOTICE_ATOM = Atom.make(null).pipe(Atom.withLabel("cloud-account-notice:none"));

/**
 * A Cloud draft whose Pair Cloud has no account this member can run, or no GitHub to clone and
 * push with. `environmentId` is the draft's resolved Pair Cloud target, never the Mac.
 */
export function useCloudAccountBanner(
  environmentId: EnvironmentId | null,
): ComposerBannerStackItem | null {
  const notice = useAtomValue(
    environmentId === null ? NO_NOTICE_ATOM : cloudAccountNoticeAtom(environmentId),
  );
  if (notice === null || environmentId === null) return null;
  return {
    id: `cloud-account:${environmentId}:${notice.kind}`,
    variant: "warning",
    icon: <KeyRoundIcon />,
    title: notice.title,
    description: notice.description,
    actions: (
      <Button
        size="xs"
        variant="outline"
        render={<Link to="/settings/team" search={{ machine: environmentId }} />}
      >
        Open Settings
      </Button>
    ),
  };
}
