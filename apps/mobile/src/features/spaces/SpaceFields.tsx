import type { MenuAction } from "@react-native-menu/menu";
import { type SpaceViewer, spacePairBillingLabel } from "@t3tools/client-runtime/spaces";
import { activeTeamMembers } from "@t3tools/client-runtime/state/team";
import type {
  EnvironmentId,
  MemberId,
  ModelSelection,
  ProjectId,
  SpacePairBilling,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { MemberAvatar } from "../../components/MemberAvatar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import {
  buildModelOptions,
  filterModelOptionsForViewer,
  groupByProvider,
} from "../../lib/modelOptions";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { useTeamRoster, useTeamViewer } from "../../state/team";
import { scheduledTaskDefaultModel } from "../settings/scheduledTaskDraft";

export function SpaceField(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-t3-medium text-foreground-muted">{props.label}</Text>
      {props.children}
    </View>
  );
}

export function SpaceTextField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly placeholder?: string;
  readonly multiline?: boolean;
  readonly autoFocus?: boolean;
  readonly editable?: boolean;
  readonly onBlur?: () => void;
}) {
  return (
    <SpaceField label={props.label}>
      <TextInput
        accessibilityLabel={props.label}
        autoFocus={props.autoFocus}
        multiline={props.multiline}
        editable={props.editable}
        value={props.value}
        placeholder={props.placeholder}
        placeholderTextColorClassName="accent-foreground-muted"
        onChangeText={props.onChangeText}
        onBlur={props.onBlur}
        className={
          props.multiline
            ? "min-h-24 rounded-xl bg-subtle px-4 py-3 text-base text-foreground"
            : "min-h-12 rounded-xl bg-subtle px-4 text-base text-foreground"
        }
      />
    </SpaceField>
  );
}

/** A labelled value that opens a native menu of choices; plain text when there is nothing to pick. */
export function SpaceSelectRow(props: {
  readonly label: string;
  readonly value: string;
  readonly actions: MenuAction[];
  readonly disabled?: boolean;
  readonly onSelect: (id: string) => void;
}) {
  const row = (
    <View className="min-h-12 flex-row items-center gap-2 rounded-xl bg-subtle px-4">
      <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
        {props.value}
      </Text>
      {props.disabled || props.actions.length === 0 ? null : (
        <SymbolView name="chevron.down" size={14} tintColorClassName="accent-icon-muted" />
      )}
    </View>
  );
  return (
    <SpaceField label={props.label}>
      {props.disabled || props.actions.length === 0 ? (
        row
      ) : (
        <Menu
          actions={props.actions}
          onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${props.label}, ${props.value}`}
            className="active:opacity-70"
          >
            {row}
          </Pressable>
        </Menu>
      )}
    </SpaceField>
  );
}

export function SpaceProjectRow(props: {
  readonly environmentId: EnvironmentId;
  readonly value: ProjectId | null;
  readonly disabled?: boolean;
  readonly onChange: (projectId: ProjectId) => void;
}) {
  const projects = useProjects().filter(
    (project) => project.environmentId === props.environmentId && project.isScratch !== true,
  );
  const selected = projects.find((project) => project.id === props.value);
  return (
    <SpaceSelectRow
      label="Project"
      value={selected?.title ?? "Choose a project"}
      disabled={props.disabled}
      actions={projects.map((project) => ({
        id: project.id,
        title: project.title,
        state: project.id === props.value ? "on" : "off",
      }))}
      onSelect={(id) => {
        const project = projects.find((candidate) => candidate.id === id);
        if (project !== undefined) props.onChange(project.id);
      }}
    />
  );
}

export function SpaceBillingRow(props: {
  readonly value: SpacePairBilling;
  readonly viewer: SpaceViewer;
  readonly disabled?: boolean;
  readonly onChange: (billing: SpacePairBilling) => void;
}) {
  const me = props.viewer.memberId;
  const key = props.value.type === "team" ? "team" : props.value.memberId;
  const actions: MenuAction[] = [
    { id: "team", title: "Team Claude key", state: key === "team" ? "on" : "off" },
    ...(me === null
      ? []
      : [
          {
            id: me,
            title: "Your Claude account",
            state: key === me ? ("on" as const) : ("off" as const),
          },
        ]),
  ];
  return (
    <SpaceSelectRow
      label="Pair replies use"
      value={spacePairBillingLabel(props.value, props.viewer)}
      disabled={props.disabled}
      actions={actions}
      onSelect={(id) =>
        props.onChange(
          id === "team" ? { type: "team" } : { type: "member", memberId: id as MemberId },
        )
      }
    />
  );
}

export function SpaceMemberChecklist(props: {
  readonly environmentId: EnvironmentId;
  readonly exclude: ReadonlySet<string>;
  readonly value: ReadonlySet<MemberId>;
  readonly onChange: (value: ReadonlySet<MemberId>) => void;
}) {
  const { members } = useTeamRoster(props.environmentId);
  const roster = activeTeamMembers(members).filter((member) => !props.exclude.has(member.id));
  if (roster.length === 0) {
    return (
      <Text className="text-sm text-foreground-muted">Everyone on the team is already here.</Text>
    );
  }
  return (
    <View>
      {roster.map((member) => {
        const selected = props.value.has(member.id);
        return (
          <Pressable
            key={member.id}
            accessibilityRole="checkbox"
            accessibilityLabel={member.name}
            accessibilityState={{ checked: selected }}
            onPress={() => {
              const next = new Set(props.value);
              if (!next.delete(member.id)) next.add(member.id);
              props.onChange(next);
            }}
            className="min-h-12 flex-row items-center gap-3 border-t border-border-subtle active:opacity-70"
          >
            <MemberAvatar member={member} />
            <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
              {member.name}
            </Text>
            {selected ? (
              <SymbolView name="checkmark" size={16} tintColorClassName="accent-icon" />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** The picked model, or the project's default when nothing is picked yet, as web does. */
export function useSpaceModel(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  picked: ModelSelection | null,
) {
  const config = useEnvironmentServerConfig(environmentId);
  const viewer = useTeamViewer(environmentId);
  const project = useProjects().find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  const selection =
    picked ?? scheduledTaskDefaultModel(config, project === undefined ? null : project);
  const options = filterModelOptionsForViewer(
    buildModelOptions(config, selection, undefined, projectId),
    {
      settings: config?.settings,
      viewer,
      currentInstanceId: selection?.instanceId,
    },
  );
  return { selection, options };
}

export function SpaceModelRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly value: ModelSelection | null;
  readonly disabled?: boolean;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const { selection, options } = useSpaceModel(props.environmentId, props.projectId, props.value);
  const current = options.find(
    (option) =>
      option.selection.instanceId === selection?.instanceId &&
      option.selection.model === selection?.model,
  );
  const selectable = options.filter((option) => !option.isUnavailable && !option.isHidden);
  return (
    <SpaceSelectRow
      label="Model"
      value={current?.label ?? selection?.model ?? "No models available"}
      disabled={props.disabled}
      actions={groupByProvider(selectable).map((group) => ({
        id: `provider:${group.providerKey}`,
        title: group.providerLabel,
        subactions: group.models.map((option) => ({
          id: option.key,
          title: option.label,
          state: option === current ? "on" : "off",
        })),
      }))}
      onSelect={(id) => {
        const option = selectable.find((candidate) => candidate.key === id);
        if (option !== undefined) props.onChange(option.selection);
      }}
    />
  );
}
