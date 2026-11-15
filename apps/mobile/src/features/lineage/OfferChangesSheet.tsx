import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { OfferId } from "@t3tools/contracts";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { branchLineageEnvironment, useLineageView } from "../../state/branch-lineage";
import { useEnvironmentQuery } from "../../state/query";
import { LineageSheetFrame } from "./LineageSheetFrame";
import { type LineageSheetParams, useLineageThread } from "./useLineageThread";

// A phone sheet, not the review surface: past this many lines a file says how many it leaves out.
const MAX_PATCH_LINES = 400;

export function DiffCounts(props: { readonly additions: number; readonly deletions: number }) {
  return (
    <Text className="font-mono text-xs">
      <Text className="text-adaptive-emerald-600-400">+{props.additions}</Text>{" "}
      <Text className="text-danger-foreground">−{props.deletions}</Text>
    </Text>
  );
}

/** View changes: only the sender's lines, file by file. */
export function OfferChangesSheet(
  props: StaticScreenProps<LineageSheetParams & { readonly offerId: string }>,
) {
  const navigation = useNavigation();
  const { ref } = useLineageThread(props.route.params);
  const offerId = OfferId.make(props.route.params.offerId);
  const view = useLineageView(ref);
  const diff = useEnvironmentQuery(
    branchLineageEnvironment.offerDiff({ environmentId: ref.environmentId, input: { offerId } }),
  );
  const offer = view?.offers.find((candidate) => candidate.id === offerId) ?? null;
  const close = () => navigation.goBack();
  const countsOf = (path: string) => offer?.files.find((file) => file.path === path) ?? null;

  return (
    <LineageSheetFrame
      title="Changes"
      {...(offer === null
        ? {}
        : {
            subtitle: `${offer.commits.length === 1 ? "1 commit" : `${offer.commits.length} commits`} · ${offer.files.length === 1 ? "1 file" : `${offer.files.length} files`}`,
          })}
      closeLabel="Close changes"
      onClose={close}
    >
      {diff.data === null ? (
        <Text className="text-sm text-foreground-muted">
          {diff.error ?? "Reading the changes…"}
        </Text>
      ) : (
        diff.data.files.map((file) => {
          const counts = countsOf(file.path);
          const lines = file.patch.split("\n");
          const shown = lines.slice(0, MAX_PATCH_LINES);
          return (
            <View key={file.path} className="gap-2">
              <View className="flex-row items-center gap-2">
                <Text
                  className="min-w-0 flex-1 font-mono text-xs font-t3-medium text-foreground"
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {file.previousPath === undefined
                    ? file.path
                    : `${file.previousPath} → ${file.path}`}
                </Text>
                {counts === null ? null : (
                  <DiffCounts additions={counts.additions} deletions={counts.deletions} />
                )}
              </View>
              <ScrollView horizontal className="rounded-xl bg-subtle">
                <Text className="px-3 py-2 font-mono text-[11px] leading-4 text-foreground">
                  {shown.map((line, index) => (
                    <Text
                      // oxlint-disable-next-line react/no-array-index-key -- a patch's lines are positional and never reorder
                      key={index}
                      className={
                        line.startsWith("+") && !line.startsWith("+++")
                          ? "text-adaptive-emerald-600-400"
                          : line.startsWith("-") && !line.startsWith("---")
                            ? "text-danger-foreground"
                            : line.startsWith("@@")
                              ? "text-foreground-muted"
                              : undefined
                      }
                    >
                      {index === shown.length - 1 ? line : `${line}\n`}
                    </Text>
                  ))}
                </Text>
              </ScrollView>
              {lines.length > MAX_PATCH_LINES ? (
                <Text className="text-xs text-foreground-muted">
                  {lines.length - MAX_PATCH_LINES} more lines
                </Text>
              ) : null}
            </View>
          );
        })
      )}
    </LineageSheetFrame>
  );
}
