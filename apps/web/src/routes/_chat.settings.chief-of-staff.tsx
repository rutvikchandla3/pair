import { createFileRoute } from "@tanstack/react-router";
import { ChiefOfStaffSettingsPanel } from "../components/settings/ChiefOfStaffSettingsPanel";

export const Route = createFileRoute("/_chat/settings/chief-of-staff")({
  component: ChiefOfStaffSettingsPanel,
});
