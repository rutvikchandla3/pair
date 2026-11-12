import { createFileRoute } from "@tanstack/react-router";

import { SpaceRoomPage } from "../components/spaces/SpaceRoomPage";

// Push notifications link here (`/spaces/<env>/<spaceId>`), so keep the path stable.
export const Route = createFileRoute("/_chat/spaces/$environmentId/$spaceId")({
  component: SpaceRoomPage,
});
