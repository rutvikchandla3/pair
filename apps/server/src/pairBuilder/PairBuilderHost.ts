import {
  CommandId,
  type PairBuilderSessionMode,
  type Project,
  ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { truncate } from "@t3tools/shared/String";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { PairBuilderPerson } from "../auth/PairBuilderIngress.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PairBuilderMembers from "../team/PairBuilderMembers.ts";

export class PairBuilderWorkspaceError extends Schema.TaggedError<PairBuilderWorkspaceError>()(
  "PairBuilderWorkspaceError",
  { workspaceRoot: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not open the Pair Builder workspace project.";
  }
}

/** The message reaches the Builder, which shows it on the task. */
export class PairBuilderSessionNotStartedError extends Schema.TaggedError<PairBuilderSessionNotStartedError>()(
  "PairBuilderSessionNotStartedError",
  {
    reason: Schema.Literals([
      "member-removed",
      "member-unavailable",
      "workspace-unavailable",
      "no-default-model",
      "launch-failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "member-removed":
        return "This person was removed from the workspace's team.";
      case "member-unavailable":
        return "The workspace could not add this person to its team.";
      case "workspace-unavailable":
        return "The workspace project is unavailable.";
      case "no-default-model":
        return "The workspace has no default model.";
      case "launch-failed":
        return "The workspace could not start the session.";
    }
  }
}

export interface PairBuilderSessionStart {
  readonly prompt: string;
  readonly title?: string | undefined;
  readonly mode?: PairBuilderSessionMode | undefined;
  readonly person: PairBuilderPerson;
}

export type PairBuilderStartedSession =
  | { readonly threadId: ThreadId; readonly promptAccepted: true }
  | { readonly threadId: ThreadId; readonly promptAccepted: false; readonly error: string };

/** Pair Builder host mode: the task's workspace project and the sessions the Builder starts. */
export class PairBuilderHost extends Context.Service<
  PairBuilderHost,
  {
    /** The project for the Builder's workspace root, created on first start. */
    readonly bootstrapWorkspaceProject: Effect.Effect<Project, PairBuilderWorkspaceError>;
    /** A thread in the workspace project, owned by the person, that starts with the prompt. */
    readonly startSession: (
      input: PairBuilderSessionStart,
    ) => Effect.Effect<PairBuilderStartedSession, PairBuilderSessionNotStartedError>;
  }
>()("t3/pairBuilder/PairBuilderHost") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectService.ProjectService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const members = yield* PairBuilderMembers.PairBuilderMembers;
  const random = yield* SecureRandom.SecureRandom;
  const path = yield* Path.Path;
  const newId = random.uuidV4().pipe(Effect.orDie);

  const hostConfig = Effect.suspend(() =>
    config.pairBuilder === undefined
      ? Effect.die("Pair Builder host mode is off.")
      : Effect.succeed(config.pairBuilder),
  );

  // Idempotent by workspace root, so a restart finds the project it created.
  const bootstrapWorkspaceProject: PairBuilderHost["Service"]["bootstrapWorkspaceProject"] =
    Effect.gen(function* () {
      const host = yield* hostConfig;
      const { project } = yield* projects
        .bootstrap({
          commandId: CommandId.make(yield* newId),
          projectId: ProjectId.make(yield* newId),
          title: host.workspaceTitle ?? (path.basename(host.workspaceRoot) || "workspace"),
          workspaceRoot: host.workspaceRoot,
          createWorkspaceRootIfMissing: true,
        })
        .pipe(
          Effect.mapError(
            (cause) => new PairBuilderWorkspaceError({ workspaceRoot: host.workspaceRoot, cause }),
          ),
        );
      return project;
    }).pipe(Effect.withSpan("PairBuilderHost.bootstrapWorkspaceProject"));

  const startSession: PairBuilderHost["Service"]["startSession"] = Effect.fn(
    "PairBuilderHost.startSession",
  )(
    function* (input) {
      const member = yield* members.resolve(input.person).pipe(
        Effect.catchTags({
          PairBuilderMemberRemovedError: (cause) =>
            Effect.fail(new PairBuilderSessionNotStartedError({ reason: "member-removed", cause })),
          PairBuilderMemberWriteError: (cause) =>
            Effect.fail(
              new PairBuilderSessionNotStartedError({ reason: "member-unavailable", cause }),
            ),
        }),
      );
      const project = yield* bootstrapWorkspaceProject.pipe(
        Effect.mapError(
          (cause) =>
            new PairBuilderSessionNotStartedError({ reason: "workspace-unavailable", cause }),
        ),
      );
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(
          (cause) => new PairBuilderSessionNotStartedError({ reason: "launch-failed", cause }),
        ),
      );
      const projectSettings = resolveProjectSettings(settings, project.id, project).settings;
      // The composer's rule: the default model, or its fallback while the default is out of usage.
      const modelSelection = resolveNewThreadModelSelection({
        defaultSelection: projectSettings.defaultModelSelection,
        fallbackSelection: projectSettings.fallbackModelSelection,
        providers: yield* providers.getProviders,
        settings: projectSettings,
        projectId: project.id,
        now: DateTime.toEpochMillis(yield* DateTime.now),
      }).selection;
      if (modelSelection === null) {
        return yield* new PairBuilderSessionNotStartedError({ reason: "no-default-model" });
      }
      const commandId = CommandId.make(yield* newId);
      return yield* launches
        .launch({
          commandId,
          projectId: project.id,
          ...(input.title === undefined
            ? { title: truncate(input.prompt.replace(/\s+/gu, " ")), generateTitle: true }
            : { title: input.title }),
          modelSelection,
          runtimeMode: projectSettings.defaultRuntimeMode,
          // T3 has no read-only ask mode; plan keeps an "ask" from editing files.
          interactionMode: input.mode === "agent" || input.mode === undefined ? "default" : "plan",
          workspaceStrategy: { type: "root" },
          initialMessage: { text: input.prompt, attachments: [] },
          createdBy: "user",
          creationSource: "server",
          actorId: member.id,
        })
        .pipe(
          Effect.map((launched): PairBuilderStartedSession => ({
            threadId: launched.threadId,
            promptAccepted: true,
          })),
          Effect.catchTags({
            // The thread exists once its first message fails; the Builder can still open it.
            ThreadLaunchError: (error) =>
              error.operation === "dispatch-message" && error.threadId !== undefined
                ? Effect.logWarning("Pair Builder session started without its prompt.", {
                    commandId,
                    threadId: error.threadId,
                  }).pipe(
                    Effect.as<PairBuilderStartedSession>({
                      threadId: error.threadId,
                      promptAccepted: false,
                      error: "The workspace could not send the prompt.",
                    }),
                  )
                : Effect.fail(
                    new PairBuilderSessionNotStartedError({
                      reason: "launch-failed",
                      cause: error,
                    }),
                  ),
            ThreadManagementProviderInstanceDisabledError: (cause) =>
              Effect.fail(
                new PairBuilderSessionNotStartedError({ reason: "launch-failed", cause }),
              ),
          }),
        );
    },
    Effect.tapError((error) =>
      Effect.logWarning("Pair Builder session not started.", {
        reason: error.reason,
        cause: error.cause,
      }),
    ),
  );

  return PairBuilderHost.of({ bootstrapWorkspaceProject, startSession });
});

export const layer = Layer.effect(PairBuilderHost, make);
