import {
  isSecretReference,
  type EnvironmentId,
  type SecretReference,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { restorePemLineBreaks } from "./GitHubAppKeySettings.logic";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";

export function GitHubAppKeySettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const github = useEnvironmentSettings(
    environmentId,
    (settings) => settings.sourceControlHosts.github,
  );
  const savedAppId = typeof github?.appId === "string" ? github.appId : "";
  const savedKey: SettingsSecretValue =
    typeof github?.appPrivateKey === "string" || isSecretReference(github?.appPrivateKey)
      ? github.appPrivateKey
      : "";
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save GitHub App key",
  });
  const secretSources = useSecretSources(environmentId);
  const [appIdDraft, setAppIdDraft] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState<string | SecretReference | null>(null);
  const [saving, setSaving] = useState(false);
  const keyIsReference = isSecretReference(savedKey);
  const isConfigured = keyIsReference || savedKey.length > 0;
  const appId = appIdDraft ?? savedAppId;
  const key = keyDraft ?? (keyIsReference ? savedKey : "");
  const keySubmission =
    keyDraft === null
      ? ""
      : typeof keyDraft === "string"
        ? restorePemLineBreaks(keyDraft)
        : keyDraft;
  const changed = appId.trim() !== savedAppId || keySubmission !== "";

  const save = async (patch: {
    readonly appId: string;
    readonly appPrivateKey?: SettingsSecretValue;
  }) => {
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { sourceControlHosts: { github: patch } } },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setAppIdDraft(null);
      setKeyDraft(null);
    }
  };

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed) return;
        void save({
          appId: appId.trim(),
          // An untouched key field keeps the stored key.
          ...(keySubmission === "" ? {} : { appPrivateKey: keySubmission }),
        });
      }}
    >
      <fieldset disabled={saving} className="contents">
        <div className="grid gap-1">
          <p className="text-xs font-medium text-foreground">GitHub App for cloud threads</p>
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
            Cloud threads push with one-hour tokens for each repository the App is installed on.
            Without it, members push with their own GitHub. Give the App read and write access to
            contents and pull requests.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
          <div className="grid gap-1.5">
            <Label htmlFor={`github-app-id-${environmentId}`}>App ID</Label>
            <Input
              id={`github-app-id-${environmentId}`}
              autoComplete="off"
              inputMode="numeric"
              size="sm"
              value={appId}
              onChange={(event) => setAppIdDraft(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`github-app-key-${environmentId}`}>Private key</Label>
            <SecretSourceInput
              id={`github-app-key-${environmentId}`}
              size="sm"
              aria-label="GitHub App private key"
              placeholder="Paste the .pem file's contents"
              configured={isConfigured && !keyIsReference}
              value={key}
              sources={secretSources}
              onChange={(event) => setKeyDraft(event.target.value)}
              onSecretChange={(secret) => setKeyDraft(secret ?? "")}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          {isConfigured || savedAppId !== "" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={saving}
              onClick={() => void save({ appId: "", appPrivateKey: "" })}
            >
              Remove
            </Button>
          ) : null}
          <Button type="submit" size="xs" disabled={!changed || saving}>
            Save
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
