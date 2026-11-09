import { assert, it } from "@effect/vitest";
import {
  type CloudMoveLaunchInput,
  CloudStagingKey,
  MemberId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as CloudPreparation from "../sandbox/lifecycle/CloudPreparation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CloudMoveLaunch from "./CloudMoveLaunch.ts";

const KEY = CloudStagingKey.make(`mv_${"b".repeat(32)}`);
const MEMBER = MemberId.make("member:kim");
const PROJECT = ProjectId.make("project-cloud");
const session: CloudMoveLaunch.CloudMoveSession = {
  memberId: MEMBER,
  sessionId: "session-1",
  label: "Kim's MacBook Pro",
  access: "auto",
};

const launchInput: CloudMoveLaunchInput = {
  projectId: PROJECT,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  title: "Fix the login form",
  baseRef: "main",
  branch: "feature",
  seeded: true,
  runtimeMode: "full-access",
  interactionMode: "plan",
  message: "Continue from where the conversation left off.",
  createdBy: "user",
  creationSource: "web",
};

const project = (id: string, originKey: string, createdAt: string, archived = false) =>
  ({
    id: ProjectId.make(id),
    repositoryIdentity: {
      canonicalKey: originKey,
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: "x" },
    },
    createdAt,
    archivedAt: archived ? "2026-11-01T00:00:00.000Z" : null,
    deletedAt: null,
  }) as never;

interface World {
  launchFailure: unknown;
  readonly launches: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly checks: Array<{ readonly projectId: ProjectId; readonly instanceId: string }>;
}

const layerFor = (world: World) =>
  CloudMoveLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Effect.suspend(() => {
              world.launches.push(input);
              if (world.launchFailure !== null) {
                return Effect.fail(
                  new ThreadLaunch.ThreadLaunchError({
                    operation: "resolve-project",
                    commandId: input.commandId,
                    projectId: input.projectId,
                    cause: world.launchFailure,
                  }),
                );
              }
              return Effect.succeed({ threadId: ThreadId.make("thread-cloud") } as never);
            }),
          checkCloudLaunch: (input) =>
            Effect.sync(() => {
              world.checks.push(input);
              return {} as never;
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          snapshot: Effect.succeed({
            projects: [
              project("project-archived", "github.com/acme/app", "2026-01-01T00:00:00.000Z", true),
              project("project-newer", "github.com/acme/app", "2026-03-01T00:00:00.000Z"),
              project("project-cloud", "github.com/Acme/App", "2026-02-01T00:00:00.000Z"),
              project("project-other", "github.com/acme/other", "2026-01-01T00:00:00.000Z"),
            ],
            updatedAt: "2026-11-01T00:00:00.000Z",
          } as never),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            {
              instanceId: ProviderInstanceId.make("claude_team"),
              driver: ProviderDriverKind.make("claudeAgent"),
              displayName: "Claude",
              enabled: true,
              installed: true,
              models: [{ slug: "opus", isDefault: true }],
            },
          ] as never),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          // A setup token, so the instance works in cloud.
          getSettings: Effect.succeed({
            providerInstances: {
              claude_team: {
                driver: ProviderDriverKind.make("claudeAgent"),
                environment: [
                  {
                    name: "CLAUDE_CODE_OAUTH_TOKEN",
                    value: "",
                    sensitive: true,
                    valueRedacted: true,
                  },
                ],
              },
            },
          } as never),
        }),
      ),
    ),
  );

const makeWorld = (): World => ({ launchFailure: null, launches: [], checks: [] });

it.effect("launches a move as the link's member at most at the link's access", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const moves = yield* CloudMoveLaunch.CloudMoveLaunch;

    const result = yield* moves.launch({ key: KEY, session, input: launchInput });

    assert.deepEqual(result, { threadId: ThreadId.make("thread-cloud") });
    const launch = world.launches[0]!;
    assert.deepEqual(
      {
        commandId: launch.commandId,
        runtimeMode: launch.runtimeMode,
        interactionMode: launch.interactionMode,
        workspaceStrategy: launch.workspaceStrategy,
        contextExportRef: launch.contextExportRef,
        initialMessage: launch.initialMessage,
        actorId: launch.actorId,
        ownerId: launch.ownerId,
        linkOrigin: launch.linkOrigin,
      },
      {
        commandId: `cloud-move:${KEY}`,
        runtimeMode: "auto",
        interactionMode: "plan",
        workspaceStrategy: { type: "cloud", baseRef: "main", branch: "feature", seedRef: KEY },
        contextExportRef: KEY,
        initialMessage: { text: launchInput.message, attachments: [] },
        actorId: MEMBER,
        ownerId: MEMBER,
        linkOrigin: { sessionId: "session-1", label: "Kim's MacBook Pro", access: "auto" },
      } as never,
    );

    yield* moves.launch({
      key: KEY,
      session,
      input: {
        ...launchInput,
        seeded: false,
        existingBranch: true,
        runtimeMode: "approval-required",
      },
    });
    assert.deepEqual(
      [world.launches[1]!.workspaceStrategy, world.launches[1]!.runtimeMode],
      [
        { type: "cloud", baseRef: "main", branch: "feature", existingBranch: true },
        "approval-required",
      ],
    );
  }).pipe(Effect.provide(layerFor(world)));
});

it.effect("maps branch-not-pushed and other refusals", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const moves = yield* CloudMoveLaunch.CloudMoveLaunch;
    const refusal = (reason: CloudPreparation.CloudLaunchError["reason"]) =>
      new CloudPreparation.CloudLaunchError({
        projectId: PROJECT,
        reason,
        branch: "feature",
        remote: "github.com/acme/app",
      });
    const outcome = (cause: unknown) => {
      world.launchFailure = cause;
      return moves.launch({ key: KEY, session, input: launchInput }).pipe(
        Effect.flip,
        Effect.map(({ reason, message }) => ({ reason, message })),
      );
    };

    assert.deepEqual(yield* outcome(refusal("branch-not-pushed")), {
      reason: "branch-not-pushed",
      message: refusal("branch-not-pushed").message,
    });
    assert.deepEqual(yield* outcome(refusal("seed-on-base")), {
      reason: "refused",
      message: refusal("seed-on-base").message,
    });
    assert.deepEqual(yield* outcome(new Error("disk full")), {
      reason: "failed",
      message: "Pair Cloud couldn't start the thread.",
    });
  }).pipe(Effect.provide(layerFor(world)));
});

it.effect("check finds the project by origin key and refuses one Pair Cloud lacks", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const moves = yield* CloudMoveLaunch.CloudMoveLaunch;
    const check = (originKey: string, projectId?: string) =>
      moves.check({
        memberId: MEMBER,
        input: {
          originKey,
          model: { driver: ProviderDriverKind.make("claudeAgent"), model: "sonnet" },
          ...(projectId === undefined ? {} : { projectId: ProjectId.make(projectId) }),
        },
      });

    // The oldest live project with the key, case-insensitively; an archived one never.
    assert.equal((yield* check("github.com/acme/app")).projectId, "project-cloud");
    // A named project wins when its key matches, and is ignored when it doesn't.
    assert.equal((yield* check("github.com/acme/app", "project-newer")).projectId, "project-newer");
    assert.equal((yield* check("github.com/acme/app", "project-other")).projectId, "project-cloud");
    // The local model is gone here, so the driver's default.
    assert.deepEqual((yield* check("github.com/acme/app")).modelSelection, {
      instanceId: ProviderInstanceId.make("claude_team"),
      model: "opus",
    });
    assert.deepEqual(world.checks[0], {
      projectId: PROJECT,
      instanceId: ProviderInstanceId.make("claude_team"),
    });

    const missing = yield* check("github.com/acme/elsewhere").pipe(Effect.flip);
    assert.deepEqual(
      { reason: missing.reason, message: missing.message },
      { reason: "unknown-project", message: "Add acme/elsewhere to Pair Cloud first." },
    );
  }).pipe(Effect.provide(layerFor(world)));
});
