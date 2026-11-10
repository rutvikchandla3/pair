import {
  CommandId,
  isProviderDriverKind,
  type MemberId,
  type ProjectId,
  type SandboxId,
  TeamImageBuildFailure,
  type TeamImageBuildId,
  type TeamImageBuildPhase,
  TeamImageError,
  type TeamImageManifest,
  type TeamImageRecipe,
  type TeamImageRequester,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { parseGitRemoteRepository, redactUrlCredentials } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";

import packageJson from "../../../package.json" with { type: "json" };
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import type { TeamImageEffectV2 } from "../../orchestration-v2/EffectOutbox.ts";
import { OrchestrationEffectExecutionError } from "../../orchestration-v2/EffectWorker.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { requireSettingsSecret } from "../../secrets/settingsSecretValue.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { MemberGitHub } from "../../team/MemberGitHub.ts";
import { SANDBOX_ROOT } from "../../workspaceHost/WorkspaceHost.ts";
import { WorkspaceHosts } from "../../workspaceHost/WorkspaceHosts.ts";
import {
  type BaseImageInfo,
  ComputeDriverError,
  sandboxBackendName,
  sandboxTags,
} from "../compute/ComputeDriver.ts";
import {
  ComputeDriverNotConfiguredError,
  ComputeDriverRegistry,
} from "../compute/ComputeDriverRegistry.ts";
import { GitHubAppInstallationTokens } from "../credentials/GitHubAppInstallationTokens.ts";
import { clonePathFor } from "../lifecycle/CloudPreparation.ts";
import { SandboxBootstrapSource } from "../lifecycle/SandboxBootstrapSource.ts";
import { RunnerHub } from "../runnerHub/RunnerHub.ts";
import * as LiveTeamImageBuild from "./LiveTeamImageBuild.ts";
import type { TeamImageBuildRecord, TeamImageCommand } from "./TeamImageCommands.ts";
import * as TeamImageBuildLog from "./TeamImageBuildLog.ts";
import { TeamImageEffects } from "./TeamImageEffects.ts";
import { TeamImageService } from "./TeamImageService.ts";
import * as TeamImageStore from "./TeamImageStore.ts";
import {
  isRedactableSecret,
  secretFragments,
  TEAM_IMAGE_BUILD_OUTPUT,
  TEAM_IMAGE_LEAK_MARKER,
  TEAM_IMAGE_NO_SUDO_DETAIL,
  TEAM_IMAGE_NO_SUDO_EXIT_CODE,
  TEAM_IMAGE_ROOT,
  TeamImageBuildOutput,
  teamImageBuildProgram,
} from "./teamImageBuildProgram.ts";

const GENERATION = 1;
const UNREACHABLE = "Pair Cloud could not reach the build machine's driver.";

/** Ends the program with this failure; anything else unexpected ends it as a lost machine. */
class BuildStopped extends Schema.TaggedError<BuildStopped>()("BuildStopped", {
  phase: TeamImageBuildFailure.fields.phase,
  detail: Schema.String,
  exitCode: Schema.optionalKey(Schema.Int),
}) {}

const isBuildStopped = Schema.is(BuildStopped);
// A refusal or a missing driver will not change on a retry.
const isPermanent = Schema.is(
  Schema.Union([TeamImageError, ComputeDriverNotConfiguredError, ComputeDriverError]),
);
const decodeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(TeamImageBuildOutput));

interface Leak {
  readonly name: string;
  readonly path: string;
}

const requesterMember = (requester: TeamImageRequester): MemberId | undefined =>
  requester.kind === "member" ? requester.memberId : requester.authorIds[0];

/** The URL to clone without credentials: https for a hosted remote, else the remote as set. */
const cloneUrlFor = (url: string) => {
  const repository = parseGitRemoteRepository(url);
  return repository === null
    ? redactUrlCredentials(url)
    : `https://${repository.host}/${repository.path}`;
};

const make = Effect.gen(function* () {
  const service = yield* TeamImageService;
  const store = yield* TeamImageStore.TeamImageStore;
  const liveBuild = yield* LiveTeamImageBuild.LiveTeamImageBuild;
  const buildLog = yield* TeamImageBuildLog.TeamImageBuildLog;
  const registry = yield* ComputeDriverRegistry;
  const settings = yield* ServerSettingsService;
  const bootstraps = yield* SandboxBootstrapSource;
  const hub = yield* RunnerHub;
  const hosts = yield* WorkspaceHosts;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const tokens = yield* GitHubAppInstallationTokens;
  const memberGitHub = yield* MemberGitHub;
  const secrets = yield* SecretResolver.SecretResolver;
  const projects = yield* ProjectService;
  const git = yield* GitWorkflow.GitWorkflowService;
  const scope = yield* Effect.scope;

  const programs = new Set<TeamImageBuildId>();
  // The create's base for the manifest; a restart fails a running build, so memory is enough.
  const baseImages = new Map<TeamImageBuildId, BaseImageInfo | null>();

  const dispatch = (command: TeamImageCommand) =>
    service.dispatch(command).pipe(Effect.asVoid, Effect.uninterruptible);
  const commandId = (step: string, imageBuildId: TeamImageBuildId) =>
    CommandId.make(`server:team-image.build.${step}:${imageBuildId}`);

  const readRecord = (imageBuildId: TeamImageBuildId) =>
    store.build(imageBuildId).pipe(Effect.map(Option.getOrNull));

  const backendName = Effect.fnUntraced(function* (sandboxId: SandboxId) {
    return sandboxBackendName(yield* environment.getEnvironmentId, sandboxId, GENERATION);
  });

  const failBuild = (
    imageBuildId: TeamImageBuildId,
    step: string,
    failure: TeamImageBuildFailure,
  ) =>
    dispatch({
      type: "team-image.build.fail",
      commandId: commandId(`fail:${step}`, imageBuildId),
      imageBuildId,
      failure,
    });

  const launch = Effect.fn("TeamImageEffects.launch")(function* (imageBuildId: TeamImageBuildId) {
    const record = yield* readRecord(imageBuildId);
    // A fast runner can say hello before `create` returns, so a running build may still need it.
    if (
      record === null ||
      !(
        record.build.status === "queued" ||
        (record.build.status === "running" && record.machine.driverRef === null)
      )
    ) {
      return;
    }
    const { build, machine } = record;
    const driver = yield* registry.get(build.driverId);
    const installId = yield* environment.getEnvironmentId;
    const config = (yield* settings.getSettings).sandbox?.drivers.find(
      (entry) => entry.id === build.driverId,
    );
    const bootstrap = yield* bootstraps.forGeneration({
      sandboxId: machine.sandboxId,
      generation: GENERATION,
      driverId: build.driverId,
    });
    const created = yield* driver.create({
      name: sandboxBackendName(installId, machine.sandboxId, GENERATION),
      sandboxId: machine.sandboxId,
      generation: GENERATION,
      image: { type: "base" },
      size: config?.size ?? "default",
      tags: sandboxTags({
        installId,
        sandboxId: machine.sandboxId,
        generation: GENERATION,
        driverId: build.driverId,
      }),
      bootstrap,
    });
    baseImages.set(imageBuildId, created.baseImage);
    yield* dispatch({
      type: "team-image.build.launched",
      commandId: commandId("launched", imageBuildId),
      imageBuildId,
      driverRef: created.driverRef,
    });
  });

  const cloneToken = Effect.fnUntraced(function* (
    sandboxId: SandboxId,
    requester: TeamImageRequester,
    url: string,
  ) {
    const repository = parseGitRemoteRepository(url);
    if (repository === null) return null;
    if (repository.host === "github.com" && (yield* tokens.configured)) {
      const installation = yield* tokens
        .tokenFor({ sandboxId, repository: repository.path })
        .pipe(Effect.option);
      if (Option.isSome(installation)) return installation.value.token;
    }
    const memberId = requesterMember(requester);
    if (memberId === undefined) return null;
    const credential = yield* memberGitHub.credentialFor(memberId);
    return Option.isSome(credential) && credential.value.host === repository.host
      ? credential.value.token
      : null;
  });

  const prepareRepos = Effect.fnUntraced(function* (
    record: TeamImageBuildRecord,
    projectIds: ReadonlyArray<ProjectId>,
  ) {
    const repos: Array<{
      readonly projectId: ProjectId;
      readonly url: string;
      readonly path: string;
      readonly tokenVariable: string | null;
    }> = [];
    const env: Record<string, Redacted.Redacted<string>> = {};
    for (const [index, projectId] of projectIds.entries()) {
      const project = yield* projects.getById(projectId).pipe(Effect.orElseSucceed(Option.none));
      if (Option.isNone(project)) {
        return yield* new BuildStopped({
          phase: "clone",
          detail: `A recipe project (${projectId}) no longer exists.`,
        });
      }
      const url = yield* git
        .readRemoteUrl({ cwd: project.value.workspaceRoot, remoteName: "origin" })
        .pipe(Effect.orElseSucceed(() => null));
      if (url === null) {
        return yield* new BuildStopped({
          phase: "clone",
          detail: `${project.value.title} has no origin remote to clone.`,
        });
      }
      const token = yield* cloneToken(record.machine.sandboxId, record.build.requestedBy, url);
      const tokenVariable = token === null ? null : `T3_CLONE_TOKEN_${index}`;
      if (tokenVariable !== null && token !== null) env[tokenVariable] = token;
      repos.push({
        projectId,
        url: cloneUrlFor(url),
        path: clonePathFor(TEAM_IMAGE_ROOT, url, projectId),
        tokenVariable,
      });
    }
    return { repos, env };
  });

  const resolveSecrets = Effect.fnUntraced(function* (recipe: TeamImageRecipe) {
    const env: Record<string, Redacted.Redacted<string>> = {};
    for (const [name, reference] of Object.entries(recipe.buildSecrets)) {
      const value = yield* requireSettingsSecret(secrets, reference).pipe(
        Effect.mapError(
          () =>
            new BuildStopped({
              phase: "install",
              detail: `Pair Cloud could not read the build secret ${name}.`,
            }),
        ),
      );
      if (!isRedactableSecret(value)) {
        return yield* new BuildStopped({
          phase: "install",
          detail: `${name} is too short to keep out of the log.`,
        });
      }
      env[name] = Redacted.make(value);
    }
    return env;
  });

  /** Everything the program needs that can fail before it starts; nothing here is logged. */
  const prepare = Effect.fnUntraced(function* (record: TeamImageBuildRecord) {
    const revision = yield* store.readRevision(record.build.recipeRevision);
    if (Option.isNone(revision)) {
      return yield* new BuildStopped({ phase: "preflight", detail: "The build's recipe is gone." });
    }
    const { recipe } = revision.value;
    const secretEnv = yield* resolveSecrets(recipe);
    const { repos, env: tokenEnv } = yield* prepareRepos(record, recipe.projectIds);
    const secrets = { ...secretEnv, ...tokenEnv };
    return {
      recipe,
      repos,
      secretEnv,
      tokenEnv,
      secretValues: Object.values(secrets).map(Redacted.value),
    };
  });
  type Prepared = Effect.Success<ReturnType<typeof prepare>>;

  /** The first `::t3-leak::` hit names the failure; the rest are only counted. */
  const leakFailure = (leaks: ReadonlyArray<Leak>, tokenNames: ReadonlyArray<string>) => {
    const [first, ...rest] = leaks;
    if (first === undefined) return null;
    return new BuildStopped({
      phase: "leak",
      detail: [
        `${first.name}'s value was found in ${first.path}.`,
        rest.length > 0
          ? `${rest.length} more ${rest.length === 1 ? "place leaks" : "places leak"} a secret.`
          : null,
        tokenNames.includes(first.name) ? null : `Use \${${first.name}} instead.`,
      ]
        .filter((part) => part !== null)
        .join(" "),
    });
  };

  const runBuild = Effect.fnUntraced(function* (
    record: TeamImageBuildRecord,
    prepared: Prepared,
    writer: TeamImageBuildLog.TeamImageBuildLogWriter,
    progress: { phase: TeamImageBuildPhase },
  ) {
    const { build, machine } = record;
    const { recipe, repos, secretEnv, tokenEnv } = prepared;
    const stopped = (detail: string) => () => new BuildStopped({ phase: progress.phase, detail });

    const host = yield* hosts
      .forPath(`${SANDBOX_ROOT}/${machine.sandboxId}`)
      .pipe(Effect.mapError(stopped("The build machine's runner is not connected.")));
    const home = (yield* host.info).homeDirectory;
    const buildDir = `${home}/.t3-build`;
    const program = teamImageBuildProgram({
      repos,
      excludedEnvNames: [
        ...Object.keys(recipe.buildEnv),
        ...Object.keys(secretEnv),
        ...Object.keys(tokenEnv),
      ],
      leakCheckNames: [...Object.keys(secretEnv), ...Object.keys(tokenEnv)],
    });
    yield* Effect.all([
      host.fileSystem.makeDirectory(buildDir, { recursive: true }),
      host.fileSystem.writeFileString(`${buildDir}/install.sh`, recipe.install),
      host.fileSystem.writeFileString(`${buildDir}/t3-build.sh`, program),
    ]).pipe(
      Effect.mapError(stopped("Pair Cloud could not write the build program to the machine.")),
    );

    const leaks: Array<Leak> = [];
    const exitCode = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* host.spawner.spawn(
          ChildProcess.make("bash", [`${buildDir}/t3-build.sh`], {
            cwd: home,
            env: { ...recipe.buildEnv, ...secretEnv, ...tokenEnv },
            extendEnv: true,
            stdin: "ignore",
          }),
        );
        yield* child.all.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => {
            if (line.startsWith(TEAM_IMAGE_LEAK_MARKER)) {
              // The marker names a place, never a value; the log gets a sentence instead.
              const [name = "", ...path] = line.slice(TEAM_IMAGE_LEAK_MARKER.length).split("::");
              leaks.push({ name, path: path.join("::") });
              return writer.write(`${name}'s value was found in ${path.join("::")}.`);
            }
            return writer.write(line).pipe(
              Effect.flatMap((next) => {
                if (next === null) return Effect.void;
                progress.phase = next;
                return dispatch({
                  type: "team-image.build.phase",
                  commandId: commandId(`phase:${next}`, build.id),
                  imageBuildId: build.id,
                  phase: next,
                });
              }),
            );
          }),
        );
        return Number(yield* child.exitCode);
      }),
    ).pipe(Effect.mapError(stopped("The build machine stopped answering.")));

    const leaked = leakFailure(leaks, Object.keys(tokenEnv));
    if (leaked !== null) return yield* leaked;
    if (exitCode !== 0) {
      return yield* new BuildStopped({
        phase: progress.phase,
        detail:
          exitCode === TEAM_IMAGE_NO_SUDO_EXIT_CODE
            ? TEAM_IMAGE_NO_SUDO_DETAIL
            : `The build failed during ${progress.phase} (exit ${exitCode}).`,
        exitCode,
      });
    }
    progress.phase = "manifest";
    const output = yield* host.fileSystem
      .readFileString(TEAM_IMAGE_BUILD_OUTPUT)
      .pipe(
        Effect.flatMap(decodeOutput),
        Effect.mapError(stopped("The build wrote a manifest Pair Cloud could not read.")),
      );
    // The program's own check of the manifest is the first line; this is the second.
    for (const [name, value] of Object.entries({ ...secretEnv, ...tokenEnv })) {
      const fragments = secretFragments(Redacted.value(value));
      const hit = Object.entries(output.imageEnv).find(([, envValue]) =>
        fragments.some((fragment) => envValue.includes(fragment)),
      );
      if (hit !== undefined) {
        return yield* new BuildStopped({
          phase: "leak",
          detail: `${name}'s value was found in the image environment (${hit[0]}).`,
        });
      }
    }
    const base = baseImages.get(build.id) ?? null;
    const manifest: TeamImageManifest = {
      base: {
        ref: base?.ref ?? "unknown",
        digest: base?.digest ?? null,
        pairVersion: output.pairVersion,
      },
      providers: Object.entries(output.providers).flatMap(([driver, version]) =>
        isProviderDriverKind(driver) ? [{ driver, version }] : [],
      ),
      repos: output.repos,
      serverVersion: packageJson.version,
      imageEnv: output.imageEnv,
      sizeBytes: null,
    };
    yield* dispatch({
      type: "team-image.build.program-finished",
      commandId: commandId("program-finished", build.id),
      imageBuildId: build.id,
      manifest,
    });
  });

  /** Runs `t3-build.sh` to its end; a failure is dispatched, never returned. */
  const program = Effect.fn("TeamImageEffects.program")(
    function* (record: TeamImageBuildRecord) {
      const progress: { phase: TeamImageBuildPhase } = { phase: "preflight" };
      const failed =
        (tail: Effect.Effect<ReadonlyArray<string>>) =>
        <E>(cause: Cause.Cause<E>) =>
          Effect.gen(function* () {
            if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause);
            const stopped = Option.filter(Cause.findErrorOption(cause), isBuildStopped);
            if (Option.isNone(stopped)) {
              yield* Effect.logWarning("Team image build program failed", cause);
            }
            const failure = Option.getOrElse(
              stopped,
              () =>
                new BuildStopped({
                  phase: progress.phase,
                  detail: "Pair Cloud lost the build machine.",
                }),
            );
            yield* failBuild(record.build.id, "program", {
              phase: failure.phase,
              detail: failure.detail,
              ...(failure.exitCode === undefined ? {} : { exitCode: failure.exitCode }),
              logTail: yield* tail,
            });
          });
      // The log redacts the secrets it is opened with, so it opens once they are read.
      const prepared = yield* prepare(record).pipe(
        Effect.asSome,
        Effect.catchCause((cause) =>
          failed(Effect.succeed([]))(cause).pipe(Effect.as(Option.none<Prepared>())),
        ),
      );
      if (Option.isNone(prepared)) return;
      const writer = yield* buildLog.open(record.build.number, prepared.value.secretValues);
      yield* runBuild(record, prepared.value, writer, progress).pipe(
        Effect.catchCause(failed(writer.tail)),
      );
    },
    (effect, record) =>
      effect.pipe(Effect.scoped, Effect.ensuring(tokens.revoke(record.machine.sandboxId))),
  );

  const startProgram = Effect.fn("TeamImageEffects.startProgram")(function* (
    imageBuildId: TeamImageBuildId,
  ) {
    const record = yield* readRecord(imageBuildId);
    if (record?.build.status !== "running" || programs.has(imageBuildId)) return;
    // Ends with the build: a cancel, fail or timeout takes it off the live slot.
    const ended = liveBuild.changes.pipe(
      Stream.filter((live) => live?.imageBuildId !== imageBuildId),
      Stream.runHead,
    );
    programs.add(imageBuildId);
    yield* program(record).pipe(
      Effect.raceFirst(ended),
      Effect.ignore({ log: true }),
      Effect.ensuring(Effect.sync(() => programs.delete(imageBuildId))),
      Effect.forkIn(scope),
    );
  });

  const capture = Effect.fn("TeamImageEffects.capture")(function* (imageBuildId: TeamImageBuildId) {
    const record = yield* readRecord(imageBuildId);
    if (record?.build.status !== "capturing") return;
    const { build, machine } = record;
    const driver = yield* registry.get(build.driverId);
    const image = yield* driver.snapshot(
      machine.driverRef ?? (yield* backendName(machine.sandboxId)),
      `t3-team-image:${build.number}`,
    );
    yield* dispatch({
      type: "team-image.build.captured",
      commandId: commandId("captured", imageBuildId),
      imageBuildId,
      imageRef: image.imageRef,
      sizeBytes: image.sizeBytes,
    });
  });

  const destroyMachine = Effect.fn("TeamImageEffects.destroyMachine")(function* (
    imageBuildId: TeamImageBuildId,
  ) {
    const record = yield* readRecord(imageBuildId);
    if (record === null || record.machine.destroyedAt !== null) return;
    const { build, machine } = record;
    const driver = yield* registry.get(build.driverId);
    // Destroying a missing machine succeeds, so one whose create never answered goes by name.
    yield* driver.destroy(machine.driverRef ?? (yield* backendName(machine.sandboxId)));
    yield* hub.revoke(machine.sandboxId).pipe(Effect.ignore({ log: true }));
    yield* tokens.revoke(machine.sandboxId);
    baseImages.delete(imageBuildId);
    yield* dispatch({
      type: "team-image.build.machine-destroyed",
      commandId: commandId("machine-destroyed", imageBuildId),
      imageBuildId,
    });
  });

  const executionError = (effect: TeamImageEffectV2) => (cause: unknown) =>
    new OrchestrationEffectExecutionError({
      effectId: effect.id,
      effectType: effect.request.type,
      ...(isPermanent(cause) && !("retryable" in cause && cause.retryable)
        ? { retryable: false }
        : {}),
      cause,
    });

  const execute: TeamImageEffects["Service"]["execute"] = (effect) => {
    const { request } = effect;
    const run = (() => {
      switch (request.type) {
        case "team-image.build.launch":
          return launch(request.imageBuildId);
        case "team-image.build.run-program":
          return startProgram(request.imageBuildId);
        case "team-image.build.capture":
          return capture(request.imageBuildId);
        case "team-image.build.destroy-machine":
          return destroyMachine(request.imageBuildId);
        case "team-image.build.delete-image":
          return registry
            .get(request.driverId)
            .pipe(Effect.flatMap((driver) => driver.deleteImage(request.imageRef)));
      }
    })();
    return run.pipe(Effect.mapError(executionError(effect)));
  };

  const reportExhausted: TeamImageEffects["Service"]["reportExhausted"] = Effect.fn(
    "TeamImageEffects.reportExhausted",
  )(function* (effect, cause) {
    const { request } = effect;
    const phase =
      request.type === "team-image.build.launch"
        ? "launch"
        : request.type === "team-image.build.capture"
          ? "capture"
          : request.type === "team-image.build.run-program"
            ? "preflight"
            : null;
    if (phase === null) {
      return yield* Effect.logWarning("A team image cleanup effect gave up", {
        effectId: effect.id,
        effectType: request.type,
        cause,
      });
    }
    yield* failBuild(request.imageBuildId, request.type, {
      phase,
      detail: UNREACHABLE,
      logTail: [],
    }).pipe(
      Effect.catchCause((dispatchCause) =>
        Effect.logWarning("Could not fail the build", dispatchCause),
      ),
    );
  });

  // A runner's first hello for the live build's machine moves the build to running.
  yield* hub.boots.pipe(
    Stream.runForEach((boot) =>
      Effect.gen(function* () {
        const live = yield* liveBuild.current;
        if (live === null) return;
        const record = yield* readRecord(live.imageBuildId);
        if (record?.machine.sandboxId !== boot.sandboxId) return;
        yield* dispatch({
          type: "team-image.build.attached",
          commandId: commandId("attached", live.imageBuildId),
          imageBuildId: live.imageBuildId,
        });
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("Team image attach failed", cause))),
    ),
    Effect.forkIn(scope),
  );

  return TeamImageEffects.of({ execute, reportExhausted });
});

export const layer = Layer.effect(TeamImageEffects, make);
