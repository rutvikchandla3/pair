import {
  OrchestratorMcpFailure,
  PositiveInt,
  ProjectId,
  TeamImageBuild,
  TeamImageError,
  TeamImageRecipe,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as McpSchema from "effect/ai/McpSchema";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as TeamImageAuthority from "../../../sandbox/image/TeamImageAuthority.ts";
import * as TeamImageService from "../../../sandbox/image/TeamImageService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  // `not-admin` reaches the agent typed, with a reason it can repeat to the person.
  failure: Schema.Union([OrchestratorMcpFailure, TeamImageError]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    TeamImageService.TeamImageService,
    TeamImageAuthority.TeamImageAuthority,
    ProjectService.ProjectService,
    ThreadManagementService.ThreadManagementService,
  ],
};

const BuildSummary = Schema.Struct({
  build: TeamImageBuild.fields.number,
  status: TeamImageBuild.fields.status,
  phase: TeamImageBuild.fields.phase,
  recipeRevision: TeamImageBuild.fields.recipeRevision,
  requestedBy: TeamImageBuild.fields.requestedBy,
  failure: TeamImageBuild.fields.failure,
  manifest: TeamImageBuild.fields.manifest,
});

const TeamImageReadTool = Tool.make("t3_team_image_read", {
  ...shared,
  description:
    "Read the team image new cloud sessions boot from: its recipe (secret names only), the active build and the last 10 builds.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    recipe: Schema.NullOr(
      Schema.Struct({
        revision: PositiveInt,
        projects: Schema.Array(Schema.Struct({ id: ProjectId, name: Schema.String })),
        buildEnv: TeamImageRecipe.fields.buildEnv,
        buildSecretNames: Schema.Array(Schema.String),
        install: Schema.String,
        savedBy: TeamImageBuild.fields.requestedBy,
      }),
    ),
    activeBuild: Schema.NullOr(PositiveInt),
    builds: Schema.Array(BuildSummary),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutTeamImages);

const TeamImageBuildLogTool = Tool.make("t3_team_image_build_log", {
  ...shared,
  description:
    "Read a team image build's redacted log: the last `tail` lines (default 100), or `tail` lines from line `from`.",
  parameters: Schema.Struct({
    build: PositiveInt,
    tail: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(500))),
    from: Schema.optionalKey(PositiveInt),
  }),
  success: Schema.Struct({
    build: PositiveInt,
    status: TeamImageBuild.fields.status,
    totalLines: Schema.Number,
    from: Schema.Number,
    text: Schema.String,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutTeamImages);

const adminOnly = "Needs a turn written only by admins.";

const TeamImageRecipeUpdateTool = Tool.make("t3_team_image_recipe_update", {
  ...shared,
  description: `Replace the team image's install script, based on the revision you read (null if none); projects, env and secrets stay. ${adminOnly}`,
  parameters: Schema.Struct({
    install: TeamImageRecipe.fields.install,
    baseRevision: Schema.NullOr(PositiveInt),
  }),
  success: Schema.Struct({ revision: PositiveInt }),
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutTeamImages);

const TeamImageBuildStartTool = Tool.make("t3_team_image_build_start", {
  ...shared,
  description: `Build a saved team image recipe revision. An admin activates it after. ${adminOnly}`,
  parameters: Schema.Struct({ recipeRevision: PositiveInt }),
  success: Schema.Struct({ build: PositiveInt, note: Schema.String }),
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutTeamImages);

const TeamImageBuildCancelTool = Tool.make("t3_team_image_build_cancel", {
  ...shared,
  description: `Cancel a running team image build. ${adminOnly}`,
  parameters: Schema.Struct({ build: PositiveInt }),
  success: Schema.Struct({ build: PositiveInt, status: TeamImageBuild.fields.status }),
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutTeamImages);

const TeamImageProposeTool = Tool.make("t3_team_image_propose", {
  ...shared,
  description:
    "Propose a replacement install script for the team image, for an admin to review; nothing changes until they save it. Use it when you could not change the image yourself or were asked to suggest a change. Start from the script t3_team_image_read returned.",
  parameters: Schema.Struct({
    install: TeamImageRecipe.fields.install,
    reason: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  }),
  success: Schema.Struct({ note: Schema.String }),
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutTeamImages);

export const SandboxImageToolkit = Toolkit.make(
  TeamImageReadTool,
  TeamImageBuildLogTool,
  TeamImageRecipeUpdateTool,
  TeamImageBuildStartTool,
  TeamImageBuildCancelTool,
  TeamImageProposeTool,
);
