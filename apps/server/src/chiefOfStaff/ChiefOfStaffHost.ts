import {
  ChiefOfStaffError,
  CodexSettings,
  isListedThreadLineage,
  type MemberId,
  type OrchestrationV2ThreadShell,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as CodexClient from "effect-codex-app-server/client";

import { ServerConfig } from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { makeCodexAppServerSpawnCommand } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { codexAppServerEnvironment } from "../provider/CodexProvider.ts";
import { codexAppServerArgs, resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadAccess from "../team/ThreadAccess.ts";
import * as WorkspaceHosts from "../workspaceHost/WorkspaceHosts.ts";
import { formatStatus, type StatusThread } from "./chiefOfStaffProtocol.ts";

export class VoiceAppServerError extends Schema.TaggedError<VoiceAppServerError>()(
  "VoiceAppServerError",
  { message: Schema.String },
) {}

/** One `codex app-server` child. Closing the scope it was opened in kills it. */
export interface VoiceAppServer {
  readonly request: (
    method: string,
    params?: unknown,
  ) => Effect.Effect<unknown, VoiceAppServerError>;
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void, VoiceAppServerError>;
  /** Single consumer. */
  readonly notifications: Stream.Stream<{ readonly method: string; readonly params?: unknown }>;
  /** Completes when the process exits. */
  readonly exited: Effect.Effect<void>;
}

/** What a voice session needs from the rest of the server; tests swap it whole. */
export class ChiefOfStaffHost extends Context.Service<
  ChiefOfStaffHost,
  {
    /** An empty directory the backing thread runs in. */
    readonly workspaceDir: Effect.Effect<string, ChiefOfStaffError>;
    readonly openAppServer: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly realtimeBaseUrl: string;
    }) => Effect.Effect<VoiceAppServer, ChiefOfStaffError, Scope.Scope>;
    readonly loadThreadId: (key: string) => Effect.Effect<string | undefined>;
    readonly saveThreadId: (key: string, threadId: string) => Effect.Effect<void>;
    readonly statusSnapshot: (memberId: MemberId) => Effect.Effect<string>;
    /** Fires after committed changes; may fire for changes that leave the status as it was. */
    readonly statusChanges: Stream.Stream<void>;
  }
>()("t3/chiefOfStaff/ChiefOfStaffHost") {}

const CODEX = ProviderDriverKind.make("codex");
const ThreadIds = Schema.Record(Schema.String, Schema.String);
const ThreadIdsJson = Schema.fromJsonString(ThreadIds);
const decodeThreadIds = Schema.decodeEffect(ThreadIdsJson);
const encodeThreadIds = Schema.encodeEffect(ThreadIdsJson);
const decodeCodexSettings = Schema.decodeEffect(CodexSettings);
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

const statusOf = (shell: OrchestrationV2ThreadShell): StatusThread["needs"] =>
  shell.pendingRuntimeRequest === null
    ? undefined
    : shell.pendingRuntimeRequest.kind === "user_input"
      ? "answer"
      : "approval";

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettings.ServerSettingsService;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const hosts = yield* WorkspaceHosts.WorkspaceHosts;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStoreV2;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const access = yield* ThreadAccess.optional;
  const home = yield* HostProcess.HomeDirectory;
  const directory = path.join(config.stateDir, "chief-of-staff");
  const threadIdsFile = path.join(directory, "threads.json");
  const workspace = path.join(directory, "workspace");
  const fileLock = yield* Semaphore.make(1);

  const failed = (message: string) => () =>
    new ChiefOfStaffError({ reason: "app-server-failed", message });

  const readThreadIds = fileSystem.readFileString(threadIdsFile).pipe(
    Effect.flatMap(decodeThreadIds),
    Effect.orElseSucceed((): Record<string, string> => ({})),
  );

  const openAppServer = Effect.fn("ChiefOfStaffHost.openAppServer")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly realtimeBaseUrl: string;
  }) {
    const instance = yield* instances.getInstance(input.instanceId);
    if (instance === undefined || !instance.enabled) {
      return yield* new ChiefOfStaffError({
        reason: "provider-not-found",
        message: `Chief of staff's provider "${input.instanceId}" is not set up or is turned off. Pick a Codex provider in Settings.`,
      });
    }
    if (instance.driverKind !== CODEX) {
      return yield* new ChiefOfStaffError({
        reason: "unsupported-provider",
        message: "Chief of staff talks through Codex only. Pick a Codex provider in Settings.",
      });
    }
    const snapshot = yield* instance.snapshot.getSnapshot;
    if (snapshot.auth.status === "unauthenticated") {
      return yield* new ChiefOfStaffError({
        reason: "signed-out",
        message: "Sign in to Codex with ChatGPT to talk to Chief of staff.",
      });
    }
    const entry = deriveProviderInstanceConfigMap(
      yield* settings.getSettings.pipe(Effect.mapError(failed("Could not read settings."))),
    )[input.instanceId];
    const codexSettings = yield* decodeCodexSettings(entry?.config ?? {}).pipe(
      Effect.mapError(failed("The Codex provider's settings are invalid.")),
    );
    const homeLayout = yield* resolveCodexHomeLayout(codexSettings).pipe(
      Effect.provideService(Path.Path, path),
    );
    const host = hosts.local;
    const environment = yield* mergeProviderInstanceEnvironment(
      entry?.environment,
      (yield* host.info).environment,
    );
    const env = {
      ...codexAppServerEnvironment(environment),
      ...(homeLayout.effectiveHomePath ? { CODEX_HOME: homeLayout.effectiveHomePath } : {}),
    };
    // A JSON string is a TOML basic string, which `-c` parses.
    const overrides = input.realtimeBaseUrl
      ? [
          "-c",
          `openai_base_url=${yield* encodeJsonString(input.realtimeBaseUrl).pipe(
            Effect.mapError(failed("The realtime base URL is invalid.")),
          )}`,
        ]
      : [];
    const command = yield* makeCodexAppServerSpawnCommand({
      command: expandHomePath(codexSettings.binaryPath, home) || "codex",
      args: [
        ...codexAppServerArgs(resolveCodexLaunchArgs(codexSettings.launchArgs, environment)),
        ...overrides,
      ],
      env,
      facts: yield* host.info,
    }).pipe(
      Effect.provideService(AgentScope, host.agentScope),
      Effect.mapError(failed("Could not prepare the Codex command.")),
    );
    const handle = yield* host.spawner
      .spawn(command)
      .pipe(
        Effect.mapError(failed("Could not start Codex. Check the Codex provider in Settings.")),
      );
    // No protocol logger: what the user says is not written to disk.
    const context = yield* Layer.build(CodexClient.layerChildProcess(handle));
    const client = Context.get(context, CodexClient.CodexAppServerClient);
    const toError = (error: { readonly message: string }) =>
      new VoiceAppServerError({ message: error.message });
    return {
      request: (method, params) =>
        client.raw.request(method, params).pipe(Effect.mapError(toError)),
      notify: (method, params) => client.raw.notify(method, params).pipe(Effect.mapError(toError)),
      notifications: client.raw.notifications,
      exited: client.awaitTermination.pipe(Effect.ignore),
    } satisfies VoiceAppServer;
  });

  const readStatus = Effect.fn("ChiefOfStaffHost.readStatus")(function* (memberId: MemberId) {
    const snapshot = yield* threads.getShellSnapshot({ location: "active", unsettledOnly: true });
    const visible = snapshot.threads.filter(
      (shell) =>
        isListedThreadLineage(shell.lineage) &&
        (access === undefined || access.allowsThread(memberId, shell)),
    );
    const projectIds = [...new Set(visible.map((shell) => shell.projectId))];
    const titles = new Map(
      (projectIds.length === 0 ? [] : yield* projects.listShells({ projectIds })).map((project) => [
        project.id,
        project.title,
      ]),
    );
    return formatStatus(
      visible.map((shell) => ({
        title: shell.title,
        project: titles.get(shell.projectId),
        status: shell.status,
        needs: statusOf(shell),
        updatedAt: DateTime.toEpochMillis(shell.updatedAt),
      })),
    );
  });

  return ChiefOfStaffHost.of({
    workspaceDir: fileSystem
      .makeDirectory(workspace, { recursive: true })
      .pipe(
        Effect.as(workspace),
        Effect.mapError(failed("Could not create Chief of staff's folder.")),
      ),
    openAppServer,
    loadThreadId: Effect.fn("ChiefOfStaffHost.loadThreadId")(function* (key) {
      return (yield* readThreadIds)[key];
    }),
    saveThreadId: Effect.fn("ChiefOfStaffHost.saveThreadId")(function* (key, threadId) {
      yield* Effect.gen(function* () {
        const ids = { ...(yield* readThreadIds), [key]: threadId };
        yield* fileSystem.makeDirectory(directory, { recursive: true });
        yield* fileSystem.writeFileString(threadIdsFile, yield* encodeThreadIds(ids));
      }).pipe(fileLock.withPermits(1), Effect.ignore);
    }),
    statusSnapshot: Effect.fn("ChiefOfStaffHost.statusSnapshot")(function* (memberId) {
      return yield* readStatus(memberId).pipe(
        Effect.orElseSucceed(() => "Current T3 Code thread status is unavailable; use the tools."),
      );
    }),
    statusChanges: Stream.unwrap(
      events.latestApplicationSequence.pipe(
        Effect.map((afterSequence) => events.streamApplicationEvents({ afterSequence })),
      ),
    ).pipe(Stream.as(undefined), Stream.ignore),
  });
});

export const layer = Layer.effect(ChiefOfStaffHost, make);
