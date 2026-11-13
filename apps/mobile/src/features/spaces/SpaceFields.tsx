import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import { spaceWorkspaceLine } from "@t3tools/client-runtime/spaces";
import { activeTeamMembers } from "@t3tools/client-runtime/state/team";
import { isWorkspaceProject } from "@t3tools/client-runtime/state/workspaces";
import { teamAdmins, teamClaudeKeyIsSet } from "@t3tools/client-runtime/team-claude-key";
import {
  type EnvironmentId,
  type MemberId,
  type ModelSelection,
  type ProjectId,
  SPACE_MAX_REPOSITORIES,
  type Space,
  type SpaceId,
  type SpaceThreadStart,
} from "@t3tools/contracts";
import { type ReactNode, useState } from "react";
import { Pressable, View } from "react-native";

import { MemberAvatar } from "../../components/MemberAvatar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import {
  buildModelOptions,
  filterModelOptionsForViewer,
  groupByProvider,
} from "../../lib/modelOptions";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import {
  spaceEnvironment,
  useCanManageTeamClaudeKey,
  useTeamClaudeKeyStatus,
} from "../../state/spaces";
import { useTeamRoster, useTeamViewer } from "../../state/team";
import { scheduledTaskDefaultModel } from "../settings/scheduledTaskDraft";
import { openSettings } from "../settings/settings-navigation";

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

/** Repository projects a space can pick: not workspaces, not scratch. */
function useRepositoryProjects(environmentId: EnvironmentId) {
  return useProjects().filter(
    (project) =>
      project.environmentId === environmentId &&
      project.isScratch !== true &&
      !isWorkspaceProject(project),
  );
}

/** Repositories (1–8, in the order picked) and the sentence on where threads will run. */
export function SpaceRepositoriesField(props: {
  readonly environmentId: EnvironmentId;
  readonly value: ReadonlyArray<ProjectId>;
  readonly spaceName: string;
  readonly spaceId?: SpaceId;
  readonly disabled?: boolean;
  readonly note?: string;
  readonly onChange: (value: ReadonlyArray<ProjectId>) => void;
}) {
  const projects = useRepositoryProjects(props.environmentId);
  const name = props.spaceName.trim();
  const preview = useEnvironmentQuery(
    props.value.length === 0 || name === ""
      ? null
      : spaceEnvironment.workspacePreview({
          environmentId: props.environmentId,
          input: {
            repositoryIds: props.value,
            spaceName: name,
            ...(props.spaceId === undefined ? {} : { spaceId: props.spaceId }),
          },
        }),
  ).data;
  const names = props.value.map(
    (id) => projects.find((project) => project.id === id)?.title ?? "a repository",
  );
  const line =
    props.value.length === 0
      ? "Pick at least one repository."
      : preview === null
        ? null
        : spaceWorkspaceLine(preview, names);
  const full = props.value.length >= SPACE_MAX_REPOSITORIES;
  return (
    <SpaceField
      label={
        props.value.length === 0 ? "Repositories" : `Repositories · ${props.value.length} selected`
      }
    >
      <View>
        {projects.map((project) => {
          const selected = props.value.includes(project.id);
          const disabled = props.disabled === true || (!selected && full);
          return (
            <Pressable
              key={project.id}
              accessibilityRole="checkbox"
              accessibilityLabel={project.title}
              accessibilityState={{ checked: selected, disabled }}
              disabled={disabled}
              onPress={() =>
                props.onChange(
                  selected
                    ? props.value.filter((id) => id !== project.id)
                    : [...props.value, project.id],
                )
              }
              className="min-h-12 flex-row items-center gap-3 border-t border-border-subtle active:opacity-70"
            >
              <SymbolView name="folder" size={16} tintColorClassName="accent-icon-muted" />
              <Text
                numberOfLines={1}
                className={cn(
                  "min-w-0 flex-1 text-base",
                  disabled ? "text-foreground-muted" : "text-foreground",
                )}
              >
                {project.title}
              </Text>
              {selected ? (
                <SymbolView name="checkmark" size={16} tintColorClassName="accent-icon" />
              ) : null}
            </Pressable>
          );
        })}
      </View>
      {line === null ? null : <Text className="text-sm text-foreground-muted">{line}</Text>}
      {props.note === undefined ? null : (
        <Text className="text-xs text-foreground-muted">{props.note}</Text>
      )}
    </SpaceField>
  );
}

/** Runs in: the space's default first, then the environment's workspaces and repositories. */
export function SpaceRunsInRow(props: {
  readonly environmentId: EnvironmentId;
  readonly defaultProjectId: ProjectId;
  readonly value: ProjectId;
  readonly disabled?: boolean;
  readonly onChange: (projectId: ProjectId) => void;
}) {
  const projects = useProjects().filter(
    (project) => project.environmentId === props.environmentId && project.isScratch !== true,
  );
  const ordered = [
    ...projects.filter((project) => project.id === props.defaultProjectId),
    ...projects.filter((project) => project.id !== props.defaultProjectId),
  ];
  const label = (project: (typeof projects)[number]) =>
    project.id === props.defaultProjectId ? `${project.title} · Space default` : project.title;
  const selected = ordered.find((project) => project.id === props.value);
  return (
    <SpaceSelectRow
      label="Runs in"
      value={selected === undefined ? "Choose where it runs" : label(selected)}
      disabled={props.disabled}
      actions={ordered.map((project) => ({
        id: project.id,
        title: label(project),
        ...(isWorkspaceProject(project)
          ? { subtitle: project.roots.map((root) => root.name).join(", ") }
          : {}),
        state: project.id === props.value ? "on" : "off",
      }))}
      onSelect={(id) => {
        const project = ordered.find((candidate) => candidate.id === id);
        if (project !== undefined) props.onChange(project.id);
      }}
    />
  );
}

/** @pair's Team Claude key: its status, Add key for an admin, who to ask for anyone else. */
export function SpacePairKeyField(props: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const status = useTeamClaudeKeyStatus(props.environmentId);
  const canManage = useCanManageTeamClaudeKey(props.environmentId);
  const { members } = useTeamRoster(props.environmentId);
  if (status === null) return null;
  const set = teamClaudeKeyIsSet(status);
  const admin = teamAdmins(members.values())[0];
  return (
    <SpaceField label="@pair">
      <View className="min-h-12 flex-row items-center gap-2 rounded-xl bg-subtle px-4 py-2">
        <View className="min-w-0 flex-1">
          <Text className="text-base text-foreground">Team Claude key</Text>
          <Text numberOfLines={2} className="text-xs text-foreground-muted">
            {set
              ? "Pair replies here on the team's key."
              : canManage || admin === undefined
                ? "Not set · Pair stays off until an admin adds one."
                : `Not set · ask ${admin.name} to add one in Settings → Team.`}
          </Text>
        </View>
        {!set && canManage ? (
          <Button
            label="Add key"
            size="compact"
            onPress={() => openSettings(navigation, "SettingsTeam")}
          />
        ) : null}
      </View>
    </SpaceField>
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

/** Runs in, model and base for a new thread on a task; `start` is null until it can start. */
export function useSpaceThreadStart(environmentId: EnvironmentId, space: Space | null) {
  const projects = useProjects();
  const [runsIn, setRunsIn] = useState<ProjectId | null>(null);
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [baseRef, setBaseRef] = useState("");
  const [branch, setBranch] = useState("");
  const projectId = runsIn ?? space?.projectId ?? null;
  const project = projects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  // Workspaces start every repository from its default branch.
  const workspace = isWorkspaceProject(project);
  const model = useSpaceModel(environmentId, projectId, picked).selection;
  const start: SpaceThreadStart | null =
    projectId === null || model === null
      ? null
      : {
          projectId,
          modelSelection: model,
          // No baseRef: the server starts from the repository's default branch.
          base: workspace
            ? {}
            : {
                ...(baseRef.trim() === "" ? {} : { baseRef: baseRef.trim() }),
                ...(branch.trim() === "" ? {} : { branch: branch.trim() }),
              },
        };
  const fields =
    space === null || projectId === null ? null : (
      <>
        <SpaceRunsInRow
          environmentId={environmentId}
          defaultProjectId={space.projectId}
          value={projectId}
          onChange={setRunsIn}
        />
        <SpaceModelRow
          environmentId={environmentId}
          projectId={projectId}
          value={picked}
          onChange={setPicked}
        />
        {workspace ? (
          <Text className="text-xs text-foreground-muted">
            A thread checks out every repository in its workspace, each from its default branch.
          </Text>
        ) : (
          <View className="flex-row gap-3">
            <View className="flex-1">
              <SpaceTextField
                label="Start from"
                value={baseRef}
                placeholder="Default branch"
                onChangeText={setBaseRef}
              />
            </View>
            <View className="flex-1">
              <SpaceTextField
                label="Branch (optional)"
                value={branch}
                placeholder="New from base"
                onChangeText={setBranch}
              />
            </View>
          </View>
        )}
      </>
    );
  return { start, model, fields };
}
