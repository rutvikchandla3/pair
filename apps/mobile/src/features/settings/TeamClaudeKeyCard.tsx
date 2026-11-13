import { teamAdmins, teamClaudeKeyStatusText } from "@t3tools/client-runtime/team-claude-key";
import type { EnvironmentId, MemberId } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { useNowMinuteMs } from "../../lib/clock";
import {
  reportSpaceResult,
  teamClaudeKeyEnvironment,
  useCanManageTeamClaudeKey,
  useTeamClaudeKeyStatus,
} from "../../state/spaces";
import { useTeamRoster } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

/** Pays for @pair in every space; admins add, replace or remove it, others see who to ask. */
export function TeamClaudeKeyCard(props: { readonly environmentId: EnvironmentId }) {
  const status = useTeamClaudeKeyStatus(props.environmentId);
  const canManage = useCanManageTeamClaudeKey(props.environmentId);
  const { members } = useTeamRoster(props.environmentId);
  const setKey = useAtomCommand(teamClaudeKeyEnvironment.set, { reportFailure: false });
  const removeKey = useAtomCommand(teamClaudeKeyEnvironment.remove, { reportFailure: false });
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNowMinuteMs();
  if (status === null) return null;
  const nameOf = (memberId: MemberId) => members.get(memberId)?.name ?? "a former member";
  const admins = teamAdmins(members.values());
  const isSet = status.state === "set";

  const save = async () => {
    const value = draft?.trim() ?? "";
    if (value === "" || busy) return;
    setBusy(true);
    const result = await setKey({
      environmentId: props.environmentId,
      input: { value: Redacted.make(value) },
    });
    setBusy(false);
    if (reportSpaceResult("Could not save the key", result)) setDraft(null);
  };
  const remove = () =>
    Dialog.confirm({
      title: "Remove the Team Claude key?",
      message:
        "@pair stops replying in every space. Members' own threads keep running on their accounts.",
      confirmText: "Remove key",
      destructive: true,
      onConfirm: () =>
        void removeKey({ environmentId: props.environmentId, input: {} }).then((result) =>
          reportSpaceResult("Could not remove the key", result),
        ),
    });

  return (
    <SettingsSection
      title="Team Claude key"
      footer="Pays for @pair in every space on this server. Members' own threads keep using their own accounts."
    >
      <View className="gap-3 bg-grouped-card px-4 py-3">
        <Text textRole="footnote" className="text-foreground-muted">
          {teamClaudeKeyStatusText(status, nameOf, now)}
        </Text>
        {canManage ? (
          draft === null ? (
            <View className="flex-row gap-3">
              <Button
                label={isSet ? "Replace" : "Add key"}
                size="compact"
                tone={isSet ? undefined : "primary"}
                onPress={() => setDraft("")}
              />
              {isSet ? <Button label="Remove" size="compact" onPress={remove} /> : null}
            </View>
          ) : (
            <View className="gap-2">
              <TextInput
                accessibilityLabel="Anthropic API key"
                autoFocus
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="sk-ant-…"
                placeholderTextColorClassName="accent-foreground-muted"
                value={draft}
                onChangeText={setDraft}
                className="min-h-11 rounded-xl border border-border-subtle bg-card px-3 text-base text-foreground"
              />
              <Text textRole="footnote" className="text-foreground-muted">
                Stored on this server. You won't see it again.
              </Text>
              <View className="flex-row gap-3">
                <Button
                  label="Cancel"
                  size="compact"
                  disabled={busy}
                  onPress={() => setDraft(null)}
                />
                <Button
                  label="Save key"
                  size="compact"
                  tone="primary"
                  loading={busy}
                  disabled={draft.trim() === ""}
                  onPress={() => void save()}
                />
              </View>
            </View>
          )
        ) : isSet || admins.length === 0 ? null : (
          <Text textRole="footnote" className="text-foreground-muted">
            Ask {admins.map((admin) => admin.name).join(" or ")} to add one.
          </Text>
        )}
      </View>
    </SettingsSection>
  );
}
