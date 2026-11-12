import { VcsRepositoryDetectionError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as CheckpointMirror from "./CheckpointMirror.ts";

/** The two CheckpointStore reads a diff needs; cwd is the scope's, and a mirror reader ignores it. */
export type CheckpointDiffReader = Pick<
  CheckpointStore.CheckpointStore["Service"],
  "diffCheckpoints" | "listAuthoredPaths"
>;

/** None means "read where the thread's files are", today's behavior. Default: always None. */
export interface CheckpointDiffPlacementShape {
  readonly readerFor: (threadId: ThreadId) => Effect.Effect<Option.Option<CheckpointDiffReader>>;
}

export const CheckpointDiffPlacement = Context.Reference<CheckpointDiffPlacementShape>(
  "t3/sandbox/mirror/CheckpointDiffPlacement",
  { defaultValue: () => ({ readerFor: () => Effect.succeedNone }) },
);

const makeMirrorDiffPlacement = Effect.gen(function* () {
  const mirror = yield* CheckpointMirror.CheckpointMirror;
  const projection = yield* ProjectionStore.ProjectionStoreV2;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  // safe.bareRepository=explicit (VcsProcess) refuses `git -C <bare>`, so every command names its git dir.
  const checkpoints = (yield* GitVcsDriver.makeVcsDriverShape().pipe(
    Effect.provideService(VcsProcess.VcsProcess, {
      run: (input) => vcsProcess.run({ ...input, args: [`--git-dir=${input.cwd}`, ...input.args] }),
    }),
  )).checkpoints;

  const readerFor: CheckpointDiffPlacementShape["readerFor"] = Effect.fn(
    "MirrorCheckpointReader.readerFor",
  )(
    function* (threadId) {
      const thread = yield* projection.getThread(threadId);
      if (thread.sandboxId === undefined) return Option.none();
      // A workspace thread's repositories each read their root project's mirror.
      const mirrors = (thread.roots ?? [{ projectId: thread.projectId, name: "" }]).map((root) => ({
        name: root.name,
        cwd: mirror.gitDir(root.projectId),
        projectId: root.projectId,
        checkpoints,
      }));

      // A pending sync leaves the refs out; the sandbox, if it is up, still has them. Any other failure surfaces.
      const heldBy = (from: string, to: string, operation: string) =>
        Effect.forEach(mirrors, (entry) =>
          mirror.tips(entry.projectId, [from, to]).pipe(
            Effect.map((tips) => tips.has(from) && tips.has(to)),
            Effect.mapError(
              (cause) =>
                new VcsRepositoryDetectionError({
                  operation,
                  cwd: entry.cwd,
                  detail: "The checkpoint mirror could not be read.",
                  cause,
                }),
            ),
          ),
        );
      const single = mirrors[0]!;

      /** Each repository from its mirror when that holds both refs, else from the machine. */
      const presentFor = (
        cwd: string,
        held: ReadonlyArray<boolean>,
      ): Effect.Effect<ReadonlyArray<CheckpointStore.PresentRoot>> => {
        const onMachine = mirrors.filter((_, index) => !held[index]).map((entry) => entry.name);
        return (
          onMachine.length === 0 ? Effect.succeed([]) : checkpointStore.presentRoots(cwd, onMachine)
        ).pipe(
          Effect.map((machine) =>
            mirrors.flatMap((entry, index) =>
              held[index] ? [entry] : machine.filter((root) => root.name === entry.name),
            ),
          ),
        );
      };

      const reader: CheckpointDiffReader = {
        diffCheckpoints: (input) =>
          heldBy(
            input.fromCheckpointRef,
            input.toCheckpointRef,
            "MirrorCheckpointReader.diffCheckpoints",
          ).pipe(
            Effect.flatMap((held) =>
              !held.some(Boolean)
                ? checkpointStore.diffCheckpoints(input)
                : thread.roots === undefined
                  ? checkpoints.diffCheckpoints({ ...input, cwd: single.cwd })
                  : presentFor(input.cwd, held).pipe(
                      Effect.flatMap((present) => CheckpointStore.diffRoots(present, input)),
                    ),
            ),
          ),
        listAuthoredPaths: (input) =>
          heldBy(
            input.fromCheckpointRef,
            input.toCheckpointRef,
            "MirrorCheckpointReader.listAuthoredPaths",
          ).pipe(
            Effect.flatMap((held) =>
              !held.some(Boolean)
                ? checkpointStore.listAuthoredPaths(input)
                : thread.roots === undefined
                  ? checkpoints.listAuthoredPaths({ ...input, cwd: single.cwd })
                  : presentFor(input.cwd, held).pipe(
                      Effect.flatMap((present) =>
                        CheckpointStore.listAuthoredPathsInRoots(present, input),
                      ),
                    ),
            ),
          ),
      };
      return Option.some(reader);
    },
    // An unreadable projection reads like today: where the thread's files are.
    (effect) => effect.pipe(Effect.catch(() => Effect.succeedNone)),
  );

  return { readerFor } satisfies CheckpointDiffPlacementShape;
});

export const layer = Layer.effect(CheckpointDiffPlacement, makeMirrorDiffPlacement);
