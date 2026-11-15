import { createFileRoute } from "@tanstack/react-router";

import { SharedWithYouPage } from "../components/inbox/SharedWithYouPage";

export const Route = createFileRoute("/_chat/shared")({
  component: SharedWithYouPage,
});
