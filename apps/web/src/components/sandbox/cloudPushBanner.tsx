import { cloudPushCredential } from "@t3tools/client-runtime/state/sandbox";
import {
  isSecretReference,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useCurrentMemberId, useTeamMembers } from "../../state/team";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { Button } from "../ui/button";

/**
 * A cloud thread whose pushes have no credential: no GitHub App, and the owner has no working
 * GitHub of their own. Not dismissible; it goes away when the state does.
 */
export function useCloudPushBanner(
  environmentId: EnvironmentId,
  thread: Pick<OrchestrationV2ThreadShell, "sandboxId" | "ownerId"> | null,
): ComposerBannerStackItem | null {
  const members = useTeamMembers(environmentId);
  const currentMemberId = useCurrentMemberId(environmentId);
  const appConfigured = useEnvironmentSettings(environmentId, (settings) => {
    const github = settings.sourceControlHosts.github;
    const key = github?.appPrivateKey;
    return (
      typeof github?.appId === "string" &&
      github.appId !== "" &&
      (isSecretReference(key) || (typeof key === "string" && key !== ""))
    );
  });
  if (thread?.sandboxId === undefined) return null;
  const ownerId = thread.ownerId ?? null;
  const owner = ownerId === null ? undefined : members.get(ownerId);
  if (cloudPushCredential({ appConfigured, owner }) !== "missing") return null;
  const isOwner = ownerId !== null && ownerId === currentMemberId;
  return {
    id: `cloud-push:${thread.sandboxId}`,
    variant: "warning",
    icon: <KeyRoundIcon />,
    title: isOwner
      ? "Connect GitHub to push"
      : `Ask ${owner?.name ?? "the thread's owner"} to connect GitHub`,
    description: "This cloud thread has no GitHub credential, so pushes will be refused.",
    ...(isOwner
      ? {
          actions: (
            <Button size="xs" variant="outline" render={<Link to="/settings/team" />}>
              Open Settings
            </Button>
          ),
        }
      : {}),
  };
}
