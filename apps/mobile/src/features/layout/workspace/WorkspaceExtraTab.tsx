import { type NavigationTab } from "./navigation-tab-order";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { BotsScreen } from "../../bots/BotsScreen";
import { UsageRouteScreen } from "../../usage/UsageRouteScreen";
import { WorkflowsScreen } from "../../workflows/WorkflowsScreen";

export function WorkspaceExtraTab(props: {
  tab: Extract<NavigationTab, "usage" | "bots" | "workflows">;
}) {
  return (
    <>
      <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      {props.tab === "bots" ? (
        <BotsScreen />
      ) : props.tab === "workflows" ? (
        <WorkflowsScreen />
      ) : (
        <UsageRouteScreen workspace />
      )}
    </>
  );
}
