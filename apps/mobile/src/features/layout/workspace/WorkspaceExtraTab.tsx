import { type NavigationTab } from "./navigation-tab-order";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { BotsScreen } from "../../bots/BotsScreen";
import { UsageRouteScreen } from "../../usage/UsageRouteScreen";

export function WorkspaceExtraTab(props: { tab: Extract<NavigationTab, "usage" | "bots"> }) {
  return (
    <>
      <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      {props.tab === "bots" ? <BotsScreen /> : <UsageRouteScreen workspace />}
    </>
  );
}
