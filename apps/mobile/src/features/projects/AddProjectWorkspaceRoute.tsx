import type { StaticScreenProps } from "@react-navigation/native";
import { AddProjectWorkspaceScreen } from "./AddProjectScreen";

type AddProjectWorkspaceRouteParams = {
  readonly environmentId?: string | string[];
};

export function AddProjectWorkspaceRoute({
  route,
}: StaticScreenProps<AddProjectWorkspaceRouteParams | undefined>) {
  return <AddProjectWorkspaceScreen {...(route.params ?? {})} />;
}
