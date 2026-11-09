import { useAtomValue } from "@effect/atom-react";
import {
  sameStoppedFiles,
  stoppedFilesFromProjection,
  stoppedReadLabel,
  type StoppedFiles,
} from "@t3tools/client-runtime/state/sandbox";
import { type EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { FILE_SURFACE_SUBHEADER_CLASS } from "~/components/files/fileSurfaceChrome";
import { Button } from "~/components/ui/button";
import { sandboxEnvironment } from "~/state/sandbox";
import { environmentThreadDetails } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

const stoppedFilesFamily = Atom.family((key: string) => {
  const [environmentId = "", threadId = ""] = key.split("\u0000");
  const ref = { environmentId: environmentId as EnvironmentId, threadId: ThreadId.make(threadId) };
  return Atom.make((get): StoppedFiles | null => {
    const projection = get(environmentThreadDetails.quietThreadAtom(ref))?.projection;
    return projection === undefined ? null : stoppedFilesFromProjection(projection);
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

/** How old a stopped machine's files are, with Wake where the viewer may wake it. */
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
        {stoppedReadLabel(stopped)}. Read-only.
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
