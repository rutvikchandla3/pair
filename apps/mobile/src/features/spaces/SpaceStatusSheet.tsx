import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { SPACE_TASK_STATUSES, spaceTaskControls } from "@t3tools/client-runtime/spaces";
import { SpaceTaskId, type SpaceTaskStatus } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { reportSpaceResult, spaceEnvironment } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { SpaceSheetFrame } from "./SpaceSheetFrame";
import { SpaceTaskStatusIcon } from "./SpaceStatusIcon";
import { type SpaceSheetParams, useSheetSpace } from "./useSheetSpace";

export type SpaceTaskSheetParams = SpaceSheetParams & { readonly taskId: string };

/** Change status (board 9c): the five statuses, the current one checked. */
export function SpaceStatusSheet(props: StaticScreenProps<SpaceTaskSheetParams>) {
  const navigation = useNavigation();
  const { environmentId, space, viewer, canOperate, tasks } = useSheetSpace(props.route.params);
  const setStatus = useAtomCommand(spaceEnvironment.setTaskStatus, { reportFailure: false });
  const close = () => navigation.goBack();
  const taskId = SpaceTaskId.make(props.route.params.taskId);
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (space === null || task === undefined) {
    return (
      <SpaceSheetFrame header={{ title: "Change status", onClose: close }}>
        <Text className="text-sm text-foreground-muted">This task isn't available.</Text>
      </SpaceSheetFrame>
    );
  }
  const controls = spaceTaskControls(task, space, viewer.memberId, canOperate);
  const pick = (status: SpaceTaskStatus) => {
    close();
    if (status === task.status) return;
    void setStatus({ environmentId, input: { spaceId: space.id, taskId: task.id, status } }).then(
      (result) => reportSpaceResult("Could not change the status", result),
    );
  };
  return (
    <SpaceSheetFrame header={{ title: "Change status", subtitle: task.title, onClose: close }}>
      <View>
        {SPACE_TASK_STATUSES.map((info) => {
          const current = info.status === task.status;
          const disabled = !controls.canSetStatus;
          return (
            <Pressable
              key={info.status}
              accessibilityRole="button"
              accessibilityLabel={info.label}
              accessibilityState={{ selected: current, disabled }}
              disabled={disabled}
              onPress={() => pick(info.status)}
              className="min-h-12 flex-row items-center gap-3 border-t border-border-subtle active:opacity-70"
            >
              <SpaceTaskStatusIcon icon={info.icon} tone={info.tone} label={info.label} size={18} />
              <Text className="min-w-0 flex-1 text-base text-foreground">{info.label}</Text>
              {current ? (
                <SymbolView name="checkmark" size={16} tintColorClassName="accent-icon" />
              ) : null}
            </Pressable>
          );
        })}
      </View>
      <Text className="text-sm text-foreground-muted">
        Moving it doesn't start or stop its threads.
      </Text>
    </SpaceSheetFrame>
  );
}
