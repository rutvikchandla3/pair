import { createFileRoute } from "@tanstack/react-router";

import { TeamSettings } from "../components/team/TeamSettings";

export const Route = createFileRoute("/_chat/settings/team")({
  component: TeamSettings,
});
