import {
  SANDBOX_ISOLATION_LABELS,
  sandboxMachineCountsLabel,
} from "@t3tools/client-runtime/state/sandbox";
import type { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { sandboxEnvironment, useCloudEnvironmentIds } from "../../state/sandbox";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

function InfoRow(props: { readonly label: string; readonly description: string }) {
  return (
    <View accessible className="bg-grouped-card">
      <ListRowLayout label={props.label} description={props.description} />
    </View>
  );
}

function MachinesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly footer: string | undefined;
}) {
  const config = useEnvironmentServerConfig(props.environmentId);
  // Health runs each driver's checks, so the page reads it once and on Refresh, never on a timer.
  const overview = useEnvironmentQuery(
    sandboxEnvironment.overview({ environmentId: props.environmentId, input: {} }),
  );
  const drivers = config?.settings.sandbox?.drivers ?? [];
  const healths = new Map(overview.data?.drivers.map((health) => [health.driverId, health]) ?? []);
  const pending = overview.isPending ? "Checking…" : (overview.error ?? "Status unknown.");
  const restoreModeSince = config?.settings.sandbox?.restoreModeSince;
  return (
    <SettingsSection
      title={props.title}
      footer={props.footer}
      trailing={
        <Button
          label="Refresh"
          tone="text"
          size="compact"
          disabled={overview.isPending}
          onPress={overview.refresh}
        />
      }
    >
      {restoreModeSince === undefined ? null : (
        <InfoRow
          label="Restore mode"
          description={`Restore mode since ${DateTime.toDate(restoreModeSince).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}. Nothing is destroyed while it is on.`}
        />
      )}
      {drivers.map((driver) => {
        const health = healths.get(driver.id);
        return (
          <InfoRow
            key={driver.id}
            label={driver.label}
            description={
              health === undefined
                ? pending
                : [
                    health.reachable ? SANDBOX_ISOLATION_LABELS[health.isolation] : "Unreachable",
                    health.message,
                  ]
                    .filter(Boolean)
                    .join(". ")
            }
          />
        );
      })}
      <InfoRow
        label="Machines"
        description={overview.data ? sandboxMachineCountsLabel(overview.data.machines) : pending}
      />
      <InfoRow
        label="Base image"
        description={
          overview.data?.baseImage.label ?? config?.settings.sandbox?.baseImage ?? "Pair base"
        }
      />
      <InfoRow
        label="Limits"
        description={[
          ...drivers.map((driver) => {
            const cap = healths.get(driver.id)?.runningCap;
            const count = cap === undefined ? "…" : `${cap} machine${cap === 1 ? "" : "s"}`;
            return `${drivers.length > 1 ? driver.label : "Team"}: ${count} at once`;
          }),
          `${overview.data?.startsPerMinute ?? 10} starts a minute · No member cap`,
        ].join("\n")}
      />
    </SettingsSection>
  );
}

/** Read-only by design: drivers, the base image and caps are set on the web (Settings → Cloud). */
export function SettingsMachinesRouteScreen() {
  const insets = useSafeAreaInsets();
  const environmentIds = useCloudEnvironmentIds();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const content = (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-3 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
      {environmentIds.length === 0 ? (
        <EmptyState
          variant="plain"
          title="No cloud machines"
          detail="None of your connected environments has a Docker driver."
        />
      ) : (
        environmentIds.map((environmentId, index) => (
          <MachinesSection
            key={environmentId}
            environmentId={environmentId}
            title={savedConnectionsById[environmentId]?.environmentLabel ?? "Cloud"}
            footer={
              index === environmentIds.length - 1
                ? "Manage drivers, the base image and cloud variables on the web."
                : undefined
            }
          />
        ))
      )}
    </ScrollView>
  );

  return Platform.OS === "android" ? (
    <SettingsScreen title="Machines">{content}</SettingsScreen>
  ) : (
    <View collapsable={false} className="flex-1 bg-sheet">
      {content}
    </View>
  );
}
