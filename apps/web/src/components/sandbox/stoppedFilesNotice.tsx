import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type MemberId,
  type SandboxId,
  type SandboxState,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import { FILE_SURFACE_SUBHEADER_CLASS } from "~/components/files/fileSurfaceChrome";
import { Button } from "~/components/ui/button";
import { sandboxEnvironment } from "~/state/sandbox";
import { environmentThreadDetails } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

/** A cloud thread whose machine is not reachable: the server reads its files from the mirror. */
export interface StoppedFiles {
  readonly sandboxId: SandboxId;
  readonly state: SandboxState;
  readonly ownerMemberId: MemberId | null;
  /** The newest ready checkpoint's turn, the one the server reads; null before the first. */
  readonly turn: number | null;
}

const sameStoppedFiles = (left: StoppedFiles | null, right: StoppedFiles | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.sandboxId === right.sandboxId &&
    left.state === right.state &&
    left.ownerMemberId === right.ownerMemberId &&
    left.turn === right.turn);

const stoppedFilesFamily = Atom.family((key: string) => {
  const [environmentId = "", threadId = ""] = key.split("\u0000");
  const ref = { environmentId: environmentId as EnvironmentId, threadId: ThreadId.make(threadId) };
  return Atom.make((get): StoppedFiles | null => {
    const projection = get(environmentThreadDetails.quietThreadAtom(ref))?.projection;
    const sandbox = projection?.sandbox;
    if (
      projection === undefined ||
      sandbox === undefined ||
      (sandbox.state === "ready" && sandbox.runnerLostAt === null)
    ) {
      return null;
    }
    let newest: (typeof projection.checkpoints)[number] | undefined;
    for (const checkpoint of projection.checkpoints) {
      if (checkpoint.status !== "ready" || checkpoint.appRunOrdinal === null) continue;
      if (
        newest === undefined ||
        DateTime.isGreaterThan(checkpoint.capturedAt, newest.capturedAt)
      ) {
        newest = checkpoint;
      }
    }
    return {
      sandboxId: sandbox.id,
      state: sandbox.state,
      ownerMemberId: sandbox.ownerMemberId,
      turn: newest?.appRunOrdinal ?? null,
    };
  }).pipe(Atom.withEquality(sameStoppedFiles), Atom.withLabel(`stopped-files:${key}`));
});

const NOT_STOPPED_ATOM = Atom.make<StoppedFiles | null>(null).pipe(
  Atom.withLabel("stopped-files:none"),
);

/** Null for local threads and running machines, so their file surfaces render as before. */
export function useStoppedFiles(threadRef: ScopedThreadRef | null): StoppedFiles | null {
  return useAtomValue(
    threadRef === null
      ? NOT_STOPPED_ATOM
      : stoppedFilesFamily(`${threadRef.environmentId}\u0000${threadRef.threadId}`),
  );
}

/** "As of turn N" over a stopped machine's files, with Wake where the viewer may wake it. */
export function StoppedFilesNotice(props: {
  readonly threadRef: ScopedThreadRef;
  readonly stopped: StoppedFiles;
}) {
  const { threadRef, stopped } = props;
  const canWake = useAtomValue(
    sandboxEnvironment.actionAllowedAtom({
      environmentId: threadRef.environmentId,
      action: "wake",
      ownerMemberId: stopped.ownerMemberId,
    }),
  );
  const wake = useOrchestrationCommand(sandboxEnvironment.wake, { label: "wake machine" });
  return (
    <div className={FILE_SURFACE_SUBHEADER_CLASS} role="status">
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {stopped.turn === null
          ? "Machine stopped. No saved turn to show yet."
          : `Machine stopped. As of turn ${stopped.turn}, read-only.`}
      </span>
      {stopped.state === "sleeping" && canWake ? (
        <Button
          type="button"
          size="compact"
          variant="outline"
          onClick={() =>
            void wake({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, sandboxId: stopped.sandboxId },
            })
          }
        >
          Wake
        </Button>
      ) : null}
    </div>
  );
}
