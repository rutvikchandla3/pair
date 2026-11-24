import {
  type BranchLineage,
  BranchLineageError,
  type BranchLineageErrorReason,
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type MemberId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2Sandbox,
  type OrchestrationV2ServerCommand,
  type ProjectId,
  type SandboxAccessGrant,
  type ThreadBranchOffDraft,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  historicalMessage,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";
import { providerInstanceOwner } from "@t3tools/shared/providerInstanceOwnership";
import { cloudMachineSizes } from "@t3tools/shared/sandbox";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as CloudPreparation from "../sandbox/lifecycle/CloudPreparation.ts";
import { SandboxWake } from "../sandbox/lifecycle/SandboxWakeService.ts";
import * as CheckpointMirror from "../sandbox/mirror/CheckpointMirror.ts";
import * as MirrorSync from "../sandbox/mirror/MirrorSync.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TeamState from "../team/TeamState.ts";
import * as ThreadAccess from "../team/ThreadAccess.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as WorkspaceHosts from "../workspaceHost/WorkspaceHosts.ts";
import { BranchOffService } from "./BranchOffService.ts";
import * as LineageGit from "./LineageGit.ts";
import type { LineageCaller } from "./LineageRepos.ts";
import { lineageFailed, mirrorGit, runGit } from "./LineageReposLive.ts";

const BUSY_WORKING = 3;
const SUMMARY_CONTEXT_BYTES = 24_000;
const SERVER_AUTHOR_EMAIL = "pair@users.noreply.github.com";

const refuse = (reason: BranchLineageErrorReason, message: string) =>
  new BranchLineageError({ reason, message });

const isBranchLineageError = Schema.is(BranchLineageError);

/** A refusal the orchestrator decided keeps its reason; anything else is a failure. */
const toLineageError = (error: {
  readonly _tag: string;
  readonly message: string;
  readonly cause?: unknown;
}): BranchLineageError => {
  if (isBranchLineageError(error)) return error;
  if (isBranchLineageError(error.cause)) return error.cause;
  if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
    return refuse("no-account", error.message);
  }
  return lineageFailed(typeof error.cause === "string" ? error.cause : error.message);
};

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "") || "branch";

const titleFrom = (prompt: string, fallback: string) => {
  const line = prompt.trim().split("\n", 1)[0]?.trim() ?? "";
  return line === "" ? fallback : line.length <= 80 ? line : `${line.slice(0, 77)}...`;
};

const machineState = (record: OrchestrationV2Sandbox | null) => {
  if (record === null) return "none" as const;
  switch (record.state) {
    case "ready":
      return "ready" as const;
    case "failed":
      return "failed" as const;
    case "destroyed":
      return "gone" as const;
    default:
      return "asleep" as const;
  }
};

/** The source's turns that left a checkpoint, newest first. */
const turnCheckpoints = (checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>) =>
  checkpoints
    .filter(
      (checkpoint) =>
        checkpoint.status === "ready" &&
        checkpoint.runId !== null &&
        checkpoint.appRunOrdinal !== null,
    )
    .toSorted((left, right) => (right.appRunOrdinal ?? 0) - (left.appRunOrdinal ?? 0));

/** "Start with a summary": the PR writer's prompt, aimed at a teammate instead of a reviewer. */
const SUMMARY_TEMPLATE = [
  "## Where it stands",
  "",
  "## Decisions so far",
  "",
  "## Open questions",
].join("\n");
const summaryInstructions = (title: string) =>
  [
    `This is not a pull request. Write a short briefing of the conversation "${title}" for a`,
    "teammate who is starting their own branch from where it stands. Say what was built, what was",
    "decided and why, and what is still open, in plain sentences. Leave out the Testing section.",
  ].join(" ");

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const lineageGit = yield* LineageGit.LineageGit;
  const mirror = yield* CheckpointMirror.CheckpointMirror;
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const team = yield* Effect.serviceOption(TeamState.TeamState);
  const access = yield* Effect.serviceOption(ThreadAccess.ThreadAccess);
  const launch = yield* Effect.serviceOption(ThreadLaunch.ThreadLaunchService);
  const mirrorSync = yield* Effect.serviceOption(MirrorSync.MirrorSync);
  const wake = yield* Effect.serviceOption(SandboxWake);
  const checkoutRoot = yield* CloudPreparation.SandboxCheckoutRoot;
  const transport = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | ServerConfig.ServerConfig
    | CheckpointMirror.CheckpointMirror
    | WorkspaceHosts.WorkspaceHosts
  >();
  const inMirror = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | FileSystem.FileSystem
      | Path.Path
      | ServerConfig.ServerConfig
      | CheckpointMirror.CheckpointMirror
      | WorkspaceHosts.WorkspaceHosts
    >,
  ) => Effect.provide(effect, transport);

  const read = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError((error) => lineageFailed(error.message)));
  const git = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((error) =>
        isBranchLineageError(error) ? error : lineageFailed(error.message),
      ),
    );
  const dispatch = (command: OrchestrationV2ServerCommand) =>
    threads.dispatch(command).pipe(Effect.mapError(toLineageError));

  const members = team.pipe(
    Option.match({
      onNone: () => Effect.succeed(new Map<MemberId, { readonly name: string }>()),
      onSome: (state) => Ref.get(state.members),
    }),
  );
  const nameOf = Effect.fnUntraced(function* (memberId: MemberId | null | undefined) {
    if (memberId == null) return "Someone";
    return (yield* members).get(memberId)?.name ?? "Someone";
  });
  const activeMemberIds = Effect.gen(function* () {
    if (Option.isNone(team)) return [] as ReadonlyArray<MemberId>;
    return [...TeamState.activeMemberIds(yield* Ref.get(team.value.members))];
  });

  /** The thread, if the caller may open it; one that's gone or closed to them reads the same. */
  const openThread = Effect.fn("BranchOffService.openThread")(function* (
    caller: LineageCaller,
    threadId: ThreadId,
  ) {
    const records = yield* threads
      .getThreadRecords(threadId, ["runs", "checkpoints"])
      .pipe(Effect.orElseSucceed(() => null));
    const thread = records?.thread;
    const gone = refuse("not-found", "That thread is gone, or you can't open it.");
    if (records == null || thread === undefined || thread.deletedAt !== null) {
      return yield* gone;
    }
    if (
      Option.isSome(access) &&
      access.value.enforced &&
      !access.value.allowsThread(caller.memberId, thread)
    ) {
      return yield* gone;
    }
    return records;
  });

  /** Why Branch off isn't offered on this thread, or null when it is. */
  const refusalFor = Effect.fn("BranchOffService.refusalFor")(function* (
    thread: OrchestrationV2AppThread,
  ) {
    if (thread.sandboxId === undefined) {
      return refuse("not-cloud", "Branch off is for cloud threads.");
    }
    if (thread.roots !== undefined || thread.worktreePath === null) {
      return refuse("failed", "Branch off doesn't support workspace threads yet.");
    }
    if ((yield* read(projections.getBranchLineage(thread.id))) !== null) {
      return refuse("branch-of-branch", "Branch off isn't offered on a branch.");
    }
    return null;
  });

  const sandboxOf = (sandboxId: OrchestrationV2AppThread["sandboxId"]) =>
    sandboxId === undefined ? Effect.succeed(null) : read(projections.getSandbox(sandboxId));

  /** Files the checkpoint has that its HEAD doesn't: the source's uncommitted work then. */
  const uncommittedAt = Effect.fn("BranchOffService.uncommittedAt")(function* (
    projectId: ProjectId,
    ref: string,
  ) {
    return yield* inMirror(
      mirrorGit(projectId, ["diff-tree", "-r", "-z", "--name-only", `${ref}^1`, ref]),
    ).pipe(
      Effect.map((out) => out.split("\0").filter((path) => path !== "").length),
      Effect.orElseSucceed(() => 0),
    );
  });

  /** Who can open the machine: its owner and list, or every active member for `team`. */
  const audienceOf = Effect.fn("BranchOffService.audienceOf")(function* (
    record: OrchestrationV2Sandbox | null,
  ) {
    if (record === null) return [] as ReadonlyArray<MemberId>;
    const active = new Set(yield* activeMemberIds);
    if ((record.access?.audience ?? "team") === "team") return [...active];
    const named = [
      ...(record.ownerMemberId === null ? [] : [record.ownerMemberId]),
      ...(record.access?.memberIds ?? []),
    ];
    return [...new Set(named)].filter((id) => active.size === 0 || active.has(id));
  });

  const workingOn = Effect.fn("BranchOffService.workingOn")(function* (
    record: OrchestrationV2Sandbox | null,
  ) {
    if (record === null) return 0;
    const rows = yield* read(projections.listSandboxThreads(record.id));
    let working = 0;
    for (const row of rows) {
      if (row.archived) continue;
      const shell = yield* read(threads.getThreadShell(row.threadId));
      if (shell !== null && (shell.activeRunId !== null || shell.status === "queued")) working += 1;
    }
    return working;
  });

  const handleOf = Effect.fnUntraced(function* (memberId: MemberId) {
    const member = (yield* members).get(memberId) as
      | { readonly name: string; readonly githubLogin?: string | null }
      | undefined;
    return (member?.githubLogin ?? firstName(member?.name ?? "me")).toLowerCase();
  });

  const draft: BranchOffService["Service"]["draft"] = Effect.fn("BranchOffService.draft")(
    function* (caller, { sourceThreadId }) {
      const { thread: source, runs, checkpoints } = yield* openThread(caller, sourceThreadId);
      const refusal = yield* refusalFor(source);
      const record = yield* sandboxOf(source.sandboxId);
      const turns = turnCheckpoints(checkpoints);
      const latest = turns[0];
      const messageIds = runs.flatMap((run) =>
        run.userMessageId === null ? [] : [run.userMessageId],
      );
      const messages =
        messageIds.length === 0
          ? new Map()
          : yield* read(projections.getMessagesById(source.id, messageIds));
      const working = yield* workingOn(record);
      const settings = yield* read(serverSettings.getSettings);
      const vcpus =
        record === null
          ? undefined
          : cloudMachineSizes(settings).find((size) => size.size === record.size)?.vcpus;
      const task =
        source.space?.kind === "task"
          ? yield* read(projections.getSpaceTask(source.space.taskId))
          : null;
      return {
        allowed: refusal === null,
        ...(refusal?.reason == null ? {} : { reason: refusal.reason }),
        sourceTitle: source.title,
        sourceOwnerId: source.ownerId ?? null,
        latestTurn: {
          turn: latest?.appRunOrdinal ?? 0,
          at: latest === undefined ? null : DateTime.formatIso(latest.capturedAt),
          uncommittedFiles:
            latest === undefined ? 0 : yield* uncommittedAt(source.projectId, latest.ref),
        },
        turns: turns.map((checkpoint) => {
          const run = runs.find((candidate) => candidate.id === checkpoint.runId);
          const text =
            run?.userMessageId == null ? "" : (messages.get(run.userMessageId)?.text ?? "");
          return {
            runId: checkpoint.runId!,
            turn: checkpoint.appRunOrdinal ?? 0,
            at: DateTime.formatIso(checkpoint.capturedAt),
            title: titleFrom(text, `Turn ${checkpoint.appRunOrdinal ?? 0}`),
          };
        }),
        machine: {
          state: machineState(record),
          working,
          ...(vcpus === undefined ? {} : { vcpus }),
          ownerId: record?.ownerMemberId ?? null,
        },
        audience: yield* audienceOf(record),
        busy: working >= BUSY_WORKING,
        suggestedBranch: `${yield* handleOf(caller.memberId)}/${slug(source.title)}`,
        ...(task === null ? {} : { taskTitle: task.title }),
      } satisfies ThreadBranchOffDraft;
    },
  );

  /** The git identity a snapshot is authored as: the source's owner. */
  const authorFor = Effect.fnUntraced(function* (ownerId: MemberId | null | undefined) {
    const name = yield* nameOf(ownerId);
    const author =
      ownerId == null || Option.isNone(team) ? undefined : yield* team.value.gitAuthorFor(ownerId);
    return author ?? { name, email: SERVER_AUTHOR_EMAIL };
  });

  /** Refuses a provider the caller can't use: the branch runs on the brancher's own account. */
  const assertAccount = Effect.fn("BranchOffService.assertAccount")(function* (
    caller: LineageCaller,
    commandId: CommandId,
    projectId: ProjectId,
    modelSelection: ModelSelection,
  ) {
    const noAccount = (error: { readonly message: string }) => refuse("no-account", error.message);
    yield* threads
      .assertNewThreadProviderInstanceSelectable({
        commandId,
        projectId,
        instanceId: modelSelection.instanceId,
        actorId: caller.memberId,
        ownerId: caller.memberId,
      })
      .pipe(Effect.mapError(noAccount));
    yield* threads
      .assertProviderInstanceEnabled({
        projectId,
        commandId,
        instanceId: modelSelection.instanceId,
      })
      .pipe(Effect.mapError(noAccount));
  });

  const placementFor = Effect.fn("BranchOffService.placementFor")(function* (
    projectId: ProjectId,
    modelSelection: ModelSelection,
  ) {
    if (Option.isNone(launch)) return yield* lineageFailed("This server starts no machines.");
    return yield* launch.value
      .checkCloudLaunch({ projectId, instanceId: modelSelection.instanceId })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "ProviderCloudLocalOnlyError"
            ? refuse("no-account", error.message)
            : lineageFailed(error.message),
        ),
      );
  });

  /** A commit for the mirror-side start: the snapshot of a checkpoint, or a branch's tip. */
  const startInMirror = Effect.fn("BranchOffService.startInMirror")(function* (input: {
    readonly source: OrchestrationV2AppThread;
    readonly checkpoint: OrchestrationV2Checkpoint | null;
    readonly branch: string | null;
    readonly author: { readonly name: string; readonly email: string };
    readonly message: string;
  }) {
    const { source } = input;
    yield* read(mirror.ensure(source.projectId));
    if (input.checkpoint === null) {
      const ref = `refs/t3/seed/origin/${input.branch ?? "HEAD"}`;
      const tip = (yield* read(mirror.tips(source.projectId, [ref]))).get(ref);
      if (tip === undefined)
        return yield* lineageFailed(`There's no ${input.branch} to start from.`);
      return tip;
    }
    const ref = input.checkpoint.ref;
    // A live machine syncs at each capture; one that missed it catches up here, never waking.
    const record = yield* sandboxOf(source.sandboxId);
    if (record?.state === "ready" && Option.isSome(mirrorSync) && source.worktreePath !== null) {
      yield* mirrorSync.value
        .sync({ threadId: source.id, cwd: source.worktreePath, checkpointRefs: [ref] })
        .pipe(Effect.ignore);
    }
    const checkpoint = (yield* read(mirror.tips(source.projectId, [ref]))).get(ref);
    if (checkpoint === undefined) {
      return yield* lineageFailed(
        "That turn hasn't reached Pair Cloud yet. Try again in a moment.",
      );
    }
    const parents = yield* read(mirror.commitParents(source.projectId, checkpoint));
    const head = parents?.[0];
    if (head === undefined) return yield* lineageFailed("That turn's checkpoint has no parent.");
    return (yield* inMirror(
      mirrorGit(
        source.projectId,
        ["commit-tree", `${checkpoint}^{tree}`, "-p", head, "-m", input.message],
        { GIT_AUTHOR_NAME: input.author.name, GIT_AUTHOR_EMAIL: input.author.email },
      ),
    )).trim();
  });

  /** The branch's checkout comes from the mirror on its machine's next start, as a seed. */
  const seedMirrorBranch = (projectId: ProjectId, threadId: ThreadId, commit: string) =>
    read(
      mirror.updateRefs(
        projectId,
        new Map([
          [CheckpointMirror.sandboxBranchRef(threadId), commit],
          [CheckpointMirror.sandboxSeedRef(threadId), commit],
        ]),
      ),
    );

  const branchOff: BranchOffService["Service"]["branchOff"] = Effect.fn(
    "BranchOffService.branchOff",
  )(function* (caller, input) {
    const { thread: source, checkpoints } = yield* openThread(caller, input.sourceThreadId);
    const refusal = yield* refusalFor(source);
    if (refusal !== null) return yield* refusal;
    const record = yield* sandboxOf(source.sandboxId);
    const state = machineState(record);
    const onSource = input.runsOn === "source-machine";
    if (onSource && (state === "failed" || state === "gone" || state === "none")) {
      return yield* refuse("machine-gone", "That machine is gone. Branch off onto a new machine.");
    }
    // Nobody's machine time is spent unattended.
    if (onSource && caller.authorKind === "agent" && record?.ownerMemberId !== caller.memberId) {
      return yield* refuse(
        "not-allowed",
        "An agent branches off only onto a new machine, unless the machine is its own member's.",
      );
    }

    const branchThreadId = yield* read(ids.allocate.thread({ projectId: source.projectId }));
    const commandId = CommandId.make(`branch-off:${branchThreadId}`);
    const modelSelection = input.modelSelection ?? source.modelSelection;
    yield* assertAccount(caller, commandId, source.projectId, modelSelection);
    const placement = onSource ? null : yield* placementFor(source.projectId, modelSelection);

    const turns = turnCheckpoints(checkpoints);
    const { startFrom } = input;
    const checkpoint =
      startFrom.type === "branch"
        ? null
        : startFrom.type === "latest"
          ? (turns[0] ?? null)
          : (turns.find((candidate) => candidate.runId === startFrom.runId) ?? null);
    if (startFrom.type !== "branch" && checkpoint === null) {
      return yield* lineageFailed("That turn has no checkpoint to start from.");
    }
    const sourceTurn = checkpoint?.appRunOrdinal ?? 0;
    const owner = yield* nameOf(source.ownerId);
    const author = yield* authorFor(source.ownerId);
    const message = `${firstName(owner)}'s work in progress, turn ${sourceTurn}`;
    const startBranch = input.startFrom.type === "branch" ? input.startFrom.branch : null;
    const now = DateTime.formatIso(yield* DateTime.now);
    const sourceCwd = source.worktreePath!;
    const sandboxId = source.sandboxId!;

    // Where the branch's checkout comes from, by machine.
    let start: string;
    let worktreePath: string;
    let seeded: boolean;
    if (onSource && state === "ready") {
      worktreePath = `${sourceCwd.slice(0, sourceCwd.lastIndexOf("/"))}/${input.branch.replaceAll("/", "-")}`;
      if (checkpoint === null) {
        const tip = yield* git(
          lineageGit.resolveCommit({ cwd: sourceCwd, rev: `refs/remotes/origin/${startBranch}` }),
        );
        if (tip === null) return yield* lineageFailed(`There's no ${startBranch} to start from.`);
        start = tip;
      } else {
        const commit = yield* git(
          lineageGit.resolveCommit({ cwd: sourceCwd, rev: checkpoint.ref }),
        );
        const head = yield* git(lineageGit.resolveCommit({ cwd: sourceCwd, rev: `${commit}^1` }));
        if (commit === null || head === null) {
          return yield* lineageFailed("That turn's checkpoint isn't on the machine anymore.");
        }
        start = yield* git(
          lineageGit.createSnapshot({
            cwd: sourceCwd,
            checkpoint: commit,
            sourceHead: head,
            previousSnapshot: null,
            author,
            message,
          }),
        );
      }
      yield* git(
        lineageGit.addBranchWorktree({
          repoCwd: sourceCwd,
          worktreePath,
          branch: input.branch,
          startCommit: start,
        }),
      );
      seeded = false;
    } else {
      start = yield* startInMirror({ source, checkpoint, branch: startBranch, author, message });
      yield* seedMirrorBranch(source.projectId, branchThreadId, start);
      worktreePath = onSource
        ? `${sourceCwd.slice(0, sourceCwd.lastIndexOf("/"))}/${input.branch.replaceAll("/", "-")}`
        : CloudPreparation.worktreePathFor(
            checkoutRoot(CloudPreparation.sandboxIdForLaunch(commandId)),
            input.branch,
          );
      seeded = true;
    }

    const lineage: BranchLineage = {
      branchThreadId,
      sourceThreadId: source.id,
      sourceOwnerId: source.ownerId ?? null,
      createdAt: now,
      createdBy: caller.memberId,
      runsOn: input.runsOn,
      startFrom: input.startFrom,
      snapshots:
        checkpoint === null
          ? []
          : [
              {
                sha: start,
                sourceRunId: checkpoint.runId,
                sourceTurn,
                createdAt: now,
                state: "on-branch",
                mergeCommit: null,
                undoCommit: null,
              },
            ],
      update: null,
      undoableUpdate: null,
      toOffer: { count: 0, commits: [] },
      behind: 0,
      sourceState: "open",
      shipped: null,
      unshipped: 0,
      reverted: null,
      revision: 1,
    };
    const createdBy = caller.authorKind === "agent" ? ("agent" as const) : ("user" as const);
    const creationSource = caller.authorKind === "agent" ? ("mcp" as const) : ("web" as const);
    const title = titleFrom(input.prompt, `${source.title} (branch)`);
    yield* dispatch({
      type: "thread.branch-off",
      commandId,
      actorId: caller.memberId,
      createdBy,
      creationSource,
      sourceThreadId: source.id,
      targetThreadId: branchThreadId,
      title,
      modelSelection,
      runtimeMode: source.runtimeMode,
      interactionMode: input.interactionMode ?? source.interactionMode,
      branch: input.branch,
      worktreePath,
      sandboxId: onSource ? sandboxId : null,
      lineage,
      sourceTurn,
      uncommittedFiles:
        checkpoint === null ? 0 : yield* uncommittedAt(source.projectId, checkpoint.ref),
    });
    if (placement !== null) {
      // Its own machine, on the brancher's time, open to whoever could open the source's.
      yield* dispatch({
        type: "sandbox.provision",
        commandId: CommandId.make(`${commandId}:sandbox`),
        threadId: branchThreadId,
        sandboxId: CloudPreparation.sandboxIdForLaunch(commandId),
        projectId: source.projectId,
        driverId: placement.driverId,
        size: placement.size,
        ...(placement.imageBuild === null ? {} : { imageBuild: placement.imageBuild }),
        access: audienceGrant(record, caller.memberId),
      });
    }
    if (onSource) {
      // The branch's first instructions say what it shares; the agent sees it on its first turn.
      yield* dispatch({
        type: "thread.branch-lineage.record",
        commandId: CommandId.make(`${commandId}:shared-machine`),
        threadId: branchThreadId,
        lineage: { ...lineage, revision: lineage.revision + 1 },
        notice: {
          kind: "agent-told",
          text: `This branch runs on ${owner}'s machine, next to ${source.title}: the database and services running there are shared with it, so changes to them affect ${firstName(owner)}'s thread too.`,
        },
      });
    }
    if (source.space?.kind === "task") {
      // Only for a member of the task's space; anyone else's branch stays out of it.
      yield* dispatch({
        type: "space.thread.link",
        commandId: CommandId.make(`${commandId}:task`),
        threadId: branchThreadId,
        actorId: caller.memberId,
        target: { spaceId: source.space.spaceId, taskId: source.space.taskId },
        via: "attach",
      }).pipe(
        Effect.catch((cause) =>
          Effect.logInfo("A branch did not join its source's task", { branchThreadId, cause }),
        ),
      );
    }

    const text = [input.contextSummary?.trim() ?? "", input.prompt.trim()]
      .filter((part) => part !== "")
      .join("\n\n");
    if (text !== "") {
      const dispatched = yield* dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${commandId}:initial-message`),
        threadId: branchThreadId,
        messageId: yield* read(ids.allocate.message({ threadId: branchThreadId, ordinal: 1 })),
        text,
        attachments: [],
        modelSelection,
        ...(input.prompt.trim() === "" ? {} : { titleSeed: title }),
        // A seeded checkout is made when its machine is up; the run waits for it.
        dispatchMode: seeded
          ? {
              type: "defer_start",
              workspaceStrategy: {
                type: "worktree",
                baseRef: source.branch ?? startBranch ?? "main",
                branch: input.branch,
              },
            }
          : { type: "start_immediately" },
        createdBy,
        creationSource,
        actorId: caller.memberId,
      });
      const run = dispatched.storedEvents.find((stored) => stored.event.type === "run.created");
      if (seeded && run?.event.type === "run.created" && Option.isSome(launch)) {
        yield* launch.value.prepareRun({
          commandId: CommandId.make(`${commandId}:prepare`),
          threadId: branchThreadId,
          runId: run.event.payload.id,
        });
      }
    }
    // "Wakes when you start": the shared machine's checkout waits for it.
    if (onSource && state !== "ready" && Option.isSome(wake)) {
      yield* wake.value.wake({ threadId: branchThreadId, actorId: caller.memberId });
    }
    return { threadId: branchThreadId };
  });

  const summary: BranchOffService["Service"]["summary"] = Effect.fn("BranchOffService.summary")(
    function* (caller, input) {
      const { thread: source, checkpoints } = yield* openThread(caller, input.sourceThreadId);
      const projection = yield* read(threads.getThreadProjection(source.id));
      const selected = selectHistory({
        messages: projection.visibleTurnItems.flatMap(({ item }) => historicalMessage(item) ?? []),
        coverage: `The conversation "${source.title}", oldest first.`,
        budget: SUMMARY_CONTEXT_BYTES,
      });
      if (selected.messages.length === 0) return { text: "" };
      const settings = yield* read(serverSettings.getSettings);
      const modelSelection = input.modelSelection ?? ownTextModel(settings, caller.memberId);
      const owner = providerInstanceOwner(settings, modelSelection.instanceId);
      if (owner !== undefined && owner !== caller.memberId) {
        return yield* refuse("no-account", "Pick one of your own accounts to write the summary.");
      }
      const files = [
        ...new Set(
          turnCheckpoints(checkpoints).flatMap((checkpoint) =>
            checkpoint.files.map((file) => file.path),
          ),
        ),
      ];
      const workDir = yield* hosts.local.fileSystem
        .makeTempDirectoryScoped({ prefix: "t3code-branch-summary-" })
        .pipe(Effect.mapError((error) => lineageFailed(error.message)));
      const generated = yield* textGeneration
        .generatePrContent({
          cwd: workDir,
          baseBranch: "main",
          headBranch: source.branch ?? source.title,
          commitSummary: "",
          diffSummary: files.length === 0 ? "No files changed yet." : files.join("\n"),
          diffPatch: "",
          changeRequestTemplate: SUMMARY_TEMPLATE,
          threadContext: renderHistory(selected.messages, selected.context),
          policy: {
            kind: "custom",
            changeRequestInstructions: summaryInstructions(source.title),
            inferRepositoryConventions: false,
          },
          modelSelection,
        })
        .pipe(Effect.mapError((error) => lineageFailed(error.message)));
      return { text: generated.body.trim() };
    },
    Effect.scoped,
  );

  /**
   * Seeds the mirror with the thread's work as it stands: a live machine's working tree, else its
   * latest checkpoint, so the new machine's checkout picks up exactly there.
   */
  const seedMove = Effect.fn("BranchOffService.seedMove")(function* (
    thread: OrchestrationV2AppThread,
    checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>,
    live: boolean,
  ) {
    const branchRef = CheckpointMirror.sandboxBranchRef(thread.id);
    const snapshotRef = CheckpointMirror.sandboxSnapshotRef(thread.id);
    yield* read(mirror.ensure(thread.projectId));
    let snapshot: string | null = null;
    if (live && thread.worktreePath !== null && Option.isSome(mirrorSync)) {
      const cwd = thread.worktreePath;
      const host = yield* hosts
        .forPath(cwd)
        .pipe(Effect.mapError(() => lineageFailed("That machine isn't reachable.")));
      const tree = yield* git(lineageGit.worktreeTree({ cwd }));
      const moveRef = `refs/t3/lineage/move/${tree.commit}`;
      yield* inMirror(runGit(host, cwd, ["update-ref", moveRef, tree.commit])).pipe(
        Effect.mapError((error) => lineageFailed(String(error))),
      );
      yield* mirrorSync.value
        .sync({ threadId: thread.id, cwd, checkpointRefs: [moveRef as never] })
        .pipe(
          Effect.mapError((error) => lineageFailed(error.message)),
          Effect.ensuring(
            inMirror(runGit(host, cwd, ["update-ref", "-d", moveRef])).pipe(Effect.ignore),
          ),
        );
      snapshot = tree.commit;
      yield* read(mirror.deleteRefs(thread.projectId, [moveRef]));
    } else {
      const latest = turnCheckpoints(checkpoints)[0];
      if (latest !== undefined) {
        snapshot =
          (yield* read(mirror.tips(thread.projectId, [latest.ref]))).get(latest.ref) ?? null;
      }
    }
    const head = (yield* read(mirror.tips(thread.projectId, [branchRef]))).get(branchRef);
    if (head === undefined) {
      return yield* lineageFailed("Nothing of this thread has reached Pair Cloud yet.");
    }
    const parents =
      snapshot === null ? null : yield* read(mirror.commitParents(thread.projectId, snapshot));
    yield* read(
      mirror.updateRefs(
        thread.projectId,
        new Map([
          [CheckpointMirror.sandboxSeedRef(thread.id), head],
          // The snapshot restores only on the branch it was taken on.
          ...(snapshot !== null && parents?.length === 1 && parents[0] === head
            ? [[snapshotRef, snapshot] as const]
            : []),
        ]),
      ),
    );
  });

  const moveToOwnMachine: BranchOffService["Service"]["moveToOwnMachine"] = Effect.fn(
    "BranchOffService.moveToOwnMachine",
  )(function* (caller, input) {
    const { thread, runs, checkpoints } = yield* openThread(caller, input.threadId);
    if (thread.sandboxId === undefined) {
      return yield* refuse("not-cloud", "Only a cloud thread runs on a machine.");
    }
    if (thread.worktreePath === null || thread.branch === null || thread.roots !== undefined) {
      return yield* lineageFailed("This thread has no checkout of its own to move.");
    }
    const record = yield* sandboxOf(thread.sandboxId);
    if (record?.ownerThreadId === thread.id) {
      return yield* refuse("not-allowed", "This thread already has a machine of its own.");
    }
    if (caller.memberId !== thread.ownerId && caller.memberId !== record?.ownerMemberId) {
      return yield* refuse(
        "not-owner",
        "Only the thread's owner or its machine's owner can move it.",
      );
    }
    if (runs.some(ThreadManagement.isActiveRun)) {
      return yield* refuse("turn-running", "Move it after this turn.");
    }
    const commandId = CommandId.make(
      `thread-move:${thread.id}:${yield* read(ids.allocate.thread({}))}`,
    );
    const placement = yield* placementFor(thread.projectId, thread.modelSelection);
    const live = record?.state === "ready";
    yield* seedMove(thread, checkpoints, live);
    const sandboxId = CloudPreparation.sandboxIdForLaunch(commandId);
    const oldPath = thread.worktreePath;
    yield* dispatch({
      type: "thread.machine.move",
      commandId,
      threadId: thread.id,
      actorId: caller.memberId,
      sandboxId,
      driverId: placement.driverId,
      size: placement.size,
      ...(placement.imageBuild === null ? {} : { imageBuild: placement.imageBuild }),
      worktreePath: CloudPreparation.worktreePathFor(checkoutRoot(sandboxId), thread.branch),
    });
    // Frees the old checkout; its branch stays in the mirror. A sleeping disk keeps it.
    if (live) {
      const host = yield* hosts.forPath(oldPath).pipe(Effect.option);
      if (Option.isSome(host)) {
        yield* inMirror(
          runGit(host.value, oldPath, ["worktree", "remove", "--force", oldPath]),
        ).pipe(
          Effect.tap((result) =>
            result.exitCode === 0
              ? Effect.void
              : Effect.logWarning("Could not free a moved thread's checkout", {
                  threadId: thread.id,
                  stderr: result.stderr,
                }),
          ),
          Effect.ignore,
        );
      }
    }
  });

  const startFromMain: BranchOffService["Service"]["startFromMain"] = Effect.fn(
    "BranchOffService.startFromMain",
  )(function* (caller, input) {
    const { thread, runs } = yield* openThread(caller, input.threadId);
    const lineage = yield* read(projections.getBranchLineage(thread.id));
    if (lineage === null || lineage.detachedAt !== undefined) {
      return yield* refuse("not-found", "This thread isn't a branch.");
    }
    if (caller.memberId !== thread.ownerId) {
      return yield* refuse("not-owner", "Only the branch's owner can do that.");
    }
    const sourceShell = yield* read(threads.getThreadShell(lineage.sourceThreadId));
    const settled =
      lineage.sourceState !== "open" ||
      sourceShell === null ||
      sourceShell.settledOverride === "settled" ||
      sourceShell.settledAt !== null;
    if (!settled) {
      return yield* refuse(
        "not-allowed",
        "Its source is still open: offer your work to it instead.",
      );
    }
    if (lineage.update !== null) {
      return yield* refuse("update-open", "Finish the open Update first.");
    }
    if (runs.some(ThreadManagement.isActiveRun)) {
      return yield* refuse("turn-running", "Do that after this turn.");
    }
    const cwd = thread.worktreePath;
    if (cwd === null) return yield* lineageFailed("This thread has no checkout.");
    const base =
      sourceShell?.pullRequests?.find((link) => link.snapshot?.state === "merged")?.snapshot
        ?.baseBranch ?? "main";
    const host = yield* hosts
      .forPath(cwd)
      .pipe(Effect.mapError(() => lineageFailed("This thread's machine isn't reachable.")));
    const gitHere = (args: ReadonlyArray<string>, env?: Record<string, string>) =>
      inMirror(runGit(host, cwd, args, env === undefined ? {} : { env })).pipe(
        Effect.mapError((error) => lineageFailed(String(error))),
      );
    const fetched = yield* gitHere(["fetch", "--quiet", "origin", base]);
    if (fetched.exitCode !== 0) {
      return yield* lineageFailed(fetched.stderr.trim() || `Could not fetch ${base}.`);
    }
    const onto = yield* git(lineageGit.resolveCommit({ cwd, rev: `refs/remotes/origin/${base}` }));
    if (onto === null) return yield* lineageFailed(`There's no ${base} to start from.`);
    const brancher = yield* authorFor(caller.memberId);
    const preHead = yield* git(lineageGit.resolveCommit({ cwd, rev: "HEAD" }));
    const wip = yield* git(
      lineageGit.commitAll({ cwd, author: brancher, message: "Work in progress" }),
    );
    const commits = [...lineage.toOffer.commits, ...(wip === null ? [] : [wip])];
    const env = LineageGit.authorEnv(brancher);
    const restore = gitHere(["cherry-pick", "--abort"]).pipe(
      Effect.andThen(gitHere(["reset", "--quiet", "--hard", wip ?? preHead ?? "HEAD"])),
      Effect.andThen(
        wip === null || preHead === null
          ? Effect.void
          : gitHere(["reset", "--quiet", "--soft", preHead]).pipe(
              Effect.andThen(gitHere(["reset", "--quiet"])),
            ),
      ),
      Effect.ignore,
    );
    yield* gitHere(["reset", "--quiet", "--hard", onto]);
    for (const sha of commits) {
      const picked = yield* gitHere(["cherry-pick", "--allow-empty", sha], {
        ...env,
        GIT_COMMITTER_NAME: "Pair",
        GIT_COMMITTER_EMAIL: SERVER_AUTHOR_EMAIL,
      });
      if (picked.exitCode !== 0) {
        const conflicts = (yield* gitHere(["diff", "--name-only", "--diff-filter=U"])).stdout
          .split("\n")
          .filter((path) => path !== "");
        yield* restore;
        return yield* refuse(
          "would-conflict",
          conflicts.length === 0
            ? `Your commits don't apply on ${base}.`
            : `Your commits conflict with ${base}: ${conflicts.join(", ")}. Resolve them on this branch, then try again.`,
        );
      }
    }
    // The uncommitted work goes back to being uncommitted.
    if (wip !== null) {
      yield* gitHere(["reset", "--quiet", "--soft", "HEAD~1"]);
      yield* gitHere(["reset", "--quiet"]);
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* dispatch({
      type: "thread.branch-lineage.record",
      commandId: CommandId.make(`start-from-main:${thread.id}:${lineage.revision + 1}`),
      threadId: thread.id,
      lineage: {
        ...lineage,
        toOffer: { count: 0, commits: [] },
        unshipped: 0,
        detachedAt: now,
        revision: lineage.revision + 1,
      },
    });
    const movedMachine = lineage.runsOn === "source-machine";
    if (movedMachine) yield* moveToOwnMachine(caller, { threadId: thread.id });
    return { base, commits: lineage.toOffer.commits.length, movedMachine };
  });

  return BranchOffService.of({ draft, branchOff, summary, moveToOwnMachine, startFromMain });
});

/** A new machine for a branch starts with its source machine's audience, minus the brancher. */
const audienceGrant = (
  record: OrchestrationV2Sandbox | null,
  brancher: MemberId,
): SandboxAccessGrant | null => {
  if (record === null) return { audience: "members", memberIds: [] };
  const audience = record.access?.audience ?? "team";
  const memberIds = [
    ...new Set([
      ...(record.ownerMemberId === null ? [] : [record.ownerMemberId]),
      ...(record.access?.memberIds ?? []),
    ]),
  ].filter((id) => id !== brancher);
  return { audience, memberIds };
};

/** The caller's own account when they have one, else the team's text model. */
const ownTextModel = (
  settings: ServerSettings.ServerSettingsService["Service"] extends {
    readonly getSettings: Effect.Effect<infer S, infer _E>;
  }
    ? S
    : never,
  memberId: MemberId,
): ModelSelection => {
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    if (instance?.ownerMemberId !== memberId || instance.enabled === false) continue;
    return {
      instanceId: instanceId as ModelSelection["instanceId"],
      model:
        DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[instance.driver] ??
        DEFAULT_MODEL_BY_PROVIDER[instance.driver] ??
        DEFAULT_TEXT_GENERATION_MODEL,
    };
  }
  return settings.textGenerationModelSelection;
};

export const layer = Layer.effect(BranchOffService, make);
