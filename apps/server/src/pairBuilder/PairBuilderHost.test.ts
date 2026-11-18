import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  MemberId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PairBuilderMembers from "../team/PairBuilderMembers.ts";
import { layerHostConfig } from "./PairBuilder.testkit.ts";
import * as PairBuilderHost from "./PairBuilderHost.ts";

const PROJECT_ID = ProjectId.make("workspace-project");
const THREAD_ID = ThreadId.make("thread-1");
const ADA = MemberId.make("member-ada");
const DEFAULT_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet",
};

const project = {
  id: PROJECT_ID,
  title: "Workspace",
  workspaceRoot: "/projects/challenge",
  repositoryIdentity: null,
  faviconPath: null,
  scripts: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  deletedAt: null,
  defaultModelSelection: null,
};

const launchError = (operation: ThreadLaunch.ThreadLaunchError["operation"]) =>
  new ThreadLaunch.ThreadLaunchError({
    operation,
    commandId: CommandId.make("command"),
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
    cause: "launch failed",
  });

const makeHost = (options: {
  readonly workspaceTitle?: string;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly removed?: boolean;
  readonly launch?: (
    input: ThreadLaunch.ThreadLaunchRequest,
  ) => Effect.Effect<ThreadLaunch.ThreadLaunchResult, ThreadLaunch.ThreadLaunchError>;
}) => {
  const launches: Array<ThreadLaunch.ThreadLaunchRequest> = [];
  const bootstraps: Array<ProjectService.ProjectBootstrapInput> = [];
  const people: Array<{ readonly id: string; readonly name: string }> = [];
  const layer = PairBuilderHost.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Path.layer,
        layerHostConfig({
          ingressToken: Redacted.make("ingress"),
          sandboxId: "sandbox-1",
          workspaceRoot: "/projects/challenge",
          workspaceTitle: options.workspaceTitle,
          events: undefined,
        }),
        Layer.mock(ProjectService.ProjectService)({
          bootstrap: (input) =>
            Effect.sync(() => {
              bootstraps.push(input);
              return { project, created: false };
            }),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) => {
            launches.push(input);
            return (
              options.launch?.(input) ??
              Effect.succeed({ threadId: THREAD_ID, resumed: false } as never)
            );
          },
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            defaultModelSelection:
              options.defaultModelSelection === undefined
                ? DEFAULT_MODEL
                : options.defaultModelSelection,
          }),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(PairBuilderMembers.PairBuilderMembers)({
          resolve: (person) =>
            Effect.suspend(() => {
              people.push(person);
              return options.removed === true
                ? Effect.fail(
                    new PairBuilderMembers.PairBuilderMemberRemovedError({ memberId: ADA }),
                  )
                : Effect.succeed({
                    id: ADA,
                    name: person.name,
                    role: "member" as const,
                    gitName: null,
                    gitEmail: null,
                    isOwner: false,
                    createdAt: "2026-11-01T00:00:00.000Z",
                    updatedAt: null,
                    removedAt: null,
                    pairBuilderUserId: person.id,
                  });
            }),
        }),
      ),
    ),
  );
  return { layer, launches, bootstraps, people };
};

const ada = { id: "u-1", name: "Ada" };

describe("PairBuilderHost", () => {
  it.effect("bootstraps the workspace project titled after the task, else its folder", () =>
    Effect.gen(function* () {
      for (const [workspaceTitle, expected] of [
        ["PAIR-12: Fix login", "PAIR-12: Fix login"],
        [undefined, "challenge"],
      ] as const) {
        const host = makeHost(workspaceTitle === undefined ? {} : { workspaceTitle });
        const workspace = yield* PairBuilderHost.PairBuilderHost.pipe(
          Effect.flatMap((service) => service.bootstrapWorkspaceProject),
          Effect.provide(host.layer),
        );
        expect(workspace.id).toBe(PROJECT_ID);
        expect(host.bootstraps).toMatchObject([
          {
            title: expected,
            workspaceRoot: "/projects/challenge",
            createWorkspaceRootIfMissing: true,
          },
        ]);
      }
    }),
  );

  it.effect("launches a thread for the person with the prompt, title and mode", () =>
    Effect.gen(function* () {
      const host = makeHost({});
      const startSession = (input: PairBuilderHost.PairBuilderSessionStart) =>
        PairBuilderHost.PairBuilderHost.pipe(
          Effect.flatMap((service) => service.startSession(input)),
          Effect.provide(host.layer),
        );

      expect(
        yield* startSession({
          prompt: "Fix the login bug",
          title: "Login",
          mode: "plan",
          person: ada,
        }),
      ).toEqual({ threadId: THREAD_ID, promptAccepted: true });
      yield* startSession({ prompt: "Make the\nbuild green", mode: "ask", person: ada });
      yield* startSession({ prompt: "Ship it", mode: "agent", person: ada });

      expect(host.people).toEqual([ada, ada, ada]);
      expect(host.launches).toMatchObject([
        {
          projectId: PROJECT_ID,
          title: "Login",
          modelSelection: DEFAULT_MODEL,
          runtimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
          interactionMode: "plan",
          workspaceStrategy: { type: "root" },
          initialMessage: { text: "Fix the login bug", attachments: [] },
          createdBy: "user",
          creationSource: "server",
          actorId: ADA,
        },
        {
          title: "Make the build green",
          generateTitle: true,
          interactionMode: "plan",
          initialMessage: { text: "Make the\nbuild green" },
        },
        { interactionMode: "default" },
      ]);
      expect(host.launches[0]).not.toHaveProperty("generateTitle");
    }),
  );

  it.effect("reports a session whose prompt failed apart from one that never started", () =>
    Effect.gen(function* () {
      const start = (options: Parameters<typeof makeHost>[0]) =>
        PairBuilderHost.PairBuilderHost.pipe(
          Effect.flatMap((service) => service.startSession({ prompt: "Fix it", person: ada })),
          Effect.provide(makeHost(options).layer),
        );

      expect(
        yield* start({ launch: () => Effect.fail(launchError("dispatch-message")) }),
      ).toMatchObject({ threadId: THREAD_ID, promptAccepted: false });
      const reasons = yield* Effect.forEach(
        [
          { launch: () => Effect.fail(launchError("create-thread")) },
          { defaultModelSelection: null },
          { removed: true },
        ],
        (options) =>
          start(options).pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          ),
      );
      expect(reasons).toEqual(["launch-failed", "no-default-model", "member-removed"]);
    }),
  );
});
