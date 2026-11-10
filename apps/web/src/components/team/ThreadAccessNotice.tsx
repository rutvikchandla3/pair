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
          {reason === "revoked"
            ? "You no longer have access to this thread."
            : "This thread is private, or it no longer exists. Ask its owner to share it with you."}
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
