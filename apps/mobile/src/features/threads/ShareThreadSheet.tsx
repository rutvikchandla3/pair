import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { SHARE_THREAD_OWNER_ONLY_REASON } from "@t3tools/client-runtime/state/sandbox";
import {
  applyShareChange,
  exceedsShareCap,
  removalWarning,
  SHARE_FAILURE_TITLE,
  sameShareAccess,
  shareAudienceLabel,
  shareCandidates,
  shareCapMessage,
  shareMachineContext,
  shareTrustSentence,
  unsettledShares,
  visibleShareAccess,
  type PendingShare,
  type ShareAccess,
  type ShareChange,
} from "@t3tools/client-runtime/state/share-thread";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import {
  EnvironmentId,
  ThreadId,
  type MemberId,
  type SandboxAccessAudience,
  type TeamMember,
} from "@t3tools/contracts";
import { useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { MemberAvatar } from "../../components/MemberAvatar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { copyThreadReference } from "../../lib/copyThreadReference";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentServerConfig, useQuietThreadShell } from "../../state/entities";
import { sandboxEnvironment, useThreadShare } from "../../state/sandbox";
import { useTeamRoster } from "../../state/team";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnection } from "../../state/use-remote-environment-registry";

type Params = { readonly environmentId: string; readonly threadId: string };

const AUDIENCES: ReadonlyArray<SandboxAccessAudience> = ["members", "team"];

export function ShareThreadSheet(props: StaticScreenProps<Params>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const threadRef = {
    environmentId: EnvironmentId.make(props.route.params.environmentId),
    threadId: ThreadId.make(props.route.params.threadId),
  };
  const { environmentId } = threadRef;
  const shell = useQuietThreadShell(threadRef);
  const share = useThreadShare(threadRef);
  const { members } = useTeamRoster(environmentId);
  const teamName = useSavedRemoteConnection(environmentId)?.environmentLabel.trim() || "the team";
  const providerInstances = useEnvironmentServerConfig(environmentId)?.settings.providerInstances;
  const threads = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  const setAccess = useAtomCommand(sandboxEnvironment.shareThreadCommand, {
    reportFailure: false,
  });
  const nextPendingId = useRef(0);
  const [pending, setPending] = useState<ReadonlyArray<PendingShare>>([]);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<ReadonlyArray<MemberId>>([]);
  const [confirming, setConfirming] = useState<MemberId | null>(null);
  const [capMessage, setCapMessage] = useState<string | null>(null);

  const android = Platform.OS === "android";
  const sandboxId = shell?.source.sandboxId;
  const summary = share?.access;
  const canShare = share?.allowed === true && summary?.canShare === true;
  const goBack = () => navigation.goBack();

  const frame = (header: ReactNode, body: ReactNode) => (
    // Material sheet drags follow the first nested-scrolling native view, and the inline
    // header's Compose button is one, so Android renders content first and reverses the column.
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1 android:flex-col-reverse"
      style={android ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {android ? (
        <NativeStackScreenOptions
          options={{ sheetCornerRadius: 28, sheetAllowedDetents: "fitToContents" }}
        />
      ) : null}
      {android ? null : header}
      <ScreenContent fitToContents>
        <ScrollView
          nestedScrollEnabled
          contentInsetAdjustmentBehavior="automatic"
          className="android:shrink android:grow-0 ios:flex-1"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
          contentContainerClassName="px-5 pt-4 pb-6 gap-5"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {body}
        </ScrollView>
      </ScreenContent>
      {android ? header : null}
    </View>
  );
  const presentation = android ? "inline" : "native";

  if (shell === null || sandboxId === undefined || summary === undefined || !canShare) {
    return frame(
      <SheetHeader
        presentation={presentation}
        title="Share"
        onClose={goBack}
        accessibilityLabel="Close share"
      />,
      <Text className="text-sm text-foreground-muted">{SHARE_THREAD_OWNER_ONLY_REASON}</Text>,
    );
  }

  const ownerId = summary.ownerId;
  const server: ShareAccess = {
    audience: summary.audience ?? "members",
    memberIds: summary.memberIds,
  };
  const access = visibleShareAccess(server, pending);
  const listed = access.memberIds.flatMap((id) => {
    const member = members.get(id);
    return member === undefined || member.removedAt !== null ? [] : [member];
  });
  const owner = ownerId === null ? undefined : members.get(ownerId);
  const candidates = shareCandidates(members, { ownerId, listed: access.memberIds, query });
  const { relatedThreadOwnerIds, ownAccountProvider } = shareMachineContext({
    threads,
    sandboxId,
    ownerThreadId: shell.source.sandbox?.ownerThreadId,
    ownerId,
    providerInstances: providerInstances ?? {},
  });

  const apply = async (change: ShareChange) => {
    const next = applyShareChange(access, change);
    if (sameShareAccess(next, access)) return;
    if (exceedsShareCap(next)) {
      setCapMessage(shareCapMessage(teamName));
      return;
    }
    setCapMessage(null);
    const id = ++nextPendingId.current;
    setPending((current) => [
      ...unsettledShares(server, current),
      { id, access: next, confirmed: false },
    ]);
    const result = await setAccess({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        sandboxId,
        audience: next.audience,
        memberIds: next.memberIds,
      },
    });
    if (result._tag === "Failure") {
      setPending((current) => current.filter((entry) => entry.id !== id));
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        SHARE_FAILURE_TITLE,
        error instanceof Error && error.message.trim() !== "" ? error.message : "Try again.",
      );
      return;
    }
    setPending((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, confirmed: true } : entry)),
    );
  };

  const warningFor = (member: TeamMember) =>
    removalWarning({ access, member, threadOwnerIds: relatedThreadOwnerIds });
  const remove = (member: TeamMember) => {
    setConfirming(null);
    void apply({ kind: "remove", memberId: member.id });
  };
  const closePicker = () => {
    setPicking(false);
    setQuery("");
    setChosen([]);
  };
  const addChosen = () => {
    if (chosen.length > 0) void apply({ kind: "add", memberIds: chosen });
    closePicker();
  };
  const copyLink = () => {
    const target = threadChipCopyTarget(threadRef, shell.title);
    void copyThreadReference(target).then((didCopy) => {
      if (!didCopy) Dialog.alert(target.failureTitle, "Try copying this thread again.");
    });
  };

  if (picking) {
    return frame(
      <SheetHeader
        presentation={presentation}
        title="Add people"
        onCancel={closePicker}
        accessibilityLabel="Back to sharing"
        confirm={{
          label: chosen.length === 0 ? "Add" : `Add ${chosen.length}`,
          disabled: chosen.length === 0,
          onPress: addChosen,
        }}
      />,
      <>
        <TextInput
          autoFocus
          accessibilityLabel="Add people"
          placeholder="Add people…"
          placeholderTextColorClassName="accent-foreground-muted"
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          className="min-h-12 rounded-xl bg-subtle px-4 text-base"
        />
        <View>
          {candidates.length === 0 ? (
            <Text className="text-sm text-foreground-muted">No matching members.</Text>
          ) : (
            candidates.map((member) => {
              const selected = chosen.includes(member.id);
              return (
                <Pressable
                  key={member.id}
                  accessibilityRole="button"
                  accessibilityLabel={member.name}
                  accessibilityState={{ selected }}
                  onPress={() =>
                    setChosen((current) =>
                      selected ? current.filter((id) => id !== member.id) : [...current, member.id],
                    )
                  }
                  className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle py-2 active:opacity-70"
                >
                  <MemberAvatar member={member} size="md" />
                  <View className="min-w-0 flex-1">
                    <Text numberOfLines={1} className="text-base text-foreground">
                      {member.name}
                    </Text>
                    {member.github ? (
                      <Text numberOfLines={1} className="text-xs text-foreground-muted">
                        @{member.github.login}
                      </Text>
                    ) : null}
                  </View>
                  {selected ? (
                    <SymbolView name="checkmark" size={16} tintColorClassName="accent-icon" />
                  ) : null}
                </Pressable>
              );
            })
          )}
        </View>
      </>,
    );
  }

  return frame(
    <SheetHeader
      presentation={presentation}
      title={`Share “${shell.title}”`}
      onClose={goBack}
      accessibilityLabel="Close share"
    />,
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add people"
        onPress={() => setPicking(true)}
        className="min-h-12 flex-row items-center justify-between gap-2 rounded-xl bg-subtle px-4 py-3 active:opacity-70"
      >
        <Text className="text-base text-foreground-muted">Add people…</Text>
        <SymbolView name="plus" size={16} tintColorClassName="accent-icon-muted" />
      </Pressable>
      {capMessage === null ? null : (
        <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
          {capMessage}
        </Text>
      )}

      <View className="gap-1">
        <Text className="text-sm font-t3-medium text-foreground">People with access</Text>
        {owner === undefined ? null : (
          <View className="min-h-12 flex-row items-center gap-3">
            <MemberAvatar member={owner} size="md" />
            <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
              {owner.name} (you)
            </Text>
            <Text className="text-xs text-foreground-muted">Owner</Text>
          </View>
        )}
        {listed.map((member) => {
          const warning = confirming === member.id ? warningFor(member) : null;
          return (
            <View key={member.id}>
              <View className="min-h-12 flex-row items-center gap-3">
                <MemberAvatar member={member} size="md" />
                <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
                  {member.name}
                </Text>
                {warning === null ? (
                  <Button
                    label="Remove"
                    accessibilityLabel={`Remove ${member.name}`}
                    tone="text"
                    size="compact"
                    onPress={() => {
                      if (warningFor(member) === null) remove(member);
                      else setConfirming(member.id);
                    }}
                  />
                ) : null}
              </View>
              {warning === null ? null : (
                <View className="gap-2 pb-2 pl-9">
                  <Text className="text-xs text-foreground-muted">{warning}</Text>
                  <View className="flex-row gap-2">
                    <Button
                      label="Cancel"
                      tone="text"
                      size="compact"
                      onPress={() => setConfirming(null)}
                    />
                    <Button
                      label="Remove"
                      accessibilityLabel={`Remove ${member.name} and their threads`}
                      tone="danger"
                      size="compact"
                      onPress={() => remove(member)}
                    />
                  </View>
                </View>
              )}
            </View>
          );
        })}
      </View>

      <View className="gap-2">
        <Text className="text-sm font-t3-medium text-foreground">General access</Text>
        <Menu
          accessibilityLabel={`General access: ${shareAudienceLabel(access.audience, teamName)}`}
          actions={AUDIENCES.map((audience) => ({
            id: audience,
            title: shareAudienceLabel(audience, teamName),
            state: audience === access.audience ? "on" : "off",
          }))}
          onPressAction={({ nativeEvent }) => {
            const audience = AUDIENCES.find((candidate) => candidate === nativeEvent.event);
            if (audience !== undefined) void apply({ kind: "audience", audience });
          }}
        >
          <View className="min-h-12 flex-row items-center justify-between gap-2 rounded-xl bg-subtle px-4 py-3">
            <Text className="text-base text-foreground">
              {shareAudienceLabel(access.audience, teamName)}
            </Text>
            <SymbolView name="chevron.down" size={14} tintColorClassName="accent-icon-muted" />
          </View>
        </Menu>
      </View>

      <Text className="text-xs text-foreground-muted">
        {shareTrustSentence({
          audience: access.audience,
          teamName,
          ownAccountProvider,
          relatedCount: relatedThreadOwnerIds.length,
        })}
      </Text>

      <View className="flex-row gap-3">
        <Button label="Copy link" icon="link" onPress={copyLink} />
        <Button label="Done" tone="primary" onPress={goBack} />
      </View>
    </>,
  );
}
