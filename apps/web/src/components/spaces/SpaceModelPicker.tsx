import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";

/** The picked model, or the project's default when nothing is picked yet. */
export function useSpaceModelSelection(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  picked: ModelSelection | null,
) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, projectId);
  const selection =
    picked ??
    scheduledTaskDefaultModel(settings, projectId === null ? null : { id: projectId }, entries);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  return { selection, entries, modelOptionsByInstance };
}

export function SpaceModelPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly value: ModelSelection | null;
  readonly disabled?: boolean;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const { selection, entries, modelOptionsByInstance } = useSpaceModelSelection(
    props.environmentId,
    props.projectId,
    props.value,
  );
  return (
    <ProviderModelPicker
      environmentId={props.environmentId}
      disabled={props.disabled ?? false}
      activeInstanceId={selection?.instanceId ?? ("" as ProviderInstanceId)}
      model={selection?.model ?? ""}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={modelOptionsByInstance}
      isComposerOwned={false}
      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
      onInstanceModelChange={(instanceId, model) => props.onChange({ instanceId, model })}
    />
  );
}
