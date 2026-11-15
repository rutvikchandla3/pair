import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { updateDialogCopy } from "@t3tools/client-runtime/branch-lineage";
import type { LineageUpdateResolver } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { branchLineageEnvironment, reportLineageResult } from "../../state/branch-lineage";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { LineageChoiceCard } from "./LineageChoiceCard";
import { LineageSheetFrame } from "./LineageSheetFrame";
import { type LineageSheetParams, useLineageThread } from "./useLineageThread";

/** Update from the source: a preview of what changed, and the two conflict choices with their cost. */
export function UpdateSheet(props: StaticScreenProps<LineageSheetParams>) {
  const navigation = useNavigation();
  const { ref, shell, viewer, providerName } = useLineageThread(props.route.params);
  const preview = useEnvironmentQuery(
    branchLineageEnvironment.updatePreview({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId },
    }),
  );
  const update = useAtomCommand(branchLineageEnvironment.update, { reportFailure: false });
  const [resolverPick, setResolverPick] = useState<LineageUpdateResolver | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const close = () => navigation.goBack();

  const data = preview.data;
  if (viewer === null || shell === null || data === null) {
    return (
      <LineageSheetFrame title="Update" closeLabel="Cancel update" onClose={close}>
        <Text className="text-sm text-foreground-muted">
          {preview.error ?? "Reading what changed…"}
        </Text>
      </LineageSheetFrame>
    );
  }

  const copy = updateDialogCopy(data, {
    viewer,
    sourceOwnerId: shell.source.branchLink?.source?.ownerId ?? null,
    providerName,
    turnRunning: shell.source.activeRunId !== null,
  });
  const resolver = resolverPick ?? copy.choices[0]?.value ?? "agent";

  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const result = await update({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId, onConflict: resolver },
    });
    inFlight.current = false;
    setBusy(false);
    if (reportLineageResult("Could not update", result)) close();
  };

  return (
    <LineageSheetFrame
      title={copy.title}
      subtitle={copy.summary}
      closeLabel="Cancel update"
      onClose={close}
    >
      <View className="gap-1">
        {copy.files.map((file) => (
          <View key={file.path} className="flex-row items-center gap-2 py-1">
            <SymbolView
              name={file.conflict ? "exclamationmark.circle" : "doc"}
              size={13}
              tintColorClassName={file.conflict ? "accent-danger-foreground" : "accent-icon-muted"}
            />
            <Text
              className="min-w-0 flex-1 font-mono text-xs text-foreground"
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {file.path}
            </Text>
            <Text
              className={cn(
                "text-xs",
                file.conflict ? "text-danger-foreground" : "text-foreground-muted",
              )}
            >
              {file.label}
            </Text>
          </View>
        ))}
      </View>
      {copy.choices.length > 0 ? (
        <View className="gap-2" accessibilityRole="radiogroup">
          {copy.choices.map((choice) => (
            <LineageChoiceCard
              key={choice.value}
              label={choice.label}
              subtitle={choice.cost}
              selected={choice.value === resolver}
              onPress={() => setResolverPick(choice.value)}
            />
          ))}
        </View>
      ) : null}
      {copy.footer !== null ? (
        <Text className="text-xs text-foreground-muted">{copy.footer}</Text>
      ) : null}
      <Button
        label={copy.primary}
        icon="arrow.down"
        tone="primary"
        fullWidth
        loading={busy}
        disabled={busy}
        onPress={() => void submit()}
      />
    </LineageSheetFrame>
  );
}
