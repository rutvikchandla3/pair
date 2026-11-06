import {
  type MemberId,
  ProviderSetupError,
  type ChatGptReconnectProfile,
  type ChatGptTransferredProfile,
  type ProviderAuthRespondInput,
  type ProviderAuthStartInput,
  type ProviderAuthState,
  type ProviderInstanceId,
  type ProviderSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Function from "effect/Function";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TeamState from "../team/TeamState.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import type { ProviderAuthController } from "@t3tools/provider-core/server/auth";

export type { ProviderAuthController } from "@t3tools/provider-core/server/auth";

interface ProviderAuthTarget {
  readonly instanceId: ProviderInstanceId;
}

export class ProviderAuthService extends Context.Service<
  ProviderAuthService,
  {
    readonly reconnectProfile: (
      input: ProviderAuthTarget & { methodId: string },
    ) => Effect.Effect<ChatGptReconnectProfile | null, ProviderSetupError>;
    readonly importProfile: (
      input: ProviderAuthTarget & { profile: ChatGptTransferredProfile },
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly start: (
      input: ProviderAuthStartInput,
      ownerSessionId: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly complete: (
      input: ProviderAuthTarget & { readonly flowId: string; readonly callbackUrl: string },
      ownerSessionId: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly respond: (
      input: ProviderAuthRespondInput,
      ownerSessionId: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly cancel: (
      input: ProviderAuthTarget & { readonly flowId: string },
      ownerSessionId: string,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    readonly logout: (
      input: ProviderAuthTarget,
    ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
    /** Signs out where the driver supports it, and always stops the instance's sessions. */
    readonly revoke: (input: ProviderAuthTarget) => Effect.Effect<void, ProviderSetupError>;
    readonly subscribe: (
      input: ProviderAuthTarget,
      ownerSessionId: string,
    ) => Stream.Stream<ProviderAuthState, ProviderSetupError>;
    /** `actorId` is who sent the prompt; on a team server it decides who may sign out. */
    readonly tryHandlePromptCommand: (
      input: ProviderAuthTarget & {
        readonly text: string;
        readonly hasAttachments: boolean;
        readonly actorId?: MemberId;
      },
    ) => Effect.Effect<boolean, ProviderSetupError>;
  }
>()("t3/provider/ProviderAuthService") {}

export const makeProviderAuthService = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const teamState = yield* TeamState.TeamState;
  const credentialChanges = yield* Semaphore.make(1);

  const getController = Effect.fn("ProviderAuthService.getController")(function* (
    instanceId: ProviderInstanceId,
    operation: string,
  ) {
    const instance = yield* registry.getInstance(instanceId);
    if (!instance?.auth) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: instance
          ? "This provider does not support sign-in in Pair."
          : "This provider instance is no longer available.",
      });
    }
    return instance.auth;
  });

  // Invalidate credentials using session bindings; model selection may already point to another provider.
  const stopSessions = Effect.fn("ProviderAuthService.stopSessions")(function* (
    instanceId: ProviderInstanceId,
    binding: ProviderAuthController["credentialBinding"],
  ) {
    const failure = (detail: string) =>
      new ProviderSetupError({ instanceId, operation: "stopSessions", detail });
    const affectedIds = new Set([
      instanceId,
      ...(binding === undefined
        ? []
        : (yield* registry.listInstances)
            .filter(
              (instance) =>
                instance.auth?.credentialBinding?.key === binding.key &&
                instance.auth.credentialBinding.owner === binding.owner,
            )
            .map((instance) => instance.instanceId)),
    ]);
    const threadIds = yield* projections
      .getRecoveryThreadIds("runtime")
      .pipe(
        Effect.mapError(() => failure("Could not read the provider's active sessions. Try again.")),
      );
    const released = new Set<ProviderSessionId>();
    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        projections.getThreadRecords(threadId, ["providerSessions"]).pipe(
          Effect.flatMap((projection) =>
            Effect.forEach(
              projection.providerSessions.filter(
                (session) =>
                  affectedIds.has(session.providerInstanceId) &&
                  session.status !== "stopped" &&
                  session.status !== "error" &&
                  !released.has(session.id),
              ),
              (session) =>
                Effect.gen(function* () {
                  if (session.providerInstanceId !== instanceId) {
                    const current = yield* registry.getInstance(session.providerInstanceId);
                    if (
                      !binding ||
                      current?.auth?.credentialBinding?.key !== binding.key ||
                      current.auth.credentialBinding.owner !== binding.owner
                    )
                      return;
                  }
                  yield* providerSessions
                    .release({
                      providerSessionId: session.id,
                      reason: "manual_shutdown",
                      detail: "Provider sign-in changed.",
                    })
                    .pipe(Effect.tap(() => Effect.sync(() => released.add(session.id))));
                }),
              { discard: true },
            ),
          ),
          Effect.mapError(() =>
            failure("Could not stop all sessions for this provider. Try again."),
          ),
        ),
      { discard: true },
    );
    if (binding) {
      yield* Effect.forEach(
        (yield* registry.listInstances).filter(
          (instance) =>
            instance.instanceId !== instanceId &&
            affectedIds.has(instance.instanceId) &&
            instance.auth?.credentialBinding?.key === binding.key &&
            instance.auth.credentialBinding.owner === binding.owner,
        ),
        (instance) => instance.auth?.invalidate ?? Effect.void,
        { discard: true },
      );
    }
  });

  const checkSharedBinding = Effect.fnUntraced(function* (
    instanceId: ProviderInstanceId,
    operation: "start" | "logout",
    auth: ProviderAuthController,
  ) {
    const binding = auth.credentialBinding;
    if (!binding) return;
    const instances = yield* registry.listInstances;
    for (const instance of instances) {
      if (
        instance.instanceId !== instanceId &&
        instance.auth?.credentialBinding?.key === binding.key &&
        instance.auth.credentialBinding.owner === binding.owner &&
        instance.auth.isChangingCredentials &&
        (yield* instance.auth.isChangingCredentials)
      ) {
        return yield* new ProviderSetupError({
          instanceId,
          operation,
          detail:
            "Another provider instance is changing this shared sign-in. Finish or cancel it first.",
        });
      }
    }
  });

  // On a team, a member's account is theirs to sign out, and the team's logins are the admins'.
  const ensureMaySignOut = Effect.fnUntraced(function* (
    instanceId: ProviderInstanceId,
    actorId: MemberId | undefined,
  ) {
    if (!(yield* teamState.isTeamMode)) return;
    const failure = (detail: string) =>
      new ProviderSetupError({ instanceId, operation: "logout", detail });
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() => failure("Could not read this provider's owner. Try again.")),
    );
    const members = yield* Ref.get(teamState.members);
    const instance = settings.providerInstances[instanceId];
    const owner =
      instance?.ownerMemberId === undefined ? undefined : members.get(instance.ownerMemberId);
    if (owner !== undefined && owner.removedAt === null) {
      if (owner.id === actorId) return;
      return yield* failure(
        `Only ${owner.name} can sign ${instance?.displayName ?? instanceId} out.`,
      );
    }
    const actor = actorId === undefined ? undefined : members.get(actorId);
    if (actor?.role === "admin" && actor.removedAt === null) return;
    return yield* failure("Only an admin can sign out the team login.");
  });

  return ProviderAuthService.of({
    reconnectProfile: Effect.fnUntraced(function* (input) {
      const auth = yield* getController(input.instanceId, "export");
      if (!auth.reconnectProfile)
        return yield* new ProviderSetupError({
          instanceId: input.instanceId,
          operation: "export",
          detail: "This provider does not support ChatGPT profile transfer.",
        });
      return yield* auth.reconnectProfile(input.methodId);
    }),
    importProfile: Effect.fn("ProviderAuthService.importProfile")(function (input) {
      return credentialChanges.withPermit(
        Effect.gen(function* () {
          const auth = yield* getController(input.instanceId, "import");
          yield* checkSharedBinding(input.instanceId, "start", auth);
          if (!auth.importProfile)
            return yield* new ProviderSetupError({
              instanceId: input.instanceId,
              operation: "import",
              detail: "This provider does not support ChatGPT profile transfer.",
            });
          return yield* auth.importProfile(
            input.profile,
            stopSessions(input.instanceId, auth.credentialBinding),
          );
        }),
      );
    }),
    start: Effect.fn("ProviderAuthService.start")(function* (input, ownerSessionId) {
      return yield* credentialChanges.withPermit(
        Effect.gen(function* () {
          const auth = yield* getController(input.instanceId, "start");
          yield* checkSharedBinding(input.instanceId, "start", auth);
          return yield* auth.start(
            ownerSessionId,
            stopSessions(input.instanceId, auth.credentialBinding),
            input.methodId,
            input.returnUrl,
            input.callbackMode,
          );
        }),
      );
    }),
    respond: Effect.fn("ProviderAuthService.respond")(function* (input, ownerSessionId) {
      const auth = yield* getController(input.instanceId, "respond");
      if (!auth.respond) {
        return yield* new ProviderSetupError({
          instanceId: input.instanceId,
          operation: "respond",
          detail: "This provider does not accept this sign-in interaction.",
        });
      }
      return yield* auth.respond(ownerSessionId, input);
    }),
    complete: Effect.fn("ProviderAuthService.complete")(function* (input, ownerSessionId) {
      const auth = yield* getController(input.instanceId, "complete");
      return yield* auth.complete(ownerSessionId, input);
    }),
    cancel: Effect.fn("ProviderAuthService.cancel")(function* (input, ownerSessionId) {
      const auth = yield* getController(input.instanceId, "cancel");
      return yield* auth.cancel(ownerSessionId, input.flowId);
    }),
    logout: Effect.fn("ProviderAuthService.logout")(function* (input) {
      return yield* credentialChanges.withPermit(
        Effect.gen(function* () {
          const auth = yield* getController(input.instanceId, "logout");
          yield* checkSharedBinding(input.instanceId, "logout", auth);
          return yield* auth.logout(stopSessions(input.instanceId, auth.credentialBinding));
        }),
      );
    }),
    revoke: Effect.fn("ProviderAuthService.revoke")(function* (input) {
      return yield* credentialChanges.withPermit(
        Effect.gen(function* () {
          const auth = (yield* registry.getInstance(input.instanceId))?.auth;
          if (auth === undefined) return yield* stopSessions(input.instanceId, undefined);
          yield* checkSharedBinding(input.instanceId, "logout", auth);
          yield* auth.logout(stopSessions(input.instanceId, auth.credentialBinding));
        }),
      );
    }),
    subscribe: Function.flow(
      Effect.fn("ProviderAuthService.subscribe")(function* (input, ownerSessionId) {
        const changes = yield* registry.subscribeChanges;
        const initial = yield* getController(input.instanceId, "subscribe");
        return Stream.concat(
          Stream.succeed(initial),
          Stream.fromSubscription(changes).pipe(
            Stream.mapEffect(() => getController(input.instanceId, "subscribe")),
          ),
        ).pipe(
          Stream.changesWith((previous, next) => previous === next),
          Stream.switchMap((auth) => auth.subscribe(ownerSessionId)),
        );
      }),
      Stream.unwrap,
    ),
    tryHandlePromptCommand: Effect.fn("ProviderAuthService.tryHandlePromptCommand")(
      function* (input) {
        const instance = yield* registry.getInstance(input.instanceId);
        // Guarded for every driver: a provider CLI may sign out on its own `/logout`.
        const isLogoutPrompt =
          instance?.auth?.isLogoutPrompt?.(input.text, input.hasAttachments) ??
          (!input.hasAttachments && input.text.trim() === "/logout");
        if (!isLogoutPrompt) return false;
        yield* ensureMaySignOut(input.instanceId, input.actorId);
        if (!instance?.auth?.isLogoutPrompt) return false;
        return yield* credentialChanges.withPermit(
          Effect.gen(function* () {
            const auth = yield* getController(input.instanceId, "logout");
            if (!auth.isLogoutPrompt?.(input.text, input.hasAttachments)) return false;
            yield* checkSharedBinding(input.instanceId, "logout", auth);
            yield* auth.logout(stopSessions(input.instanceId, auth.credentialBinding));
            return true;
          }),
        );
      },
    ),
  });
});

export const layer = Layer.effect(ProviderAuthService, makeProviderAuthService);
