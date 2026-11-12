import { useAtomValue } from "@effect/atom-react";
import {
  ChiefOfStaffAvatarSize,
  ChiefOfStaffAvatarStyle,
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { LinkAccessPicker } from "./LinkAccessPicker";
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

const SIZE_LABELS: Readonly<Record<ChiefOfStaffAvatarSize, string>> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

export function ChiefOfStaffSettingsPanel() {
  const { environment, scope } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <SettingsSection title="Voice">
        {environment === null ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">
            {scope.kind === "environment"
              ? `Reconnect ${scope.label} to set up Chief of staff.`
              : "Connect an environment to set up Chief of staff."}
          </p>
        ) : (
          <VoiceRows
            environmentId={environment.environmentId}
            supported={
              environment.serverConfig?.environment.capabilities.chiefOfStaffVoice === true
            }
          />
        )}
      </SettingsSection>
      <SettingsSection title="Avatar on this device">
        <AvatarStyleRow />
        <AvatarAccentRow />
        <AvatarSizeRow />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function VoiceRows({
  environmentId,
  supported,
}: {
  environmentId: EnvironmentId;
  supported: boolean;
}) {
  const settings = useScopedSettings((value) => value.chiefOfStaff);
  const updateSettings = useUpdateScopedSettings();
  const update = (patch: Partial<typeof settings>) => updateSettings({ chiefOfStaff: patch });
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const voiceProviders = providers.filter((provider) => supportsChiefOfStaffVoice(provider.driver));
  const disabled = !supported;

  return (
    <>
      <SettingsRow
        serverScoped
        {...searchableSetting("chief-of-staff-enabled")}
        settingKeys={["chiefOfStaff"]}
        description={
          supported
            ? "Talk to an assistant that can look across your threads and projects here. Start it from the sidebar or the command palette."
            : "This environment's server does not support voice yet. Update it to use Chief of staff."
        }
        control={
          <ScopedSwitch
            settingKeys={["chiefOfStaff"]}
            checked={settings.enabled}
            disabled={disabled}
            onCheckedChange={(checked) => update({ enabled: Boolean(checked) })}
            aria-label="Chief of staff"
          />
        }
      />
      <SettingsRow
        serverScoped
        {...searchableSetting("chief-of-staff-provider")}
        settingKeys={["chiefOfStaff"]}
        description="The Codex instance that runs voice sessions. Only Codex supports realtime voice."
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
            <SelectTrigger
              size="sm"
              className="w-full sm:w-48"
              aria-label="Codex instance"
              disabled={disabled}
            >
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
            disabled={disabled}
            onCommit={(voice) => update({ voice })}
          />
        }
      />
      <SettingsRow
        serverScoped
        {...searchableSetting("chief-of-staff-model")}
        settingKeys={["chiefOfStaff"]}
        description="The Codex model that carries out what you ask. Leave empty for the fast default."
        control={
          <TextSetting
            value={settings.model}
            placeholder="Default"
            disabled={disabled}
            onCommit={(model) => update({ model })}
            aria-label="Model"
          />
        }
      />
      <SettingsRow
        serverScoped
        {...searchableSetting("chief-of-staff-tool-access")}
        settingKeys={["chiefOfStaff"]}
        description="What the assistant may do to your threads and projects when you ask."
      >
        <div className="max-w-md pt-3 pb-2">
          <LinkAccessPicker
            value={settings.toolAccess}
            onChange={(toolAccess) => update({ toolAccess })}
            disabled={disabled}
            label="Tool access"
            note="It never gets more access than you have."
          />
        </div>
      </SettingsRow>
      <SettingsRow
        serverScoped
        {...searchableSetting("chief-of-staff-base-url")}
        settingKeys={["chiefOfStaff"]}
        description={
          <>
            Overrides Codex's base URL for voice only. Leave empty to use Codex's own.
            <br />
            If Codex goes through a proxy without voice support, use{" "}
            <code>https://chatgpt.com/backend-api/codex</code>.
          </>
        }
        control={
          <TextSetting
            value={settings.realtimeBaseUrl}
            placeholder="https://…"
            disabled={disabled}
            onCommit={(realtimeBaseUrl) => update({ realtimeBaseUrl })}
            aria-label="Realtime base URL"
          />
        }
      />
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
  disabled,
  onCommit,
}: {
  environmentId: EnvironmentId;
  value: string;
  disabled: boolean;
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
      <TextSetting
        value={value}
        placeholder="Default"
        disabled={disabled}
        onCommit={onCommit}
        aria-label="Voice"
      />
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
      <SelectTrigger size="sm" className="w-full sm:w-48" aria-label="Voice" disabled={disabled}>
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
  disabled: boolean;
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
