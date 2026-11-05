import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type * as Cause from "effect/Cause";

import { stackedThreadToast, toastManager } from "../ui/toast";

function toastFailureCause(title: string, cause: Cause.Cause<unknown>) {
  const error = squashAtomCommandFailure({ cause });
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

export function toastCommandFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  toastFailureCause(title, result.cause);
}
