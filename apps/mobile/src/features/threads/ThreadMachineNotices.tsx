import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  cloudPushCredential,
  githubAppConfigured,
  SANDBOX_OWNER_ONLY_REASON,
  type SandboxAction,
} from "@t3tools/client-runtime/state/sandbox";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef, ServerConfig as T3ServerConfig } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { Notice } from "../../components/ui/Notice";
import { cn } from "../../lib/cn";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  useSandboxActionRunner,
  useSandboxFailureMessage,
  useSandboxThreadMachine,
  useSharedMachineOwner,
} from "../../state/sandbox";
import { useTeamRoster } from "../../state/team";
import { openSettings } from "../settings/settings-navigation";

/** Threads whose shared-machine notice was dismissed, until the app reloads. */
const dismissedSharedMachineAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-shared-machine:dismissed"),
);

function MachineNotice(props: {
  readonly icon: AppSymbolName;
  readonly tone: "default" | "danger";
  readonly title: string;
  readonly detail?: string;
  readonly actions?: ReactNode;
}) {
  const danger = props.tone === "danger";
  return (
    <View
      className={cn(
        "gap-2 rounded-2xl border px-3.5 py-3",
        danger ? "border-danger-border bg-danger" : "border-border bg-card",
      )}
    >
      <View className="flex-row items-start gap-3">
        <View className="pt-0.5">
          <SymbolView
            name={props.icon}
            size={16}
            tintColorClassName={danger ? "accent-danger-foreground" : "accent-icon-muted"}
          />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text
            textRole="footnote"
            className={cn("font-t3-medium", danger ? "text-danger-foreground" : "text-foreground")}
            numberOfLines={2}
          >
            {props.title}
          </Text>
          {props.detail ? (
            <Text textRole="footnote" className="text-foreground-muted">
              {props.detail}
            </Text>
          ) : null}
        </View>
      </View>
      {props.actions ? <View className="flex-row justify-end gap-2">{props.actions}</View> : null}
    </View>
  );
}

/**
 * A cloud thread's machine notices above the composer: its failure with Retry and Discard, a
 * discarded machine, a push that has no GitHub credential, and a machine shared with a teammate.
 */
export function ThreadMachineNotices(props: {
  readonly thread: EnvironmentThreadShell;
  /** Null until queued creation reaches the server. */
  readonly threadRef: ScopedThreadRef | null;
  readonly serverConfig: T3ServerConfig | null;
  readonly onStartNewMachine: () => void;
}) {
  const navigation = useNavigation();
  const machine = useSandboxThreadMachine(props.threadRef);
  const failureMessage = useSandboxFailureMessage(props.threadRef);
  const sharedOwnerId = useSharedMachineOwner(props.threadRef);
  const dismissedShared = useAtomValue(dismissedSharedMachineAtom);
  const { members, me } = useTeamRoster(props.thread.environmentId);
  const runAction = useSandboxActionRunner();
  if (props.threadRef === null || props.thread.source.sandboxId === undefined) return null;
  const threadRef = props.threadRef;

  const actionButton = (action: SandboxAction, label: string) => {
    if (machine === null || !machine.actions.includes(action)) return null;
    const denied = machine.ownerOnlyDenied.includes(action);
    return (
      <Button
        key={action}
        label={label}
        tone="secondary"
        size="compact"
        disabled={denied}
        accessibilityHint={denied ? SANDBOX_OWNER_ONLY_REASON : undefined}
        onPress={() => runAction(threadRef, machine.sandboxId, action)}
      />
    );
  };

  const notices: ReactNode[] = [];
  if (machine?.state === "failed") {
    const discardDenied = machine.ownerOnlyDenied.includes("discard");
    notices.push(
      <MachineNotice
        key="failed"
        icon="exclamationmark.triangle"
        tone="danger"
        title={failureMessage ?? machine.presentation.label ?? "Machine failed"}
        {...(discardDenied
          ? { detail: `${SANDBOX_OWNER_ONLY_REASON} can discard this machine.` }
          : {})}
        actions={
          machine.actions.length > 0 ? (
            <>
              {actionButton("discard", "Discard")}
              {actionButton("retry", "Retry")}
            </>
          ) : undefined
        }
      />,
    );
  } else if (machine?.state === "destroyed") {
    notices.push(
      <MachineNotice
        key="destroyed"
        icon="cloud"
        tone="default"
        title={machine.presentation.label ?? "Machine discarded"}
        detail="Sending starts a new machine."
        actions={
          <Button
            label="Start a new machine"
            tone="secondary"
            size="compact"
            onPress={props.onStartNewMachine}
          />
        }
      />,
    );
  }

  const settings = props.serverConfig?.settings;
  const ownerId = props.thread.source.ownerId ?? null;
  const owner = ownerId === null ? undefined : members.get(ownerId);
  if (
    settings !== undefined &&
    cloudPushCredential({ appConfigured: githubAppConfigured(settings), owner }) === "missing"
  ) {
    const isOwner = ownerId !== null && ownerId === me;
    notices.push(
      <MachineNotice
        key="push"
        icon={{ ios: "key", android: "lock" }}
        tone="default"
        title={
          isOwner
            ? "Connect GitHub to push"
            : `Ask ${owner?.name ?? "the thread's owner"} to connect GitHub`
        }
        detail="This cloud thread has no GitHub credential, so pushes will be refused."
        {...(isOwner
          ? {
              actions: (
                <Button
                  label="Open Team settings"
                  tone="secondary"
                  size="compact"
                  onPress={() => openSettings(navigation, "SettingsTeam")}
                />
              ),
            }
          : {})}
      />,
    );
  }

  const sharedKey = `${threadRef.environmentId}:${threadRef.threadId}`;
  if (sharedOwnerId !== null && !dismissedShared.has(sharedKey)) {
    notices.push(
      <Notice
        key="shared"
        icon="person.2"
        message={`This thread shares ${members.get(sharedOwnerId)?.name ?? "a teammate"}'s machine. Its agent can read the GitHub and provider credentials of every thread there.`}
        dismissLabel="Dismiss"
        onDismiss={() =>
          appAtomRegistry.set(dismissedSharedMachineAtom, new Set(dismissedShared).add(sharedKey))
        }
      />,
    );
  }

  return notices.length === 0 ? null : <View className="gap-2 px-4 pb-3">{notices}</View>;
}
