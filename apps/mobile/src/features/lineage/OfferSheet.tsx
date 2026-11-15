import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { offerDialogCopy } from "@t3tools/client-runtime/branch-lineage";
import { useRef, useState } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import {
  branchLineageEnvironment,
  reportLineageResult,
  useLineageView,
} from "../../state/branch-lineage";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { DiffCounts } from "./OfferChangesSheet";
import { LineageSheetFrame } from "./LineageSheetFrame";
import { useLineageActions } from "./useLineageActions";
import { type LineageSheetParams, useLineageThread } from "./useLineageThread";

/** Offer to the source: the commits, a note, the uncommitted files committed first, the check. */
export function OfferSheet(props: StaticScreenProps<LineageSheetParams>) {
  const navigation = useNavigation();
  const { ref, viewer } = useLineageThread(props.route.params);
  const view = useLineageView(ref);
  const preview = useEnvironmentQuery(
    branchLineageEnvironment.offerPreview({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId },
    }),
  );
  const create = useAtomCommand(branchLineageEnvironment.offerCreate, { reportFailure: false });
  const actions = useLineageActions();
  const [note, setNote] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const close = () => navigation.goBack();

  const data = preview.data;
  if (viewer === null || data === null) {
    return (
      <LineageSheetFrame title="Offer" closeLabel="Cancel offer" onClose={close}>
        <Text className="text-sm text-foreground-muted">
          {preview.error ?? "Checking your changes…"}
        </Text>
      </LineageSheetFrame>
    );
  }

  const copy = offerDialogCopy(data, {
    viewer,
    lineage: view?.lineage ?? null,
    sourceTurn: null,
  });

  const submit = async () => {
    if (copy.primary.kind === "update") {
      close();
      actions.open("ThreadUpdate", ref);
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const result = await create({
      environmentId: ref.environmentId,
      input: {
        threadId: ref.threadId,
        ...(note.trim() === "" ? {} : { note: note.trim() }),
        ...(commitMessage.trim() === "" ? {} : { commitMessage: commitMessage.trim() }),
      },
    });
    inFlight.current = false;
    setBusy(false);
    if (reportLineageResult("Could not offer your changes", result)) close();
  };

  return (
    <LineageSheetFrame
      title={copy.title}
      subtitle={copy.description}
      closeLabel="Cancel offer"
      onClose={close}
    >
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <Text className="text-sm font-t3-medium text-foreground">{copy.summary}</Text>
          <DiffCounts additions={data.additions} deletions={data.deletions} />
        </View>
        {data.commits.map((commit) => (
          <Text key={commit.sha} numberOfLines={1} className="text-xs text-foreground-muted">
            {commit.sha.slice(0, 7)} {commit.subject}
          </Text>
        ))}
      </View>
      {copy.uncommitted !== null ? (
        <View className="gap-2">
          <Text className="text-xs text-foreground-muted">{copy.uncommitted}</Text>
          <TextInput
            accessibilityLabel="Commit message"
            placeholder="Commit message"
            editable={!busy}
            value={commitMessage}
            onChangeText={setCommitMessage}
            className="rounded-xl bg-subtle px-4 py-3 text-base"
          />
        </View>
      ) : null}
      {copy.check.clean ? (
        <TextInput
          multiline
          accessibilityLabel="Note"
          placeholder="Add a note"
          editable={!busy}
          value={note}
          onChangeText={setNote}
          textAlignVertical="top"
          className="min-h-16 rounded-xl bg-subtle px-4 py-3 text-base"
        />
      ) : null}
      <View className="gap-1">
        <View className="flex-row items-start gap-2">
          <SymbolView
            name={copy.check.clean ? "checkmark" : "exclamationmark.triangle"}
            size={13}
            tintColorClassName={
              copy.check.clean ? "accent-adaptive-emerald-600-400" : "accent-warning-foreground"
            }
          />
          <Text
            className={cn(
              "min-w-0 flex-1 text-xs",
              copy.check.clean ? "text-adaptive-emerald-600-400" : "text-warning-foreground",
            )}
          >
            {copy.check.text}
          </Text>
        </View>
        <Text className="text-xs text-foreground-muted">{copy.check.note}</Text>
      </View>
      <Text className="text-xs text-foreground-muted">{copy.footer}</Text>
      <Button
        label={copy.primary.label}
        icon={copy.primary.kind === "offer" ? "arrow.up" : "arrow.down"}
        tone="primary"
        fullWidth
        loading={busy}
        disabled={busy}
        onPress={() => void submit()}
      />
    </LineageSheetFrame>
  );
}
