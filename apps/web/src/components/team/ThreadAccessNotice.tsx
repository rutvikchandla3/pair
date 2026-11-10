import {
  THREAD_ACCESS_REVOKED_MESSAGE,
  THREAD_PRIVATE_OR_GONE_MESSAGE,
} from "@t3tools/client-runtime/state/share-thread";
import { useNavigate } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";

/** In place of a thread this member cannot open. It never says which thread, or whose. */
export function ThreadAccessNotice({ reason }: { readonly reason: "revoked" | "private" }) {
  const navigate = useNavigate();
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LockIcon />
        </EmptyMedia>
        <EmptyTitle>
          {reason === "revoked" ? THREAD_ACCESS_REVOKED_MESSAGE : THREAD_PRIVATE_OR_GONE_MESSAGE}
        </EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={() => void navigate({ to: "/", replace: true })}>
          Back to threads
        </Button>
      </EmptyContent>
    </Empty>
  );
}
