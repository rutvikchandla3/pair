import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, TeamMember } from "@t3tools/contracts";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { teamEnvironment } from "../../state/team";
import { useAtomCommand } from "../../state/use-atom-command";

function githubStatus(github: TeamMember["github"]): string {
  if (github === undefined) return "Not connected";
  if (github.source === "token") {
    return github.connected
      ? `Using a token for @${github.login}`
      : `@${github.login} · GitHub refused the token`;
  }
  return github.connected ? `Connected as @${github.login}` : `@${github.login} · Not connected`;
}

/**
 * The viewer's own GitHub on their Team row: its state, a pasted token instead of the GitHub App,
 * and removing that token. The token is typed into a secure field, sent once, never shown back.
 */
export function OwnGitHubConnection(props: {
  readonly environmentId: EnvironmentId;
  readonly member: TeamMember;
}) {
  const setToken = useAtomCommand(teamEnvironment.setGitHubToken, { reportFailure: false });
  const clearToken = useAtomCommand(teamEnvironment.clearGitHubToken, { reportFailure: false });
  // Null while the token field is closed.
  const [tokenDraft, setTokenDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const github = props.member.github;
  const usesToken = github?.source === "token";

  const failureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
    const failure = squashAtomCommandFailure(result);
    return failure instanceof Error && failure.message !== "" ? failure.message : "Try again.";
  };

  const saveToken = async () => {
    const token = tokenDraft?.trim() ?? "";
    if (token === "" || busy) return;
    setBusy(true);
    setError(null);
    const result = await setToken({ environmentId: props.environmentId, input: { token } });
    setBusy(false);
    if (result._tag === "Success") setTokenDraft(null);
    else setError(failureMessage(result));
  };

  const removeToken = () =>
    Dialog.confirm({
      title: "Remove your GitHub token?",
      message:
        "This server deletes it. To revoke it on GitHub too, delete it in your GitHub token settings.",
      confirmText: "Remove",
      destructive: true,
      onConfirm: () => {
        setBusy(true);
        setError(null);
        void clearToken({ environmentId: props.environmentId, input: {} }).then((result) => {
          setBusy(false);
          if (result._tag !== "Success") setError(failureMessage(result));
        });
      },
    });

  return (
    <View className="gap-2 border-t border-border-subtle px-4 py-3">
      <View className="flex-row items-center gap-3">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text textRole="body" className="text-foreground">
            GitHub
          </Text>
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
            {githubStatus(github)}
          </Text>
        </View>
        {usesToken ? (
          <Button
            label="Remove token"
            tone="secondary"
            size="compact"
            disabled={busy}
            onPress={removeToken}
          />
        ) : null}
        {tokenDraft === null && !(usesToken && github?.connected === true) ? (
          <Button
            label="Use a token instead"
            tone="secondary"
            size="compact"
            disabled={busy}
            onPress={() => {
              setError(null);
              setTokenDraft("");
            }}
          />
        ) : null}
      </View>
      {tokenDraft !== null ? (
        <View className="gap-2">
          <TextInput
            accessibilityLabel="GitHub token"
            className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
            placeholderTextColorClassName="accent-foreground-muted"
            placeholder="A fine-grained token, or gh auth token"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            editable={!busy}
            value={tokenDraft}
            onChangeText={setTokenDraft}
            onSubmitEditing={() => void saveToken()}
            returnKeyType="done"
          />
          <View className="flex-row justify-end gap-2">
            <Button
              label="Cancel"
              tone="text"
              size="compact"
              disabled={busy}
              onPress={() => {
                setTokenDraft(null);
                setError(null);
              }}
            />
            <Button
              label="Save"
              tone="primary"
              size="compact"
              loading={busy}
              disabled={busy || tokenDraft.trim() === ""}
              onPress={() => void saveToken()}
            />
          </View>
        </View>
      ) : null}
      {error !== null ? (
        <Text textRole="footnote" className="text-danger-foreground" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <Text textRole="footnote" className="text-foreground-muted">
        Agents in your cloud threads can read this token.
      </Text>
    </View>
  );
}
