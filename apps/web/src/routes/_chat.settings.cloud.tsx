import { createFileRoute } from "@tanstack/react-router";

import { CloudSettings } from "../components/settings/CloudSettings";

export const Route = createFileRoute("/_chat/settings/cloud")({
  component: CloudSettings,
});
