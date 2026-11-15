import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { lineageChipCopy } from "@t3tools/client-runtime/branch-lineage";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useLineageViewer, useSourceBranches } from "../../state/branch-lineage";
import { useQuietThreadShell } from "../../state/entities";
import { lineageComposerModel } from "./lineagePresentation";
import { useLineageActions } from "./useLineageActions";

// The pill's height plus its gap, kept clear at the top of the feed so it never covers a message.
const PILL_SPACE = 36;

function useLineageChip(environmentId: EnvironmentId, threadId: ThreadId) {
  const ref = scopeThreadRef(environmentId, threadId);
  const shell = useQuietThreadShell(ref);
  const viewer = useLineageViewer(environmentId);
  const branches = useSourceBranches(ref);
  if (shell === null || viewer === null) return null;
  return lineageChipCopy(shell.source, branches, viewer);
}

/** The lineage chip as a pill under the title; it opens the lineage sheet. */
export function ThreadLineagePill(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly top: number;
}) {
  const chip = useLineageChip(props.environmentId, props.threadId);
  const actions = useLineageActions();
  if (chip === null) return null;
  return (
    <View
      pointerEvents="box-none"
      className="absolute left-3 right-3 z-20"
      style={{ top: props.top }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Branches: ${chip.text}`}
        accessibilityHint="Lists this thread's source and branches"
        onPress={() =>
          actions.open("ThreadLineage", scopeThreadRef(props.environmentId, props.threadId))
        }
        className="max-w-full flex-row items-center gap-1.5 self-start rounded-full border border-border bg-card px-2.5 py-1"
      >
        <SymbolView
          name="arrow.triangle.branch"
          size={12}
          tintColorClassName={chip.accent ? "accent-adaptive-indigo-600-300" : "accent-icon-muted"}
        />
        <Text className="shrink text-xs text-foreground" numberOfLines={1}>
          {chip.text}
        </Text>
        <SymbolView name="chevron.down" size={10} tintColorClassName="accent-icon-muted" />
      </Pressable>
    </View>
  );
}

/** Keeps the feed's first row below the pill. */
export function ThreadLineagePillSpace(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const chip = useLineageChip(props.environmentId, props.threadId);
  return chip === null ? null : <View style={{ height: PILL_SPACE }} />;
}

/**
 * Above the composer: the open Update's resolving row with Abort, Update and Offer on your own
 * branch, and on someone else's cloud thread where a message goes, with Branch off.
 */
export function ThreadLineageComposerRows(props: { readonly thread: EnvironmentThreadShell }) {
  const viewer = useLineageViewer(props.thread.environmentId);
  const actions = useLineageActions();
  const [aborting, setAborting] = useState(false);
  if (viewer === null) return null;
  const ref = scopeThreadRef(props.thread.environmentId, props.thread.id);
  const model = lineageComposerModel(props.thread.source, viewer);
  if (model.hint === null && model.resolving === null && model.actions.length === 0) return null;
  const { hint, resolving } = model;
  return (
    <View className="gap-2 px-4 pb-2">
      {resolving !== null ? (
        <View className="flex-row items-center gap-2 rounded-xl border border-warning-border bg-warning px-3 py-2">
          <SymbolView name="clock" size={13} tintColorClassName="accent-warning-foreground" />
          <Text className="min-w-0 flex-1 text-xs text-warning-foreground" numberOfLines={2}>
            {resolving.text}
            {resolving.paths.length > 0 ? (
              <Text className="font-mono"> · {resolving.paths.join(", ")}</Text>
            ) : null}
          </Text>
          {resolving.canAbort ? (
            <Button
              label={resolving.action.label}
              tone="secondary"
              size="compact"
              loading={aborting}
              disabled={aborting}
              onPress={() => {
                setAborting(true);
                void actions.abortUpdate(ref).finally(() => setAborting(false));
              }}
            />
          ) : null}
        </View>
      ) : null}
      {model.actions.length > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          {model.actions.map((action) => (
            <Button
              key={action.kind}
              label={action.label}
              icon={action.kind === "update" ? "arrow.down" : "arrow.up"}
              tone="secondary"
              size="compact"
              onPress={() =>
                actions.open(action.kind === "update" ? "ThreadUpdate" : "ThreadOffer", ref)
              }
            />
          ))}
        </View>
      ) : null}
      {hint !== null ? (
        <View className="flex-row items-center justify-between gap-2">
          <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
            {hint.text}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${hint.prompt} ${hint.cta}`}
            hitSlop={8}
            onPress={() => actions.open("ThreadBranchOff", ref)}
            className="flex-row items-center gap-1"
          >
            <SymbolView
              name="arrow.triangle.branch"
              size={12}
              tintColorClassName="accent-primary-text"
            />
            <Text className="text-xs font-t3-medium text-primary-text">{hint.cta}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
