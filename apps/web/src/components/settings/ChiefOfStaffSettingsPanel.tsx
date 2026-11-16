import { useAtomValue } from "@effect/atom-react";
import {
  type AuthMcpClientAccess,
  ChiefOfStaffAvatarSize,
  ChiefOfStaffAvatarStyle,
  DEFAULT_CONFIRM_TOOLS,
  supportsChiefOfStaffVoice,
  type EnvironmentId,
} from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { useChiefOfStaffStore } from "../../chiefOfStaff/session";
import { updateClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { chiefOfStaffCommands } from "../../state/chiefOfStaff";
import { useEnvironmentProviders } from "../../state/environments";
import {
  CHIEF_OF_STAFF_AVATAR_LABELS,
  CHIEF_OF_STAFF_AVATAR_PIXELS,
  ChiefOfStaffAvatar,
} from "../chiefOfStaff/ChiefOfStaffAvatar";
import { useChiefOfStaffAvatarSettings } from "../chiefOfStaff/ChiefOfStaffButton";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { AdvancedSettings } from "./AdvancedSettings";
import { AccessSelect } from "./LinkAccessPicker";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { ScopedSwitch } from "./ScopedSwitch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const DEFAULT_OPTION = "__default__";

/**
 * Voice has no approval UI, so the shared runtime-mode wording ("ask before…") does not apply:
 * every level above read-only writes in its own workspace, and full access reaches the machine.
 */
const CHIEF_OF_STAFF_TOOL_ACCESS: Record<AuthMcpClientAccess, string> = {
  "read-only": accessConfig["read-only"].description,
  "approval-required": "Run commands and edit files in its own workspace.",
  "auto-accept-edits": "Run commands and edit files in its own workspace.",
  auto: "Run commands and edit files in its own workspace, with network access.",
  "full-access": "Run commands and edit files anywhere on this machine, without prompts.",
};

const SIZE_LABELS: Readonly<Record<ChiefOfStaffAvatarSize, string>> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

/** Plain language for the tools the server asks about before Chief of staff runs them. */
const CONFIRM_TOOL_LABELS: Readonly<Record<string, string>> = {
  t3_project_delete: "Delete a project",
  t3_environment_unlink: "Unlink another machine",
  delete_scheduled_task: "Delete a scheduled task",
  t3_thread_interrupt: "Interrupt a running thread",
  t3_workflow_stop: "Stop a workflow",
  task_cancel: "Cancel a delegated task",
  t3_worktree_handoff: "Move a thread into a new worktree",
  t3_thread_transfer: "Fork or merge a thread's context",
};

export function ChiefOfStaffSettingsPanel() {
  const { environment, scope } = useSettingsScope();
  const supported = environment?.serverConfig?.environment.capabilities.chiefOfStaffVoice === true;
  const enabled = useScopedSettings((value) => value.chiefOfStaff.enabled);
  // Off, the rest configures nothing, so the page is just the switch.
  const showDetails = environment !== null && supported && enabled;
  return (
    <SettingsPageContainer>
      <SettingsSection title="Voice assistant">
        {environment === null ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">
            {scope.kind === "environment"
              ? `Reconnect ${scope.label} to set up Chief of staff.`
              : "Connect an environment to set up Chief of staff."}
          </p>
        ) : (
          <VoiceRows
            environmentId={environment.environmentId}
            supported={supported}
            showDetails={showDetails}
          />
        )}
      </SettingsSection>
      {showDetails && environment !== null ? (
        <SettingsSection title="Chat thread">
          <HomeThreadRows environmentId={environment.environmentId} />
        </SettingsSection>
      ) : null}
      {showDetails ? (
        <SettingsSection title="Always ask before">
          <ConfirmToolsRow />
        </SettingsSection>
      ) : null}
      {showDetails ? (
        <SettingsSection title="Avatar on this device">
          <AvatarStyleRow />
          <AvatarAccentRow />
          <AvatarSizeRow />
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

/** The persistent text thread Chief of staff keeps per member. */
function HomeThreadRows({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useScopedSettings((value) => value.chiefOfStaff);
  const updateSettings = useUpdateScopedSettings();
  const update = (patch: Partial<typeof settings>) => updateSettings({ chiefOfStaff: patch });
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  return (
    <>
      <SettingsRow
        serverScoped
        {...searchableSetting("chief-of-staff-home-provider")}
        title="Chat provider"
        settingKeys={["chiefOfStaff"]}
        description="Runs the persistent thread you chat with by text. Empty uses the server's default for new threads."
        control={
          <Select
            value={
              settings.homeProviderInstanceId === ""
                ? DEFAULT_OPTION
                : settings.homeProviderInstanceId
            }
            onValueChange={(next) => {
              if (next !== null)
                update({ homeProviderInstanceId: next === DEFAULT_OPTION ? "" : next });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-48" aria-label="Chat provider">
              <SelectValue>
                {(value: string) =>
                  value === DEFAULT_OPTION
                    ? "Server default"
                    : (providers.find((provider) => provider.instanceId === value)?.displayName ??
                      value)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value={DEFAULT_OPTION}>
                Server default
              </SelectItem>
              {providers.map((provider) => (
                <SelectItem hideIndicator key={provider.instanceId} value={provider.instanceId}>
                  {provider.displayName ?? provider.instanceId}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        serverScoped
        {...searchableSetting("chief-of-staff-home-model")}
        title="Chat model"
        settingKeys={["chiefOfStaff"]}
        description="The model that thread runs. Empty uses the provider's default."
        control={
          <TextSetting
            value={settings.homeModel}
            placeholder="Default"
            onCommit={(homeModel) => update({ homeModel })}
            aria-label="Chat model"
          />
        }
      />
    </>
  );
}

/** The tools Chief of staff must get approval for: the defaults, plus any the member added. */
function ConfirmToolsRow() {
  const settings = useScopedSettings((value) => value.chiefOfStaff);
  const updateSettings = useUpdateScopedSettings();
  const chosen = settings.confirmTools;
  const extras = chosen.filter(
    (tool) => !(DEFAULT_CONFIRM_TOOLS as readonly string[]).includes(tool),
  );
  const setTool = (tool: string, on: boolean) => {
    const next = on
      ? [...new Set([...chosen, tool])]
      : chosen.filter((candidate) => candidate !== tool);
    updateSettings({ chiefOfStaff: { confirmTools: next } });
  };
  return (
    <SettingsRow
      serverScoped
      title="Risky tools"
      settingKeys={["chiefOfStaff"]}
      description="Chief of staff asks you to approve these before the server runs them."
      control={
        <fieldset className="grid gap-1.5">
          <legend className="sr-only">Risky tools</legend>
          {[...DEFAULT_CONFIRM_TOOLS, ...extras].map((tool) => (
            <label key={tool} className="flex min-w-0 items-center gap-2 text-sm">
              <Checkbox
                checked={chosen.includes(tool)}
                onCheckedChange={(checked) => setTool(tool, checked === true)}
              />
              <span className="truncate">{CONFIRM_TOOL_LABELS[tool] ?? tool}</span>
            </label>
          ))}
        </fieldset>
      }
    />
  );
}

function VoiceRows({
  environmentId,
  supported,
  showDetails,
}: {
  environmentId: EnvironmentId;
  supported: boolean;
  showDetails: boolean;
}) {
  const settings = useScopedSettings((value) => value.chiefOfStaff);
  const updateSettings = useUpdateScopedSettings();
  const update = (patch: Partial<typeof settings>) => updateSettings({ chiefOfStaff: patch });
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const voiceProviders = providers.filter((provider) => supportsChiefOfStaffVoice(provider.driver));
  const advancedSummary = [
    settings.model === "" ? null : `Model: ${settings.model}`,
    settings.realtimeBaseUrl === "" ? null : "Custom realtime base URL",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <SettingsRow
        serverScoped
        {...searchableSetting("chief-of-staff-enabled")}
        settingKeys={["chiefOfStaff"]}
        description={
          !supported
            ? "This environment's server does not support voice yet. Update it to use Chief of staff."
            : showDetails
              ? "Talk to an assistant that can look across your threads and projects here. Start it from the sidebar or the command palette."
              : "Talk to an assistant that can look across your threads and projects here. Turn it on to choose its voice, tools and look."
        }
        control={
          <ScopedSwitch
            settingKeys={["chiefOfStaff"]}
            checked={settings.enabled}
            disabled={!supported}
            onCheckedChange={(checked) => update({ enabled: Boolean(checked) })}
            aria-label="Chief of staff"
          />
        }
      />
      {showDetails ? (
        <>
          <SettingsRow
            serverScoped
            {...searchableSetting("chief-of-staff-provider")}
            title="Codex instance"
            settingKeys={["chiefOfStaff"]}
            description="Runs the voice sessions. Only Codex supports realtime voice."
            control={
              <Select
                value={
                  settings.providerInstanceId === "" ? DEFAULT_OPTION : settings.providerInstanceId
                }
                onValueChange={(next) => {
                  if (next !== null)
                    update({ providerInstanceId: next === DEFAULT_OPTION ? "" : next });
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-48" aria-label="Codex instance">
                  <SelectValue>
                    {(value: string) =>
                      value === DEFAULT_OPTION
                        ? "Default Codex"
                        : (voiceProviders.find((provider) => provider.instanceId === value)
                            ?.displayName ?? value)
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value={DEFAULT_OPTION}>
                    Default Codex
                  </SelectItem>
                  {voiceProviders.map((provider) => (
                    <SelectItem hideIndicator key={provider.instanceId} value={provider.instanceId}>
                      {provider.displayName ?? provider.instanceId}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            serverScoped
            {...searchableSetting("chief-of-staff-voice")}
            settingKeys={["chiefOfStaff"]}
            description="The voice it answers in."
            control={
              <VoicePicker
                environmentId={environmentId}
                value={settings.voice}
                onCommit={(voice) => update({ voice })}
              />
            }
          />
          <SettingsRow
            serverScoped
            {...searchableSetting("chief-of-staff-tool-access")}
            title="Tool access"
            settingKeys={["chiefOfStaff"]}
            description={`${CHIEF_OF_STAFF_TOOL_ACCESS[settings.toolAccess]} It never gets more access than you have.`}
            control={
              <AccessSelect
                value={settings.toolAccess}
                onChange={(toolAccess) => update({ toolAccess })}
                className="w-full sm:w-48"
                aria-label="Tool access"
              />
            }
          />
          <AdvancedSettings
            targetIds={[
              searchableSetting("chief-of-staff-model").id,
              searchableSetting("chief-of-staff-base-url").id,
            ]}
            summary={advancedSummary}
          >
            <SettingsRow
              serverScoped
              {...searchableSetting("chief-of-staff-model")}
              settingKeys={["chiefOfStaff"]}
              description="The Codex model that carries out what you ask. Empty uses the fast default."
              control={
                <TextSetting
                  value={settings.model}
                  placeholder="Default"
                  onCommit={(model) => update({ model })}
                  aria-label="Model"
                />
              }
            />
            <SettingsRow
              serverScoped
              {...searchableSetting("chief-of-staff-base-url")}
              settingKeys={["chiefOfStaff"]}
              description={
                <>
                  Overrides Codex's base URL for voice only. If your proxy has no voice support, use{" "}
                  <code>https://chatgpt.com/backend-api/codex</code>.
                </>
              }
              control={
                <TextSetting
                  value={settings.realtimeBaseUrl}
                  placeholder="https://…"
                  onCommit={(realtimeBaseUrl) => update({ realtimeBaseUrl })}
                  aria-label="Realtime base URL"
                />
              }
            />
          </AdvancedSettings>
        </>
      ) : null}
    </>
  );
}

type VoiceList =
  | { readonly status: "idle" | "loading" }
  | {
      readonly status: "ready";
      readonly voices: ReadonlyArray<string>;
      readonly defaultVoice: string | null;
    }
  | { readonly status: "failed" };

/** Lists voices when first opened, since listing starts a provider process; typed in when it cannot. */
function VoicePicker({
  environmentId,
  value,
  onCommit,
}: {
  environmentId: EnvironmentId;
  value: string;
  onCommit: (voice: string) => void;
}) {
  const [list, setList] = useState<VoiceList>({ status: "idle" });
  const canList = useAtomValue(chiefOfStaffCommands.listVoices.permissionAtom(environmentId));

  if (
    !canList ||
    list.status === "failed" ||
    (list.status === "ready" && list.voices.length === 0)
  ) {
    return (
      <TextSetting value={value} placeholder="Default" onCommit={onCommit} aria-label="Voice" />
    );
  }

  const load = async () => {
    setList({ status: "loading" });
    const result = await runAtomCommand(
      appAtomRegistry,
      chiefOfStaffCommands.listVoices,
      { environmentId, input: undefined },
      { reportFailure: false },
    );
    setList(
      result._tag === "Success"
        ? {
            status: "ready",
            voices: result.value.voices,
            defaultVoice: result.value.defaultVoice ?? null,
          }
        : { status: "failed" },
    );
  };
  const voices = list.status === "ready" ? list.voices : value === "" ? [] : [value];
  const defaultLabel =
    list.status === "ready" && list.defaultVoice !== null
      ? `Default (${list.defaultVoice})`
      : "Default";

  return (
    <Select
      value={value === "" ? DEFAULT_OPTION : value}
      onOpenChange={(open) => {
        if (open && list.status === "idle") void load();
      }}
      onValueChange={(next) => {
        if (next !== null) onCommit(next === DEFAULT_OPTION ? "" : next);
      }}
    >
      <SelectTrigger size="sm" className="w-full sm:w-48" aria-label="Voice">
        <SelectValue>
          {(selected: string) => (selected === DEFAULT_OPTION ? defaultLabel : selected)}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value={DEFAULT_OPTION}>
          {defaultLabel}
        </SelectItem>
        {voices.map((voice) => (
          <SelectItem hideIndicator key={voice} value={voice}>
            {voice}
          </SelectItem>
        ))}
        {list.status === "loading" ? (
          <SelectItem hideIndicator value="__loading__" disabled>
            Loading voices…
          </SelectItem>
        ) : null}
      </SelectPopup>
    </Select>
  );
}

/** Commits on blur or Enter, so each keystroke does not write the server's settings. */
function TextSetting({
  value,
  onCommit,
  ...props
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder: string;
  "aria-label": string;
}) {
  const [draft, setDraft] = useState(value);
  const [draftSource, setDraftSource] = useState(value);
  if (draftSource !== value) {
    setDraftSource(value);
    setDraft(value);
  }
  const commit = () => {
    const next = draft.trim();
    if (next !== value) onCommit(next);
  };
  return (
    <Input
      {...props}
      size="sm"
      className="w-full sm:w-48"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}

function AvatarStyleRow() {
  const avatar = useChiefOfStaffAvatarSettings();
  const phase = useChiefOfStaffStore((view) => view.phase);
  return (
    <SettingsRow
      {...searchableSetting("chief-of-staff-avatar-style")}
      title="Style"
      description="How Chief of staff looks in the sidebar. It moves with the voice only during a session."
      resetAction={
        avatar.look === "pet" ? null : (
          <SettingResetButton
            label="avatar style"
            onClick={() => void updateClientSettings({ chiefOfStaffAvatarStyle: "pet" })}
          />
        )
      }
    >
      <div role="radiogroup" aria-label="Avatar style" className="flex flex-wrap gap-2 pt-3 pb-2">
        {ChiefOfStaffAvatarStyle.literals.map((look) => {
          const selected = look === avatar.look;
          return (
            <button
              key={look}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => void updateClientSettings({ chiefOfStaffAvatarStyle: look })}
              className={cn(
                "flex w-16 cursor-pointer flex-col items-center gap-1.5 rounded-lg border py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                selected
                  ? "border-primary bg-accent text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent/50",
              )}
            >
              <ChiefOfStaffAvatar
                look={look}
                phase={selected && phase !== "closed" ? phase : "idle"}
                accentColor={avatar.accentColor}
                pixels={28}
              />
              {CHIEF_OF_STAFF_AVATAR_LABELS[look]}
            </button>
          );
        })}
      </div>
    </SettingsRow>
  );
}

function AvatarAccentRow() {
  const avatar = useChiefOfStaffAvatarSettings();
  return (
    <SettingsRow
      {...searchableSetting("chief-of-staff-avatar-color")}
      title="Accent color"
      description="Empty follows the theme."
      control={
        <ProviderAccentColorPicker
          displayName="Chief of staff"
          value={avatar.accentColor}
          onCommit={(color) => void updateClientSettings({ chiefOfStaffAvatarAccentColor: color })}
          layout="inline"
        />
      }
    />
  );
}

function AvatarSizeRow() {
  const avatar = useChiefOfStaffAvatarSettings();
  return (
    <SettingsRow
      {...searchableSetting("chief-of-staff-avatar-size")}
      title="Size"
      description="The avatar's size in the sidebar."
      control={
        <Select
          value={avatar.size}
          onValueChange={(next) => {
            if (next !== null) void updateClientSettings({ chiefOfStaffAvatarSize: next });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-32" aria-label="Avatar size">
            <SelectValue>{(value: ChiefOfStaffAvatarSize) => SIZE_LABELS[value]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {ChiefOfStaffAvatarSize.literals.map((size) => (
              <SelectItem hideIndicator key={size} value={size}>
                <span className="flex items-center gap-2">
                  <ChiefOfStaffAvatar
                    look={avatar.look}
                    phase="idle"
                    accentColor={avatar.accentColor}
                    pixels={CHIEF_OF_STAFF_AVATAR_PIXELS[size]}
                  />
                  {SIZE_LABELS[size]}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
