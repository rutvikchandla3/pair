import {
  ADMIN_SCOPES,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentAuthorizationError,
  MEMBER_SCOPES,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSetupError,
  SecretProviderId,
  ThreadId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  WS_METHODS,
  WsRpcGroup,
  clientRpcRequiredScopes,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("keeps triage, which seeds an agent that reads logs and the database, and Continue locally, which makes a worktree and a thread, behind operate scope", () => {
    for (const method of [WS_METHODS.serverPrepareTriage, WS_METHODS.threadMoveToLocal]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [WS_METHODS.terminalObserve, WS_METHODS.subscribeTerminalMetadata]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalClose,
      WS_METHODS.previewStopLocalServer,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("keeps team management behind access:write while the member bundle reads and edits itself", () => {
    for (const method of [
      WS_METHODS.teamInvite,
      WS_METHODS.teamSignInLink,
      WS_METHODS.teamUpdate,
      WS_METHODS.teamSetRole,
      WS_METHODS.teamRemove,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthAccessWriteScope);
      expect(MEMBER_SCOPES).not.toContain(requiredScopeForRpcMethod(method));
    }
    for (const method of [
      WS_METHODS.teamSubscribe,
      WS_METHODS.teamUpdateSelf,
      WS_METHODS.teamUsage,
      WS_METHODS.teamGitHubLinkStart,
      WS_METHODS.teamGitHubLinkWait,
      WS_METHODS.teamGitHubLinkCancel,
      WS_METHODS.teamGitHubDisconnect,
      WS_METHODS.teamGitHubTokenSet,
      WS_METHODS.teamGitHubTokenClear,
      WS_METHODS.presenceSubscribe,
      WS_METHODS.presenceReport,
      WS_METHODS.pushRegister,
      WS_METHODS.pushUnregister,
    ]) {
      expect(MEMBER_SCOPES).toContain(requiredScopeForRpcMethod(method));
    }
    for (const method of [WS_METHODS.teamGitHubTokenSet, WS_METHODS.teamGitHubTokenClear]) {
      expect(clientRpcRequiredScopes(method, {})).toEqual([requiredScopeForRpcMethod(method)]);
    }
  });

  it("lets members read Cloud's overview, hold a viewer lease and move a thread to cloud, and keeps the driver check, which boots a machine, and team image activation admin only", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.sandboxCheckDriver)).toBe(AuthSettingsWriteScope);
    expect(MEMBER_SCOPES).not.toContain(requiredScopeForRpcMethod(WS_METHODS.sandboxCheckDriver));
    expect(ADMIN_SCOPES).toContain(requiredScopeForRpcMethod(WS_METHODS.sandboxCheckDriver));
    expect(clientRpcRequiredScopes(WS_METHODS.sandboxCheckDriver, { driverId: "local" })).toEqual([
      AuthSettingsWriteScope,
    ]);
    expect(requiredScopeForRpcMethod(WS_METHODS.teamImageActivateBuild)).toBe(
      AuthSettingsWriteScope,
    );
    expect(MEMBER_SCOPES).not.toContain(
      requiredScopeForRpcMethod(WS_METHODS.teamImageActivateBuild),
    );
    expect(
      clientRpcRequiredScopes(WS_METHODS.teamImageActivateBuild, { imageBuildId: "tib_x" }),
    ).toEqual([AuthSettingsWriteScope]);
    expect(MEMBER_SCOPES).toContain(requiredScopeForRpcMethod(WS_METHODS.sandboxOverview));
    expect(MEMBER_SCOPES).toContain(requiredScopeForRpcMethod(WS_METHODS.sandboxViewing));
    expect(requiredScopeForRpcMethod(WS_METHODS.threadMovePreview)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.threadMoveToCloud)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(MEMBER_SCOPES).toContain(AuthOrchestrationReadScope);
    expect(MEMBER_SCOPES).toContain(AuthOrchestrationOperateScope);
    expect(clientRpcRequiredScopes(WS_METHODS.threadMoveToCloud, {})).toEqual([
      AuthOrchestrationOperateScope,
    ]);
  });

  it("keeps draining, which holds every member's new cloud turns, admin only", () => {
    expect(MEMBER_SCOPES).not.toContain(AuthEnvironmentMaintainScope);
    expect(ADMIN_SCOPES).toContain(AuthEnvironmentMaintainScope);
    for (const method of [WS_METHODS.serverDrain, WS_METHODS.serverCancelDrain]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthEnvironmentMaintainScope);
      expect(clientRpcRequiredScopes(method, {})).toEqual([AuthEnvironmentMaintainScope]);
    }
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      yield* client[WS_METHODS.serverUpdateSettings]({
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: ProviderInstanceId.make("codex_work"),
          instance: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              {
                name: "OPENAI_API_KEY",
                sensitive: true,
                value: {
                  provider: SecretProviderId.make("personal"),
                  reference: "op://Private/OpenAI/credential",
                },
              },
            ],
          },
        },
      });
      expect(handled).toBe(2);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let a settings grant create or remove providers or secret providers", () =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled = true;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: {},
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { secretProviders: { [SecretProviderId.make("personal")]: null } },
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});

describe("provider sign-in on a member's own account", () => {
  const tested = [
    WS_METHODS.providerAuthStart,
    WS_METHODS.providerAuthRespond,
    WS_METHODS.providerAuthComplete,
    WS_METHODS.providerAuthCancel,
    WS_METHODS.providerAuthLogout,
    WS_METHODS.providerAuthSubscribe,
  ] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );
  const bobsClaude = ProviderInstanceId.make("claudeAgent-bob-1a2b");
  const teamClaude = ProviderInstanceId.make("claudeAgent");
  const idle = (instanceId: ProviderInstanceId) => ({
    instanceId,
    phase: "idle" as const,
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
  });

  it.effect.each([
    { who: "a member on their own account", scopes: MEMBER_SCOPES, target: bobsClaude, ok: true },
    { who: "a member on another's account", scopes: MEMBER_SCOPES, target: teamClaude, ok: false },
    {
      who: "a read-only session on its member's account",
      scopes: [AuthOrchestrationReadScope],
      target: bobsClaude,
      ok: false,
    },
    { who: "an admin on any account", scopes: ADMIN_SCOPES, target: teamClaude, ok: true },
  ])("lets $who sign in and out: $ok", ({ scopes, target, ok }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const handle = (method: string, instanceId: ProviderInstanceId) =>
        Effect.sync(() => {
          handled.push(method);
          return idle(instanceId);
        });
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.providerAuthStart, (input) =>
              handle("start", input.instanceId),
            ),
            group.toLayerHandler(WS_METHODS.providerAuthRespond, (input) =>
              handle("respond", input.instanceId),
            ),
            group.toLayerHandler(WS_METHODS.providerAuthComplete, (input) =>
              handle("complete", input.instanceId),
            ),
            group.toLayerHandler(WS_METHODS.providerAuthCancel, (input) =>
              handle("cancel", input.instanceId),
            ),
            group.toLayerHandler(WS_METHODS.providerAuthLogout, (input) =>
              handle("logout", input.instanceId),
            ),
            group.toLayerHandler(WS_METHODS.providerAuthSubscribe, (input) =>
              Stream.fromEffect(handle("subscribe", input.instanceId)),
            ),
            RpcAuthorization.layer(scopes, (instanceId) =>
              Effect.succeed(instanceId === bobsClaude),
            ),
          ),
        ),
      );
      const instanceId = target;
      const flowId = "flow";
      const calls: ReadonlyArray<
        Effect.Effect<unknown, EnvironmentAuthorizationError | ProviderSetupError>
      > = [
        client[WS_METHODS.providerAuthStart]({ instanceId }),
        client[WS_METHODS.providerAuthRespond]({
          instanceId,
          flowId,
          interactionId: "interaction",
          response: { type: "browser", action: "accept" },
        }),
        client[WS_METHODS.providerAuthComplete]({
          instanceId,
          flowId,
          callbackUrl: "http://127.0.0.1/?code=c",
        }),
        client[WS_METHODS.providerAuthCancel]({ instanceId, flowId }),
        client[WS_METHODS.providerAuthLogout]({ instanceId }),
        Stream.runCollect(client[WS_METHODS.providerAuthSubscribe]({ instanceId })),
      ];
      for (const call of calls) {
        const result = yield* Effect.result(call);
        if (ok) expect(result._tag).toBe("Success");
        else {
          expect(result).toMatchObject({
            failure: { _tag: "EnvironmentAuthorizationError" },
          });
        }
      }
      expect(handled).toEqual(
        ok ? ["start", "respond", "complete", "cancel", "logout", "subscribe"] : [],
      );
    }).pipe(Effect.scoped),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

describe("thread context authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.gitRunStackedAction> =>
        tag !== WS_METHODS.gitRunStackedAction,
    ),
  );

  it.effect.each(["commit", "create_pr", "commit_push_pr"] as const)(
    "%s needs thread read permission only when generating a PR from a thread",
    (action) =>
      Effect.gen(function* () {
        const handled: string[] = [];
        const handler = group.toLayerHandler(WS_METHODS.gitRunStackedAction, ({ actionId }) =>
          Stream.fromEffect(Effect.sync(() => handled.push(actionId))).pipe(Stream.drain),
        );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(handler, RpcAuthorization.layer([AuthSourceControlWriteScope])),
          ),
        );
        const input = { actionId: "without-thread", cwd: "/repo", action };
        const withThread = { ...input, actionId: "with-thread", threadId: ThreadId.make("thread") };
        yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](input));
        if (action === "create_pr" || action === "commit_push_pr") {
          expect(
            yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread)).pipe(
              Effect.flip,
            ),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
          expect(handled).toEqual(["without-thread"]);
        } else {
          yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread));
          expect(handled).toEqual(["without-thread", "with-thread"]);
        }
        const reader = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handler,
              RpcAuthorization.layer([AuthSourceControlWriteScope, AuthOrchestrationReadScope]),
            ),
          ),
        );
        yield* Stream.runDrain(
          reader[WS_METHODS.gitRunStackedAction]({ ...withThread, actionId: "allowed" }),
        );
        expect(handled.at(-1)).toBe("allowed");
      }).pipe(Effect.scoped),
  );
});

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);
