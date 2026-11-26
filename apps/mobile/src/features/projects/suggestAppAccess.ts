import type {
  EnvironmentId,
  SourceControlAppAccess,
  SourceControlAppAccessInput,
} from "@t3tools/contracts";
import { appSignInTargetForRemote } from "@t3tools/client-runtime/source-control-clients";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { msg } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";

/**
 * After a clone, says when the server is signed in with the forge app but the app does not reach
 * the repository, so an admin can install it on the repository's owner.
 */
export async function suggestAppAccessForRemote(
  check: (value: {
    readonly environmentId: EnvironmentId;
    readonly input: SourceControlAppAccessInput;
  }) => Promise<AtomCommandResult<SourceControlAppAccess, unknown>>,
  environmentId: EnvironmentId,
  remoteUrl: string,
): Promise<void> {
  const target = appSignInTargetForRemote(remoteUrl);
  if (target === null) return;
  const result = await check({ environmentId, input: target.input });
  if (result._tag !== "Success" || result.value.status !== "not-covered") return;
  const owner = target.input.repository.split("/")[0] ?? target.input.repository;
  Dialog.alert(
    m(msg("Give {app} access to {owner}", { app: target.appSignIn.appName, owner })),
    // oxlint-disable-next-line t3code/no-untranslated-copy -- Pair copy stays English
    `It isn't installed there, so GitHub requests for ${target.input.repository} use your own login and its lower rate limit. Ask an admin to install the team's GitHub App on ${owner}.`,
  );
}
