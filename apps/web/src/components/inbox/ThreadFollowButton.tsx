import type { ScopedThreadRef } from "@t3tools/contracts";
import { EyeIcon } from "lucide-react";

import { useThreadShell } from "../../state/entities";
import { useSetThreadFollowed, useThreadFollowing } from "../../state/team";
import { toastCommandFailure } from "../team/toastCommandFailure";
import { Button } from "../ui/button";

/** Follow or unfollow a teammate's thread; nothing where Follow doesn't apply. */
export function ThreadFollowButton(props: {
  readonly thread: ScopedThreadRef;
  readonly className?: string;
}) {
  const following = useThreadFollowing(useThreadShell(props.thread));
  const setFollowed = useSetThreadFollowed();
  if (following === null) return null;
  return (
    <Button
      size="xs"
      variant="outline"
      className={props.className}
      onClick={async (event) => {
        event.preventDefault();
        event.stopPropagation();
        toastCommandFailure(
          following ? "Could not unfollow" : "Could not follow",
          await setFollowed(props.thread, !following),
        );
      }}
    >
      <EyeIcon />
      {following ? "Following" : "Follow"}
    </Button>
  );
}
