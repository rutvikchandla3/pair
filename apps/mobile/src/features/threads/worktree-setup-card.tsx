import { Button } from "../../components/ui/Button";
import type { WorktreeSetupSnapshot, WorktreeSetupStage } from "@t3tools/contracts";
import {
  worktreeSetupAgentStarted,
  worktreeSetupHeaderLabel,
  worktreeSetupMachineRow,
  worktreeSetupMachineWaiting,
  worktreeSetupStageDetail,
  worktreeSetupStageTitle,
  type WorktreeSetupMachineRow,
} from "@t3tools/client-runtime/worktree-setup";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { WorktreeSetupSheet } from "./worktree-setup-sheet";
import { ShimmeringWorkContent } from "./thread-work-log";
import { useVisibleSecondClock } from "./use-visible-second-clock";

export interface WorktreeSetupCardProps {
  snapshot: WorktreeSetupSnapshot;
  turnStarted: boolean;
  turnStartedAt: string | null;
  working: boolean;
  onCancel: () => void;
  onWorkLocally: (() => void) | null;
}

function elapsed(start: string | null, end: string | null, now: number) {
  const duration = (end ? Date.parse(end) : now) - (start ? Date.parse(start) : NaN);
  return Number.isFinite(duration) ? formatDuration(Math.max(0, duration)) : null;
}

const icons: Record<
  WorktreeSetupStage["status"] | WorktreeSetupMachineRow["status"],
  AppSymbolName
> = {
  pending: "circle",
  // The clock means waiting for a machine; a paused running row is not that.
  waiting: "clock",
  running: "circle.dashed",
  done: "checkmark",
  skipped: "minus",
  failed: "xmark",
  warning: "exclamationmark.triangle",
};

export function WorktreeSetupCard(props: WorktreeSetupCardProps) {
  const { snapshot, turnStarted, turnStartedAt, working } = props;
  const handedOff = turnStarted && worktreeSetupAgentStarted(snapshot);
  const running = snapshot.phase === "running";
  const backgroundSetup = handedOff && running;
  const scriptName = snapshot.setupScript?.name ?? "Setup script";
  const [detailsOpen, setDetailsOpen] = useState(false);
  const now = useVisibleSecondClock(running || working);
  const failed =
    snapshot.phase === "failed" || snapshot.stages.some((stage) => stage.status === "failed");
  const label =
    handedOff && working
      ? `Working for ${elapsed(turnStartedAt, null, now) ?? "0s"}`
      : running && handedOff
        ? "Setup continues…"
        : worktreeSetupHeaderLabel(snapshot);
  const machineRow = worktreeSetupMachineRow(snapshot, now);

  return (
    <View accessibilityLabel="Worktree setup" className="py-1">
      <View className="min-h-11 flex-row items-center gap-2 border-b border-border px-1">
        <HeaderLabel
          label={label}
          active={(working || (running && !worktreeSetupMachineWaiting(snapshot))) && !detailsOpen}
          failed={failed && !working}
        />
        {/* While setup runs, only its active row ticks. */}
        {!handedOff && !running ? (
          <Text
            className="text-2xs text-foreground-secondary"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {elapsed(snapshot.startedAt, snapshot.endedAt, now)}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            backgroundSetup
              ? `Background setup is still running: ${scriptName}. Show setup progress.`
              : "Worktree setup details"
          }
          accessibilityState={{ expanded: detailsOpen }}
          onPress={() => setDetailsOpen(true)}
          className="min-h-11 max-w-[55%] justify-center px-2"
        >
          <View
            className={
              backgroundSetup
                ? "min-w-0 flex-row items-center gap-1 rounded-full border border-border px-2 py-1"
                : "flex-row items-center gap-1"
            }
          >
            {backgroundSetup ? (
              <AppActivityIndicator
                size={Platform.OS === "android" ? 12 : "small"}
                colorClassName="accent-icon-muted"
                style={{
                  width: 12,
                  height: 12,
                  transform: Platform.OS === "android" ? undefined : [{ scale: 0.65 }],
                }}
              />
            ) : failed ? (
              <SymbolView
                name="exclamationmark.circle"
                size={12}
                tintColorClassName="accent-danger-foreground"
              />
            ) : null}
            <Text numberOfLines={1} className="shrink text-2xs text-foreground-secondary">
              {backgroundSetup ? "Background setup" : "Details"}
            </Text>
            {!backgroundSetup ? (
              <SymbolView name="chevron.right" size={10} tintColorClassName="accent-icon-muted" />
            ) : null}
          </View>
        </Pressable>
      </View>
      {!handedOff ? (
        <View className="pt-1 pb-2">
          {machineRow ? (
            <MachineRow row={machineRow} now={now} compact animate={!detailsOpen} />
          ) : null}
          {snapshot.stages
            .filter((stage) => stage.id !== "agent")
            .map((stage) => (
              <StageRow
                key={stage.id}
                snapshot={snapshot}
                stage={stage}
                now={now}
                compact
                animate={!detailsOpen}
              />
            ))}
        </View>
      ) : null}
      {detailsOpen ? (
        <SetupDetailsSheet {...props} now={now} onClose={() => setDetailsOpen(false)} />
      ) : null}
    </View>
  );
}

export function WorktreeWorkingHeader({ startedAt }: { startedAt: string }) {
  const now = useVisibleSecondClock(true);
  return (
    <View className="py-1">
      <View className="min-h-11 flex-row items-center border-b border-border px-1">
        <HeaderLabel label={`Working for ${elapsed(startedAt, null, now) ?? "0s"}`} active />
      </View>
    </View>
  );
}

function HeaderLabel({
  label,
  active,
  failed = false,
}: {
  label: string;
  active: boolean;
  failed?: boolean;
}) {
  return active ? (
    <ShimmeringWorkContent
      icon="clock"
      iconSubtleColor="transparent"
      label={label}
      showIcon={false}
    />
  ) : (
    <Text
      numberOfLines={1}
      className={
        failed
          ? "flex-1 text-sm text-danger-foreground"
          : "flex-1 text-sm text-foreground-secondary"
      }
      style={{ fontVariant: ["tabular-nums"] }}
    >
      {label}
    </Text>
  );
}

function SetupDetailsSheet({
  snapshot,
  turnStarted,
  onCancel,
  onWorkLocally,
  onClose,
  now,
}: WorktreeSetupCardProps & { onClose: () => void; now: number }) {
  const insets = useSafeAreaInsets();
  const [bodyHeight, setBodyHeight] = useState(0);
  const canCancel = snapshot.phase === "running" && !turnStarted;
  const machineRow = worktreeSetupMachineRow(snapshot, now);
  return (
    <WorktreeSetupSheet height={bodyHeight} onClose={onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        bounces={false}
        onContentSizeChange={(_width, height) => setBodyHeight(height)}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: Math.max(20, insets.bottom),
        }}
      >
        {machineRow ? <MachineRow row={machineRow} now={now} /> : null}
        {snapshot.stages
          .filter((stage) => stage.id !== "agent")
          .map((stage) => (
            <View key={stage.id}>
              <StageRow snapshot={snapshot} stage={stage} now={now} />
              {stage.id === "setup-script" &&
              (stage.status === "running" || stage.status === "failed" || stage.tail.length > 0) ? (
                <OutputTail lines={stage.tail} failed={stage.status === "failed"} />
              ) : null}
            </View>
          ))}
        {snapshot.phase === "failed" && snapshot.error ? (
          <Text selectable className="ml-8 mt-2 text-xs text-danger-foreground">
            {snapshot.error}
          </Text>
        ) : null}
        {canCancel ? (
          <View className="mt-3 flex-row items-center justify-end gap-4 border-t border-border pt-1">
            <Button
              label="Cancel setup"
              tone="danger"
              accessibilityLabel="Cancel worktree setup"
              onPress={() => {
                onClose();
                onCancel();
              }}
            />
            {onWorkLocally ? (
              <Button
                label="Work locally"
                tone="secondary"
                onPress={() => {
                  onClose();
                  onWorkLocally();
                }}
              />
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </WorktreeSetupSheet>
  );
}

function MachineRow({
  row,
  now,
  compact = false,
  animate = true,
}: {
  row: WorktreeSetupMachineRow;
  now: number;
  compact?: boolean;
  animate?: boolean;
}) {
  return (
    <View>
      <SetupRow
        label={row.label}
        status={row.status}
        detail={row.detail}
        duration={row.status === "skipped" ? null : elapsed(row.startedAt, row.endedAt, now)}
        compact={compact}
        animate={animate}
      />
      {row.note ? (
        <Text className="mb-1 ml-8 text-xs text-foreground-secondary">{row.note}</Text>
      ) : null}
    </View>
  );
}

function StageRow({
  snapshot,
  stage,
  now,
  compact = false,
  animate = true,
}: {
  snapshot: WorktreeSetupSnapshot;
  stage: WorktreeSetupStage;
  now: number;
  compact?: boolean;
  animate?: boolean;
}) {
  return (
    <SetupRow
      label={worktreeSetupStageTitle(snapshot, stage)}
      status={stage.status}
      detail={worktreeSetupStageDetail(snapshot, stage)}
      duration={
        stage.status === "pending" || stage.status === "skipped"
          ? null
          : elapsed(stage.startedAt, stage.endedAt, now)
      }
      compact={compact}
      animate={animate}
    />
  );
}

function SetupRow({
  label,
  status,
  detail,
  duration,
  compact,
  animate,
}: {
  label: string;
  status: WorktreeSetupStage["status"] | WorktreeSetupMachineRow["status"];
  detail: string | null;
  duration: string | null;
  compact: boolean;
  animate: boolean;
}) {
  return (
    <View
      accessibilityLabel={`${label}, ${status}`}
      className={compact ? "min-h-8 flex-row items-center" : "min-h-11 flex-row items-center"}
      style={{ columnGap: 8, opacity: status === "pending" ? 0.4 : 1 }}
    >
      <View className="w-6 items-center">
        {status === "running" && animate ? (
          <AppActivityIndicator
            size="small"
            colorClassName="accent-icon-muted"
            style={{ transform: [{ scale: 0.75 }] }}
          />
        ) : (
          <SymbolView
            name={icons[status]}
            size={14}
            tintColorClassName={
              status === "failed"
                ? "accent-danger-foreground"
                : status === "warning"
                  ? "accent-warning-foreground"
                  : "accent-icon-muted"
            }
          />
        )}
      </View>
      {status === "running" && animate ? (
        <ShimmeringWorkContent
          icon="clock"
          iconSubtleColor="transparent"
          label={label}
          showIcon={false}
        />
      ) : (
        <Text
          numberOfLines={1}
          className={
            status === "failed"
              ? "flex-1 text-sm text-danger-foreground"
              : "flex-1 text-sm text-foreground-secondary"
          }
        >
          {label}
        </Text>
      )}
      {detail ? (
        <Text numberOfLines={1} className="max-w-[40%] shrink text-2xs text-foreground-secondary">
          {detail}
        </Text>
      ) : null}
      {duration ? (
        <Text
          className="text-2xs text-foreground-secondary"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {duration}
        </Text>
      ) : null}
    </View>
  );
}

const OUTPUT_TAIL_SLOTS = [0, 1, 2, 3] as const;

function OutputTail({ lines, failed }: { lines: ReadonlyArray<string>; failed: boolean }) {
  return (
    <View
      accessibilityLabel="Setup script output"
      className={
        failed
          ? "mb-2 ml-8 rounded-md border border-danger-border bg-danger px-3 py-2"
          : "mb-2 ml-8 rounded-md border border-border bg-card-alt px-3 py-2"
      }
    >
      {OUTPUT_TAIL_SLOTS.map((slot) => (
        <Text
          key={slot}
          selectable
          numberOfLines={1}
          className={
            failed
              ? "text-2xs leading-5 text-danger-foreground ios:font-[family-name:Menlo] android:font-mono"
              : "text-2xs leading-5 text-foreground-secondary ios:font-[family-name:Menlo] android:font-mono"
          }
        >
          {lines[lines.length - OUTPUT_TAIL_SLOTS.length + slot] || "\u00a0"}
        </Text>
      ))}
    </View>
  );
}
