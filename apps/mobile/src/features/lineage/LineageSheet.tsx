import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  type LineageAction,
  lineageChipCopy,
  lineagePopoverRows,
} from "@t3tools/client-runtime/branch-lineage";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useLineageView, useSourceBranches } from "../../state/branch-lineage";
import { useThreadShells } from "../../state/entities";
import { useOpenLinkedThread } from "../threads/useOpenLinkedThread";
import { LineageSheetFrame } from "./LineageSheetFrame";
import { useLineageActions } from "./useLineageActions";
import { type LineageSheetParams, useLineageThread } from "./useLineageThread";

const ACTION_ICONS = {
  update: "arrow.down",
  offer: "arrow.up",
  branchOff: "arrow.triangle.branch",
  startFromMain: "arrow.uturn.forward",
  settle: "checkmark",
} as const;

/** The lineage pill's popover: the source and its branches, then what this thread can do. */
export function LineageSheet(props: StaticScreenProps<LineageSheetParams>) {
  const navigation = useNavigation();
  const { ref, shell, viewer } = useLineageThread(props.route.params);
  const view = useLineageView(ref);
  const branches = useSourceBranches(ref);
  const shells = useThreadShells();
  const actions = useLineageActions();
  const openLinkedThread = useOpenLinkedThread();
  const close = () => navigation.goBack();

  if (viewer === null || shell === null || view === null) {
    return (
      <LineageSheetFrame title="Branches" closeLabel="Close branches" onClose={close}>
        <Text className="text-sm text-foreground-muted">Reading this thread's branches…</Text>
      </LineageSheetFrame>
    );
  }

  const popover = lineagePopoverRows(
    view,
    shells
      .filter((entry) => entry.environmentId === ref.environmentId)
      .map((entry) => entry.source),
    viewer,
  );
  const chip = lineageChipCopy(shell.source, branches, viewer);
  const run = (action: LineageAction) => {
    switch (action.kind) {
      case "update":
        navigation.goBack();
        actions.open("ThreadUpdate", ref);
        return;
      case "offer":
        navigation.goBack();
        actions.open("ThreadOffer", ref);
        return;
      case "branchOff":
        navigation.goBack();
        actions.open("ThreadBranchOff", ref);
        return;
      case "startFromMain":
        void actions.startFromMain(ref).then((done) => done && navigation.goBack());
        return;
      case "settle":
        void actions.settle(ref).then((done) => done && navigation.goBack());
        return;
    }
  };

  return (
    <LineageSheetFrame title={popover.heading} closeLabel="Close branches" onClose={close}>
      <View className="gap-1">
        {popover.rows.map((row) => {
          const opens = row.canOpen && !row.isThisThread;
          const detail = [row.where, row.counts].filter((part) => part !== null).join(" · ");
          return (
            <Pressable
              key={row.threadId}
              accessibilityRole={opens ? "button" : undefined}
              accessibilityLabel={`${row.title}${row.isThisThread ? ", this thread" : ""}`}
              disabled={!opens}
              onPress={() => {
                navigation.goBack();
                openLinkedThread({
                  environmentId: String(ref.environmentId),
                  threadId: String(row.threadId),
                });
              }}
              className="flex-row items-start gap-3 border-t border-border-subtle py-2.5"
            >
              <View className="pt-0.5">
                <SymbolView
                  name={row.role === "source" ? "circle.fill" : "arrow.triangle.branch"}
                  size={row.role === "source" ? 8 : 14}
                  tintColorClassName="accent-icon-muted"
                />
              </View>
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
                  {row.title}
                  {row.isThisThread ? (
                    <Text className="text-xs text-foreground-muted"> · this thread</Text>
                  ) : null}
                </Text>
                {row.meta !== "" ? (
                  <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                    {row.meta}
                  </Text>
                ) : null}
                {detail !== "" ? (
                  <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                    {detail}
                  </Text>
                ) : null}
              </View>
              {opens ? (
                <SymbolView name="chevron.right" size={12} tintColorClassName="accent-chevron" />
              ) : null}
            </Pressable>
          );
        })}
      </View>
      {chip !== null && chip.actions.length > 0 ? (
        <View className="gap-2">
          {chip.actions.map((action) => (
            <Button
              key={action.kind}
              label={action.label}
              icon={ACTION_ICONS[action.kind]}
              tone={action.kind === "settle" ? "secondary" : "primary"}
              fullWidth
              onPress={() => run(action)}
            />
          ))}
        </View>
      ) : null}
    </LineageSheetFrame>
  );
}
