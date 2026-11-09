import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";

import type { EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";

/** "Showing … for <environment>" on a page that shows one environment at a time. */
export function SettingsEnvironmentPicker({
  label,
  environments,
  value,
  onChange,
}: {
  readonly label: string;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly value: EnvironmentId;
  readonly onChange: (environmentId: EnvironmentId) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-3 text-sm text-muted-foreground sm:px-4">
      <span className="shrink-0">{label}</span>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger size="sm" className="w-auto max-w-72" aria-label="Environment">
          <SelectValue>
            {(selected: EnvironmentId) => {
              const environment = environments.find(
                (candidate) => candidate.environmentId === selected,
              );
              return environment ? settingsScopeEnvironmentLabel(environment, environments) : null;
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {environments.map((environment) => (
            <SelectItem
              hideIndicator
              key={environment.environmentId}
              value={environment.environmentId}
            >
              <span className="flex min-w-0 items-center gap-2">
                <EnvironmentMachineIcon
                  aria-hidden
                  kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                  className="size-3.5 shrink-0"
                />
                <span className="min-w-0 truncate">
                  {settingsScopeEnvironmentLabel(environment, environments)}
                </span>
                {environment.connection.phase !== "connected" ? (
                  <span className="shrink-0 text-xs text-muted-foreground">Offline</span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}
