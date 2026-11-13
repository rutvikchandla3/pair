import { createFileRoute } from "@tanstack/react-router";

import { SpaceTaskRoutePage } from "../components/spaces/SpaceRoomPage";

// Task pushes and copied links open here (`/spaces/<env>/<spaceId>/tasks/<taskId>`).
export const Route = createFileRoute("/_chat/spaces/$environmentId/$spaceId_/tasks/$taskId")({
  component: SpaceTaskRoutePage,
});
