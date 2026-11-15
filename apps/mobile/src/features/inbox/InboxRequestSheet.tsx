import { type StaticScreenProps, StackActions, useNavigation } from "@react-navigation/native";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { useDerivedValue, useSharedValue } from "react-native-reanimated";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useEnvironmentScope } from "../../state/session";
import { useSelectedThreadRequests } from "../../state/use-selected-thread-requests";
import { useThreadSelection } from "../../state/use-thread-selection";
import { SpaceSheetFrame } from "../spaces/SpaceSheetFrame";
import { PendingApprovalCard } from "../threads/PendingApprovalCard";
import { PendingUserInputCard } from "../threads/PendingUserInputCard";

/** Read by `useThreadSelection`, so the thread's own request handling answers here. */
type Params = { readonly environmentId: string; readonly threadId: string };

/** An Inbox approval or question, answered with the thread's own cards. */
export function InboxRequestSheet(_props: StaticScreenProps<Params>) {
  const navigation = useNavigation();
  const { selectedThread, selectedThreadRef } = useThreadSelection();
  const requests = useSelectedThreadRequests();
  const canOperateThread = useEnvironmentScope(
    selectedThreadRef?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const { height } = useWindowDimensions();
  const maxHeight = useDerivedValue(() => height * 0.6, [height]);
  const [collapsed, setCollapsed] = useState(false);
  // 1 is expanded; the thread view animates it, a sheet just switches.
  const cardProgress = useDerivedValue((): number => (collapsed ? 0 : 1), [collapsed]);
  const cardCoverage = useSharedValue(0);
  const close = () => navigation.goBack();
  const openThread = () => {
    if (selectedThreadRef === null) return;
    navigation.goBack();
    navigation.dispatch(StackActions.push("Thread", { ...selectedThreadRef }));
  };
  const answered =
    requests.activePendingApproval === null && requests.activePendingUserInput === null;

  return (
    <SpaceSheetFrame
      header={{ title: selectedThread?.title ?? "Thread", onClose: close }}
      footer={<Button label="Open thread" icon="arrow.up.right" fullWidth onPress={openThread} />}
    >
      <Text className="text-sm text-foreground-muted">Answering here answers in the thread.</Text>
      {requests.activePendingApproval ? (
        <PendingApprovalCard
          canOperateThread={canOperateThread}
          approval={requests.activePendingApproval}
          respondingApprovalId={requests.respondingApprovalId}
          onRespond={requests.onRespondToApproval}
        />
      ) : null}
      {requests.activePendingUserInput && selectedThreadRef !== null ? (
        <View>
          <PendingUserInputCard
            environmentId={selectedThreadRef.environmentId}
            canOperateThread={canOperateThread}
            pendingUserInput={requests.activePendingUserInput}
            maxHeight={maxHeight}
            collapsed={collapsed}
            onToggleCollapsed={() => setCollapsed(!collapsed)}
            cardProgress={cardProgress}
            cardCoverage={cardCoverage}
            drafts={requests.activePendingUserInputDrafts}
            answers={requests.activePendingUserInputAnswers}
            respondingUserInputId={requests.respondingUserInputId}
            onSelectOption={requests.onSelectUserInputOption}
            onChangeCustomAnswer={requests.onChangeUserInputCustomAnswer}
            onSubmit={requests.onSubmitUserInput}
            onDismiss={requests.onDismissUserInput}
          />
        </View>
      ) : null}
      {answered ? (
        <Text className="py-6 text-center text-sm text-foreground-muted">
          {selectedThread === null ? "Loading…" : "Nothing is waiting on you in this thread."}
        </Text>
      ) : null}
    </SpaceSheetFrame>
  );
}
