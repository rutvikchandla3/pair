import {
  type AuthMcpClientAccess,
  type CloudMoveCheckInput,
  type CloudMoveCheckResult,
  type CloudMoveLaunchInput,
  type CloudMoveLaunchResult,
  type CloudStagingKey,
  CommandId,
  isRuntimeModeAbove,
  type MemberId,
  type Project,
  repositoryGroupingKeyOf,
} from "@t3tools/contracts";
import { pickCloudMoveModel } from "@t3tools/shared/sandboxCredentials";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as CloudPreparation from "../sandbox/lifecycle/CloudPreparation.ts";
import * as ServerSettings from "../serverSettings.ts";

export class CloudMoveLaunchError extends Schema.TaggedError<CloudMoveLaunchError>()(
  "CloudMoveLaunchError",
  {
    reason: Schema.Literals(["unknown-project", "refused", "branch-not-pushed", "failed"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** The link session a move arrives on: its member launches, at most at its access. */
export interface CloudMoveSession {
  readonly memberId: MemberId;
  readonly sessionId: string;
  readonly label: string;
  readonly access: Exclude<AuthMcpClientAccess, "read-only">;
}

const NO_ACCOUNT_MESSAGE = "Add an account on Pair Cloud, on your row in Settings → Team.";

/**
 * Pair Cloud's half of Continue in cloud: which project and account a move would use, and the
 * launch that claims the staged seed and export under the move's key.
 */
export class CloudMoveLaunch extends Context.Service<
  CloudMoveLaunch,
  {
    readonly check: (input: {
      readonly memberId: MemberId;
      readonly input: CloudMoveCheckInput;
    }) => Effect.Effect<CloudMoveCheckResult, CloudMoveLaunchError>;
    readonly launch: (input: {
      readonly key: CloudStagingKey;
      readonly session: CloudMoveSession;
      readonly input: CloudMoveLaunchInput;
    }) => Effect.Effect<CloudMoveLaunchResult, CloudMoveLaunchError>;
  }
>()("t3/cloudMove/CloudMoveLaunch") {}

const failed = (message: string) => (cause: unknown) =>
  new CloudMoveLaunchError({ reason: "failed", message, cause });

const originKeyOf = (project: Pick<Project, "repositoryIdentity">) =>
  project.repositoryIdentity == null
    ? null
    : repositoryGroupingKeyOf(project.repositoryIdentity).toLowerCase();

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;

  const findProject = Effect.fn("CloudMoveLaunch.findProject")(function* (
    input: CloudMoveCheckInput,
  ) {
    const originKey = input.originKey.toLowerCase();
    const live = (yield* projects.snapshot.pipe(
      Effect.mapError(failed("Couldn't read Pair Cloud's projects.")),
    )).projects.filter(
      (project) =>
        !project.archivedAt && project.deletedAt === null && originKeyOf(project) === originKey,
    );
    const named = live.find((project) => project.id === input.projectId);
    if (named !== undefined) return named;
    const oldest = live.reduce<Project | null>(
      (found, project) => (found === null || project.createdAt < found.createdAt ? project : found),
      null,
    );
    if (oldest !== null) return oldest;
    return yield* new CloudMoveLaunchError({
      reason: "unknown-project",
      message: `Add ${input.originKey.replace(/^[^/]*\//, "")} to Pair Cloud first.`,
    });
  });

  const check: CloudMoveLaunch["Service"]["check"] = Effect.fn("CloudMoveLaunch.check")(function* ({
    memberId,
    input,
  }) {
    const project = yield* findProject(input);
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(failed("Couldn't read Pair Cloud's settings.")),
    );
    const modelSelection = pickCloudMoveModel({
      settings,
      providers: yield* providers.getProviders,
      memberId,
      preferred: input.model,
    });
    if (modelSelection === null) {
      return yield* new CloudMoveLaunchError({ reason: "refused", message: NO_ACCOUNT_MESSAGE });
    }
    yield* launches
      .checkCloudLaunch({ projectId: project.id, instanceId: modelSelection.instanceId })
      .pipe(
        Effect.mapError(
          (error) => new CloudMoveLaunchError({ reason: "refused", message: error.message }),
        ),
      );
    return { projectId: project.id, modelSelection };
  });

  const launch: CloudMoveLaunch["Service"]["launch"] = Effect.fn("CloudMoveLaunch.launch")(
    function* ({ key, session, input }) {
      const launched = yield* launches
        .launch({
          // A resent launch replays through the command's receipt.
          commandId: CommandId.make(`cloud-move:${key}`),
          projectId: input.projectId,
          title: input.title,
          modelSelection: input.modelSelection,
          interactionMode: input.interactionMode,
          runtimeMode: isRuntimeModeAbove(input.runtimeMode, session.access)
            ? session.access
            : input.runtimeMode,
          workspaceStrategy: {
            type: "cloud",
            baseRef: input.baseRef,
            ...(input.branch === undefined ? {} : { branch: input.branch }),
            ...(input.existingBranch === undefined ? {} : { existingBranch: true }),
            ...(input.seeded ? { seedRef: key } : {}),
          },
          contextExportRef: key,
          initialMessage: { text: input.message, attachments: [] },
          createdBy: input.createdBy,
          creationSource: input.creationSource,
          actorId: session.memberId,
          ownerId: session.memberId,
          linkOrigin: {
            sessionId: session.sessionId,
            label: session.label,
            access: session.access,
          },
        })
        .pipe(
          Effect.mapError((error) => {
            if (error._tag !== "ThreadLaunchError") {
              return new CloudMoveLaunchError({ reason: "refused", message: error.message });
            }
            const refusal = error.cause;
            if (!CloudPreparation.isCloudLaunchRefusal(refusal)) {
              return failed("Pair Cloud couldn't start the thread.")(error);
            }
            return new CloudMoveLaunchError({
              reason:
                refusal._tag === "CloudLaunchError" && refusal.reason === "branch-not-pushed"
                  ? "branch-not-pushed"
                  : "refused",
              message: refusal.message,
            });
          }),
        );
      return { threadId: launched.threadId };
    },
  );

  return CloudMoveLaunch.of({ check, launch });
});

export const layer = Layer.effect(CloudMoveLaunch, make);
