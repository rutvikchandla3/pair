import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { useNavigate } from "@tanstack/react-router";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { chiefOfStaffCommands } from "../state/chiefOfStaff";
import { buildThreadRouteParams } from "../threadRoutes";

type Navigate = ReturnType<typeof useNavigate>;

/**
 * Ensures the member's persistent Chief of staff thread exists, then opens it.
 * Failures are reported by the command itself; returns whether it opened.
 */
export async function openChiefOfStaffChat(
  environmentId: EnvironmentId,
  navigate: Navigate,
): Promise<boolean> {
  const result = await runAtomCommand(appAtomRegistry, chiefOfStaffCommands.openHome, {
    environmentId,
    input: undefined,
  });
  if (result._tag !== "Success") return false;
  await navigate({
    to: "/$environmentId/$threadId",
    params: buildThreadRouteParams(scopeThreadRef(environmentId, result.value.threadId)),
  });
  return true;
}
