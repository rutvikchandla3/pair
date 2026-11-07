import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  ProviderCredentialError,
  ProviderSessionHostUnavailableError,
} from "@t3tools/provider-core/server/errors";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspaceHosts from "../workspaceHost/WorkspaceHosts.ts";
import {
  sandboxEnvironmentFor,
  type SandboxEnvironmentFor,
} from "../sandbox/providers/SandboxProviderHome.ts";
import * as DocumentText from "./DocumentText.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";

/** A session cwd's machine: its spawner and agent scope, and the env its provider starts on. */
export const sessionProcessesFor = (
  workspaceHosts: WorkspaceHosts.WorkspaceHosts["Service"],
  sandboxEnvironment: SandboxEnvironmentFor,
): NonNullable<ProviderHost.ProviderHost["Service"]["sessionProcesses"]> =>
  Effect.fn("ProviderHost.sessionProcesses")(function (cwd) {
    return workspaceHosts.forPath(cwd).pipe(
      Effect.mapError(
        (error) => new ProviderSessionHostUnavailableError({ sandboxId: error.sandboxId ?? "" }),
      ),
      Effect.flatMap((host) =>
        Effect.gen(function* () {
          const info = yield* host.info;
          if (host.kind === "local") {
            return {
              spawner: host.spawner,
              agentScope: host.agentScope,
              environment: info.environment,
            };
          }
          // An ACP agent's helpers carry no thread: git answers for the sandbox's owner thread.
          const environment = yield* sandboxEnvironment(host, undefined).pipe(
            Effect.mapError(
              (error) =>
                new ProviderSessionHostUnavailableError({
                  sandboxId: error.sandboxId,
                  detail: error.message,
                }),
            ),
          );
          return {
            spawner: host.spawner,
            agentScope: host.agentScope,
            environment,
            sandboxExecutablePath: info.executablePath,
          };
        }),
      ),
    );
  });

export const layer = Layer.effect(
  ProviderHost.ProviderHost,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const digest = yield* Digest.Digest;
    const fileSystem = yield* FileSystem.FileSystem;
    const workspaceHosts = yield* WorkspaceHosts.WorkspaceHosts;
    const sandboxEnvironment = yield* sandboxEnvironmentFor;
    return ProviderHost.ProviderHost.of({
      paths: {
        cwd: config.cwd,
        baseDir: config.baseDir,
        stateDir: config.stateDir,
        providerStatusCacheDir: config.providerStatusCacheDir,
        attachmentsDir: config.attachmentsDir,
      },
      settings: {
        get: serverSettings.getSettings,
        withSnapshot: serverSettings.withSettingsSnapshot,
        changes: serverSettings.streamChanges,
        subscribe: serverSettings.subscribeChanges,
      },
      shouldRunBackgroundWork: backgroundPolicy.shouldRunScopeWork,
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
      // DocumentText owns the path-resolution span.
      resolveExtractedTextPath: Effect.fnUntraced(
        function* (path) {
          return yield* DocumentText.resolveExtractedTextPath(path);
        },
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      ),
      sessionProcesses: sessionProcessesFor(workspaceHosts, sandboxEnvironment),
      credentials: Effect.fn("ProviderHost.credentials")(function (namespace, bindingId) {
        return ProviderCredentialStore.make(namespace, bindingId).pipe(
          Effect.map((store) => ({
            binding: store.binding,
            get: store.get.pipe(
              Effect.mapError((cause) => new ProviderCredentialError({ operation: "get", cause })),
            ),
            set: (credentials: Uint8Array) =>
              store
                .set(credentials)
                .pipe(
                  Effect.mapError(
                    (cause) => new ProviderCredentialError({ operation: "set", cause }),
                  ),
                ),
            remove: store.remove.pipe(
              Effect.mapError(
                (cause) => new ProviderCredentialError({ operation: "remove", cause }),
              ),
            ),
          })),
          Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
          Effect.provideService(Digest.Digest, digest),
        );
      }),
    });
  }),
);
