import {
  type AuthMcpClientAccess,
  ChiefOfStaffError,
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type MemberId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ChiefOfStaffHost } from "./ChiefOfStaffHost.ts";
import * as ChiefOfStaffMemory from "./ChiefOfStaffMemory.ts";
import { invalidateHomeThreads } from "./homeThreads.ts";
import {
  type ChiefOfStaffCaller,
  effectiveToolAccess,
  homeInstructions,
} from "./chiefOfStaffProtocol.ts";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE_MEMORY_IMPORT = "@AGENTS.md\n";

/** Runtime modes have no read-only level; voice's read-only access becomes "ask first". */
const runtimeModeFor = (access: AuthMcpClientAccess): RuntimeMode =>
  access === "read-only" ? "approval-required" : access;

export class ChiefOfStaffHome extends Context.Service<
  ChiefOfStaffHome,
  {
    readonly ensureHome: (
      caller: ChiefOfStaffCaller,
    ) => Effect.Effect<
      { readonly threadId: ThreadId; readonly projectId: ProjectId },
      ChiefOfStaffError
    >;
    readonly homeThreadId: (memberId: MemberId) => Effect.Effect<ThreadId | undefined>;
  }
>()("t3/chiefOfStaff/ChiefOfStaffHome") {}

const failed = (message: string) => () =>
  new ChiefOfStaffError({ reason: "start-failed", message });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const host = yield* ChiefOfStaffHost;
  const memory = yield* ChiefOfStaffMemory.ChiefOfStaffMemory;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const random = yield* SecureRandom.SecureRandom;
  // One lock per member, so two calls for the same member never create two threads.
  const locks = yield* SynchronizedRef.make(new Map<MemberId, Semaphore.Semaphore>());

  const homeKey = (memberId: MemberId) => `home:${memberId}`;
  const homeDir = (memberId: MemberId) =>
    path.join(config.stateDir, "chief-of-staff", "home", memberId);

  const semaphoreFor = (memberId: MemberId) =>
    SynchronizedRef.modify(locks, (current) => {
      const existing = current.get(memberId);
      if (existing !== undefined) return [existing, current] as const;
      const created = Semaphore.makeUnsafe(1);
      const next = new Map(current);
      next.set(memberId, created);
      return [created, next] as const;
    });

  const readSettings = settings.getSettings.pipe(
    Effect.mapError(failed("Could not read settings.")),
  );

  /** Empty `homeProviderInstanceId` prefers the server's default for new threads. */
  const resolveModelSelection = Effect.fn("ChiefOfStaffHome.resolveModelSelection")(
    function* (current: { readonly homeProviderInstanceId: string; readonly homeModel: string }) {
      const serverSettings = yield* readSettings;
      const serverDefault = serverSettings.defaultModelSelection;
      const instanceId = current.homeProviderInstanceId
        ? ProviderInstanceId.make(current.homeProviderInstanceId)
        : (serverDefault?.instanceId ?? ProviderInstanceId.make(CODEX));
      const configuredModel =
        current.homeModel || (serverDefault?.instanceId === instanceId ? serverDefault.model : "");
      if (configuredModel) return { instanceId, model: configuredModel } satisfies ModelSelection;
      const instance = yield* instances.getInstance(instanceId);
      if (instance !== undefined) {
        const snapshot = yield* instance.snapshot.getSnapshot;
        const models = snapshot.models.filter((model) => model.isLegacy !== true);
        const preferred = models.find((model) => model.isDefault) ?? models[0];
        if (preferred !== undefined) {
          return { instanceId, model: preferred.slug } satisfies ModelSelection;
        }
        return {
          instanceId,
          model: DEFAULT_MODEL_BY_PROVIDER[snapshot.driver] ?? DEFAULT_MODEL,
        } satisfies ModelSelection;
      }
      return { instanceId, model: DEFAULT_MODEL } satisfies ModelSelection;
    },
  );

  const writePersona = Effect.fn("ChiefOfStaffHome.writePersona")(function* (directory: string) {
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.writeFileString(path.join(directory, "AGENTS.md"), `${homeInstructions()}\n`);
    yield* fileSystem.writeFileString(path.join(directory, "CLAUDE.md"), CLAUDE_MEMORY_IMPORT);
  });

  const ensureHomeUnlocked = Effect.fn("ChiefOfStaffHome.ensureHomeUnlocked")(function* (
    caller: ChiefOfStaffCaller,
  ) {
    const key = homeKey(caller.memberId);
    const directory = homeDir(caller.memberId);
    // The persona is regenerated on every ensure, so a new prompt reaches an existing home.
    yield* writePersona(directory).pipe(
      Effect.mapError(failed("Could not create Chief of staff's folder.")),
    );
    // Write MEMORY.md on turn one, so the home thread has it before its first reply.
    yield* memory.render(caller.memberId).pipe(Effect.ignore);
    const stored = yield* host.loadThreadId(key);
    if (stored !== undefined) {
      const threadId = ThreadId.make(stored);
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(failed("Could not read Chief of staff's chat thread.")));
      if (shell !== null && shell.deletedAt === null) {
        if (shell.archivedAt !== null) {
          yield* threads
            .dispatch({
              type: "thread.unarchive",
              commandId: CommandId.make(yield* random.uuidV4()),
              threadId,
              actorId: caller.memberId,
            })
            .pipe(Effect.mapError(failed("Could not restore Chief of staff's chat thread.")));
        }
        return { threadId, projectId: shell.projectId };
      }
    }

    const current = yield* readSettings;
    const selection = yield* resolveModelSelection(current.chiefOfStaff);
    const runtimeMode = runtimeModeFor(
      effectiveToolAccess(current.chiefOfStaff.toolAccess, caller.scopes),
    );
    const project = yield* projects
      .bootstrap({
        commandId: CommandId.make(yield* random.uuidV4()),
        projectId: ProjectId.make(yield* random.uuidV4()),
        title: "Chief of staff",
        workspaceRoot: directory,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: selection,
      })
      .pipe(Effect.mapError(failed("Could not create Chief of staff's project.")));
    const launched = yield* launches
      .launch({
        commandId: CommandId.make(yield* random.uuidV4()),
        projectId: project.project.id,
        title: "Chief of staff",
        modelSelection: selection,
        runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy: { type: "root" },
        createdBy: "system",
        creationSource: "server",
        ownerId: caller.memberId,
      })
      .pipe(Effect.mapError(failed("Could not create Chief of staff's chat thread.")));
    yield* host.saveThreadId(key, launched.threadId);
    // Drop the cached home-thread map, so the audit hook and the tools see this
    // brand-new home thread on its first call instead of waiting out the TTL.
    invalidateHomeThreads();
    return { threadId: launched.threadId, projectId: project.project.id };
  });

  return ChiefOfStaffHome.of({
    ensureHome: Effect.fn("ChiefOfStaffHome.ensureHome")(function* (caller) {
      const lock = yield* semaphoreFor(caller.memberId);
      return yield* lock.withPermits(1)(ensureHomeUnlocked(caller));
    }),
    homeThreadId: Effect.fn("ChiefOfStaffHome.homeThreadId")(function* (memberId) {
      const stored = yield* host.loadThreadId(homeKey(memberId));
      return stored === undefined ? undefined : ThreadId.make(stored);
    }),
  });
});

export const layer = Layer.effect(ChiefOfStaffHome, make);
