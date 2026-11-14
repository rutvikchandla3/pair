import {
  type BoatSandboxDriver,
  type EnvironmentId,
  isSecretReference,
  type SandboxSize,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import { requireSettingsSecret } from "../../secrets/settingsSecretValue.ts";
import {
  SandboxProvisionTree,
  type SandboxProvisionTreeInfo,
  type SandboxProvisionTreeUnavailableError,
} from "../image/SandboxProvisionTree.ts";
import {
  type BoatApi,
  BoatApiError,
  type BoatSandbox,
  type BoatSandboxCreate,
  type BoatSandboxType,
  type BoatSavedSnapshot,
  makeBoatApi,
  mapBoatError,
} from "./BoatApi.ts";
import {
  type BackendSandbox,
  type BackendSandboxStatus,
  type BaseImageInfo,
  type ComputeCapabilities,
  ComputeDriver,
  type ComputeDriverCreateInput,
  ComputeDriverError,
  type ComputeDriverHealth,
  parseSandboxTags,
  type SandboxBootstrap,
  wakeFailure,
} from "./ComputeDriver.ts";
import {
  stepVmBaseImage,
  type VmBaseImageCloud,
  VmBaseImageConflictError,
  type VmBuilder,
  type VmBuilderLaunch,
  type VmImage,
  type VmImageCapture,
  vmBaseImageNames,
} from "./VmBaseImage.ts";
import { nodeHttpClient, teamImageName, vmBootstrapText } from "./vmHelpers.ts";

/** A driver call never runs past this, so it ends inside a sandbox effect's 60-second bound. */
const CALL_DEADLINE_MS = 50_000;
/** What `awaitReady` leaves of the deadline for the bootstrap's delivery. */
const DELIVERY_RESERVE_MS = 8_000;
const REPLAY_AFTER_MS = 5_000;
/** How long `stop` waits for boat to read `archiving`. */
const STOP_SETTLE_MS = 10_000;
const BUILD_STEP_INTERVAL = "30 seconds";

const INSTALL_LABEL = "pair.install";
const SANDBOX_LABEL = "pair.sandbox";
const GENERATION_LABEL = "pair.generation";

const BOOTSTRAP_PATH = "/tmp/pair-boot/bootstrap.env";
const BOOT_COMMAND_TIMEOUT_SECONDS = 30;
const BUILD_DIR = "/tmp/pair-base-build";
const IMAGE_INFO_PATH = "/etc/pair-image.json";

/** boat keeps `/home/user` at a snapshot's root and every other path under `__system__/`. */
const snapshotPath = (path: string) => {
  const absolute = `/${path.replace(/^\/+/, "")}`;
  return absolute.startsWith("/home/user/")
    ? absolute.slice("/home/user/".length)
    : `__system__${absolute}`;
};
const BUILD_LOG_LINE = /pair-base-build: .*/g;
const BOOT_LOG_LINE = /pair-boat-boot: .*/g;
/** boat's saved snapshot names. */
const SAVED_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

const STARTING_STATES = new Set(["init", "provisioning", "provisioned", "cloning"]);
const READY_STATES = new Set(["ready", "idle", "running"]);
const STOPPED_STATES = new Set(["archiving", "archived"]);
/** States `resume` takes back; boat answers `sandbox_stopping` while it may not yet. */
const RESUMABLE_STATES = new Set(["archiving", "archived", "error"]);

const TYPE_SIZES: Readonly<Record<BoatSandboxType, { vcpus: number; memoryGb: number }>> = {
  small: { vcpus: 2, memoryGb: 4 },
  default: { vcpus: 4, memoryGb: 8 },
  large: { vcpus: 8, memoryGb: 16 },
  xlarge: { vcpus: 16, memoryGb: 32 },
};
const SANDBOX_SIZES: ReadonlyArray<SandboxSize> = ["small", "default", "large"];

const NOT_CLOUD_ONLY =
  "The boat.dev driver runs only on a Pair Cloud server (started with --cloud-only). On any other server, agents could use this machine's boat.dev account.";
const NO_KEY_HINT = "Paste a boat API key.";
const RUNNER_URL_HINT =
  "Set the Runner URL to an https:// address boat machines reach: this server's public address, or a public hostname for its runner listener.";
const PLAN_HINT =
  "This boat account is on its trial or a plan without this size. Start a paid plan (xlarge needs $100 a month).";
const OUTSIDE_NETWORK = "boat machines run in boat's cloud, outside this server's network.";
const buildFailedHint = (step: string) =>
  `The base image build failed at \`${step}\`. The builder's last log lines are in this server's log. Choose Refresh to build it again.`;
const conflictHint = (resource: string) =>
  `\`${resource}\` is in this boat account but this server did not make it, so it is left alone. Delete or rename it, then choose Refresh.`;

const typeOf = (config: BoatSandboxDriver, size: SandboxSize): BoatSandboxType =>
  config.types?.[size] ?? size;

/** An https URL, which B7 requires: the secret and token cross the internet. */
const isHttpsUrl = (value: string | undefined) => {
  if (value === undefined) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const hasApiKey = (config: BoatSandboxDriver) =>
  isSecretReference(config.apiKey) || config.apiKey.trim() !== "";

const statusOf = (state: string): BackendSandboxStatus => {
  if (STARTING_STATES.has(state)) return "starting";
  if (READY_STATES.has(state)) return "running";
  if (STOPPED_STATES.has(state)) return "stopped";
  if (state === "error") return "failed";
  return "missing";
};

/**
 * A base image builder as `stepVmBaseImage` reads it. The builder never powers off, so "stopped"
 * means base-build.sh has finished: it wrote a result, boat's setup step ended, or boat stopped it.
 */
export const builderStateOf = (
  state: string,
  setupStatus: string | null | undefined,
  result: string | null,
): VmBuilder["state"] => {
  if (STARTING_STATES.has(state)) return "starting";
  if (!READY_STATES.has(state)) return "stopped";
  return result !== null || setupStatus === "done" || setupStatus === "failed"
    ? "stopped"
    : "running";
};

const createdAtMs = (createdAt: string | null | undefined) => Date.parse(createdAt ?? "") || 0;

const capabilitiesOf = (config: BoatSandboxDriver): ComputeCapabilities => ({
  persistentDisk: true,
  // The pre-stop hook ends the runner before boat keeps the machine warm (decision 10).
  memoryOnStop: false,
  snapshot: false,
  imageBuild: "snapshot",
  maxSessionMs: null,
  diskRetentionDays: 14,
  isolation: "vm",
  egressRules: "none",
  regions: ["eu"],
  nestedDocker: true,
  sizes: SANDBOX_SIZES.map((size) => ({ size, ...TYPE_SIZES[typeOf(config, size)] })),
  defaultRunningCap: 20,
  // Every wake spends one of the plan's starts, which are limited per day.
  sleepOnSettle: false,
  defaultIdleSleepMs: 20 * 60_000,
});

/** Off cloud-only every call fails before any call to boat. */
const unsupportedDriver = (config: BoatSandboxDriver) => {
  const refuse = (operation: ComputeDriverError["operation"]) =>
    Effect.fn(`BoatComputeDriver.${operation}`)(() =>
      Effect.fail(
        new ComputeDriverError({
          driverId: config.id,
          operation,
          reason: "unsupported",
          retryable: false,
          setupHint: NOT_CLOUD_ONLY,
        }),
      ),
    );
  return ComputeDriver.of({
    driverId: config.id,
    kind: "boat",
    capabilities: capabilitiesOf(config),
    create: refuse("create"),
    start: refuse("start"),
    stop: refuse("stop"),
    destroy: refuse("destroy"),
    status: refuse("status"),
    list: refuse("list"),
    deleteImage: refuse("deleteImage"),
    snapshot: refuse("snapshot"),
    readImageFile: refuse("readImageFile"),
    health: refuse("health")(),
  });
};

type BaseImage = VmImage & { readonly saved: BoatSavedSnapshot };

/** Where the base image build stands; `Failed` is final until `health` starts another. */
type BuildState =
  | { readonly _tag: "Building"; readonly image: string }
  | { readonly _tag: "Ready"; readonly image: BoatSavedSnapshot }
  | { readonly _tag: "Failed"; readonly ref: string; readonly hint: string };

/** One build fiber; readers wait for its first decision, never for the whole build. */
interface BuildAttempt {
  readonly state: Ref.Ref<BuildState>;
  readonly decided: Deferred.Deferred<void>;
}

/** The driver over a boat client; `make` builds the client from the driver's API key. */
export const makeWithApi = Effect.fn("BoatComputeDriver.makeWithApi")(function* (
  config: BoatSandboxDriver,
  installId: EnvironmentId,
  api: BoatApi,
  server: {
    readonly cloudOnly: boolean;
    /** What the base image build boots with. */
    readonly provisionTree: Effect.Effect<
      SandboxProvisionTreeInfo,
      SandboxProvisionTreeUnavailableError
    >;
    /**
     * Test only: machines boot stock boat with no base image, and delivery runs this command in
     * place of `pair-boat-boot`. Sessions never get one.
     */
    readonly guest?: { readonly command: (generation: number) => string };
  },
) {
  if (!server.cloudOnly) return unsupportedDriver(config);
  const driverId = config.id;
  const install8 = installId.slice(0, 8).toLowerCase();
  const ownPrefix = `pair-${install8}-`;
  const baseFamily = `pair-${install8}-base`;
  // boat's id for each name, asked again when it is not there.
  const ids = new Map<string, string>();

  const failure = (
    operation: ComputeDriverError["operation"],
    reason: ComputeDriverError["reason"],
    extra: {
      readonly retryable?: boolean;
      readonly retryAfterMs?: number;
      readonly setupHint?: string;
    } = {},
  ) =>
    new ComputeDriverError({
      driverId,
      operation,
      reason,
      retryable: extra.retryable ?? false,
      ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
      ...(extra.setupHint === undefined ? {} : { setupHint: extra.setupHint }),
    });
  const notYet = (operation: ComputeDriverError["operation"]) =>
    failure(operation, "unavailable", { retryable: true, retryAfterMs: REPLAY_AFTER_MS });

  /** Maps boat failures and ends the call at the deadline; the outbox replays it. */
  const bounded =
    (operation: ComputeDriverError["operation"]) =>
    <A>(effect: Effect.Effect<A, ComputeDriverError | BoatApiError>) =>
      effect.pipe(
        Effect.catchTags({
          BoatApiError: (error) => Effect.fail(mapBoatError(error, { driverId, operation })),
        }),
        Effect.timeoutOrElse({
          duration: CALL_DEADLINE_MS,
          orElse: () => Effect.fail(notYet(operation)),
        }),
        Effect.mapError((error) =>
          operation === "start" || operation === "stop" ? wakeFailure(error) : error,
        ),
      );

  const ours = (sandbox: BoatSandbox) => sandbox.labels?.[INSTALL_LABEL] === installId;
  const deadlineFrom = (startedMs: number) => startedMs + CALL_DEADLINE_MS - DELIVERY_RESERVE_MS;

  /** Every page of this install's sandboxes carrying `labels` (and `name`, when given). */
  const listAll = Effect.fn("BoatComputeDriver.listAll")(function* (
    labels: Readonly<Record<string, string>>,
    name?: string,
  ) {
    const found: Array<BoatSandbox> = [];
    let cursor: string | undefined;
    do {
      const page = yield* api.sandboxes.list({
        labels,
        ...(name === undefined ? {} : { name }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      found.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return found;
  });

  /** This install's sandbox of `name`, or null. */
  const locate = Effect.fn("BoatComputeDriver.locate")(function* (name: string) {
    const known = ids.get(name);
    if (known !== undefined) {
      const sandbox = yield* api.sandboxes.get(known);
      if (sandbox !== null && sandbox.name === name && ours(sandbox)) return sandbox;
      ids.delete(name);
    }
    const matches = (yield* listAll({ [INSTALL_LABEL]: installId }, name))
      .filter((sandbox) => sandbox.name === name)
      .toSorted((a, b) => createdAtMs(a.createdAt) - createdAtMs(b.createdAt));
    const oldest = matches[0];
    if (oldest === undefined) return null;
    if (matches.length > 1) {
      yield* Effect.logWarning("Several boat sandboxes share one name; using the oldest", {
        name,
        ids: matches.map((sandbox) => sandbox.id),
      });
    }
    ids.set(name, oldest.id);
    return oldest;
  });

  /** Reads the sandbox every second until it is ready, while the deadline leaves time to deliver. */
  // Untraced: one span per poll would be noise.
  const awaitReady = Effect.fnUntraced(function* (
    operation: "create" | "start",
    id: string,
    deadlineMs: number,
  ) {
    let warned = false;
    while (true) {
      const sandbox = yield* api.sandboxes.get(id);
      if (sandbox === null) return yield* notYet(operation);
      if (sandbox.health === "degraded" && !warned) {
        warned = true;
        yield* Effect.logWarning(
          "boat reports the machine degraded: something in it blocks boat's agent",
          { id },
        );
      }
      if (READY_STATES.has(sandbox.state)) return sandbox;
      if (sandbox.state === "error" || STOPPED_STATES.has(sandbox.state)) {
        return yield* notYet(operation);
      }
      if ((yield* Clock.currentTimeMillis) + 1_000 > deadlineMs) return yield* notYet(operation);
      yield* Effect.sleep("1 second");
    }
  });

  /** Writes this boot's bootstrap where boat keeps no copy, then starts the runner with it. */
  const deliver = Effect.fn("BoatComputeDriver.deliver")(function* (
    operation: "create" | "start",
    sandbox: BoatSandbox,
    bootstrap: SandboxBootstrap,
    text: string,
  ) {
    yield* api.files.write(sandbox.id, BOOTSTRAP_PATH, text);
    const command =
      server.guest?.command(bootstrap.generation) ??
      `sudo /usr/local/bin/pair-boat-boot ${bootstrap.generation}`;
    const result = yield* api.commands.run(sandbox.id, command, BOOT_COMMAND_TIMEOUT_SECONDS);
    if (result.exitCode === 0) return;
    // Only its own lines: nothing else of the command's output reaches the log.
    yield* Effect.logWarning("pair-boat-boot failed", {
      id: sandbox.id,
      exitCode: result.exitCode,
      lines: Array.from((result.stderr ?? "").matchAll(BOOT_LOG_LINE), (line) => line[0]),
    });
    return yield* notYet(operation);
  });

  const resume = Effect.fn("BoatComputeDriver.resume")(function* (sandbox: BoatSandbox) {
    yield* Effect.logInfo("Resuming a boat sandbox", { driverRef: sandbox.name, id: sandbox.id });
    yield* api.sandboxes.resume(sandbox.id);
  });

  const bootstrapFor = (operation: "create" | "start", bootstrap: SandboxBootstrap) => {
    const text = vmBootstrapText(bootstrap);
    return text === null
      ? Effect.fail(failure(operation, "invalid-request"))
      : Effect.succeed(text);
  };

  const savedSnapshotImage = (saved: BoatSavedSnapshot): BaseImage => ({
    name: saved.name,
    status: saved.status === "ready" ? "ready" : saved.status === "failed" ? "failed" : "pending",
    // Saved snapshots carry no labels: the install's name prefix is the claim.
    installId: saved.name.startsWith(ownPrefix) ? installId : null,
    createdAtMs: createdAtMs(saved.createdAt),
    saved,
  });

  /** One build's view of boat; `publish` lets readers go as soon as the image is found or not. */
  const baseImageCloud = (
    imageName: string,
    publish: (state: BuildState) => Effect.Effect<void>,
  ): VmBaseImageCloud<BaseImage, BoatApiError | VmBaseImageConflictError> => {
    // The result `findBuilder` last read, so a builder deleted short of `ok` leaves its log behind.
    let lastResult: string | null = null;
    return {
      findImage: Effect.fn("BoatComputeDriver.findBaseImage")(function* (name: string) {
        const saved = yield* api.savedSnapshots.get(name);
        const image = saved === null ? null : savedSnapshotImage(saved);
        if (image === null || image.installId === installId) {
          yield* publish(
            image?.status === "ready"
              ? { _tag: "Ready", image: image.saved }
              : { _tag: "Building", image: imageName },
          );
        }
        return image;
      }),
      listImages: Effect.fn("BoatComputeDriver.listBaseImages")(function* (family: string) {
        return (yield* api.savedSnapshots.list(`${family}-`)).map(savedSnapshotImage);
      }),
      deleteImage: Effect.fn("BoatComputeDriver.deleteBaseImage")(function* (name: string) {
        yield* Effect.logInfo("Deleting a base image", { image: name });
        yield* api.savedSnapshots.delete(name);
      }),
      findBuilder: Effect.fn("BoatComputeDriver.findBuilder")(function* (name: string) {
        const sandbox = yield* locate(name);
        if (sandbox === null) return null;
        const live = READY_STATES.has(sandbox.state);
        const result = live ? yield* api.files.read(sandbox.id, `${BUILD_DIR}/result`) : null;
        lastResult = result?.trim() || null;
        return {
          name,
          installId: sandbox.labels?.[INSTALL_LABEL] ?? null,
          state: builderStateOf(sandbox.state, sandbox.setupStatus, lastResult),
          createdAtMs: createdAtMs(sandbox.createdAt),
          result: lastResult,
        } satisfies VmBuilder;
      }),
      launchBuilder: Effect.fn("BoatComputeDriver.launchBuilder")(function* (
        input: VmBuilderLaunch,
      ) {
        yield* Effect.logInfo("Launching the base image builder", {
          builder: input.name,
          image: imageName,
        });
        // No bootstrap and no account secrets: the builder reaches nothing of ours.
        const body: BoatSandboxCreate = {
          name: input.name,
          type: "small",
          // A billing backstop past the build's 30-minute timeout.
          ttlSeconds: 3600,
          noEnv: true,
          monitoring: false,
          snapshots: true,
          ...(config.organization === undefined ? {} : { visibility: "private" }),
          // No `pair.sandbox` label, so `list` and the reconciler never see it.
          labels: { [INSTALL_LABEL]: installId },
          files: [
            ...Object.entries(input.metadata).map(([key, content]) => ({
              path: `${BUILD_DIR}/metadata/${key}`,
              content,
            })),
            { path: `${BUILD_DIR}/base-build.sh`, content: input.startupScript },
          ],
          setupScript: `sudo env PAIR_VM_TARGET=boat PAIR_METADATA_DIR=${BUILD_DIR}/metadata bash ${BUILD_DIR}/base-build.sh >${BUILD_DIR}/build.log 2>&1`,
        };
        const sandbox = yield* api.sandboxes.create(body, input.name);
        ids.set(input.name, sandbox.id);
      }),
      captureImage: Effect.fn("BoatComputeDriver.captureBaseImage")(function* (
        input: VmImageCapture,
      ) {
        const builder = yield* locate(input.builder);
        if (builder === null) return;
        yield* Effect.logInfo("Saving the base image from its builder", {
          builder: input.builder,
          image: input.name,
        });
        yield* api.savedSnapshots.save(builder.id, input.name);
      }),
      deleteBuilder: Effect.fn("BoatComputeDriver.deleteBuilder")(function* (name: string) {
        const builder = yield* locate(name);
        if (builder === null) return;
        if (lastResult !== "ok" && READY_STATES.has(builder.state)) {
          const log = yield* api.files
            .read(builder.id, `${BUILD_DIR}/build.log`)
            .pipe(Effect.orElseSucceed(() => null));
          yield* Effect.logWarning("The base image builder's last log lines", {
            builder: name,
            result: lastResult,
            lines: Array.from((log ?? "").matchAll(BUILD_LOG_LINE), (line) => line[0]).slice(-20),
          });
        }
        yield* Effect.logInfo("Deleting the base image builder", { builder: name });
        yield* api.sandboxes.delete(builder.id);
        ids.delete(name);
      }),
    };
  };

  /** Steps the build every 30 seconds until the image is ready and settled, or the build fails. */
  const runBuild = Effect.fn("BoatComputeDriver.buildBaseImage")(function* (attempt: BuildAttempt) {
    let shown = "";
    const publish = Effect.fn("BoatComputeDriver.publishBaseImageState")(function* (
      state: BuildState,
    ) {
      yield* Ref.set(attempt.state, state);
      yield* Deferred.succeed(attempt.decided, undefined);
      // Logged once per change, never once per step.
      if (state._tag === shown || state._tag === "Failed") return;
      shown = state._tag;
      yield* state._tag === "Ready"
        ? Effect.logInfo("The base image is ready", { image: state.image.name })
        : Effect.logInfo("Building the base image", { image: state.image });
    });
    const fail = (ref: string, hint: string, detail: Readonly<Record<string, string>>) =>
      Effect.logWarning("The base image build failed", { image: ref, ...detail }).pipe(
        Effect.andThen(publish({ _tag: "Failed", ref, hint })),
      );

    const tree = yield* Effect.result(server.provisionTree);
    if (tree._tag === "Failure") {
      return yield* fail(baseFamily, tree.failure.message, { reason: tree.failure.reason });
    }
    const names = vmBaseImageNames(installId, tree.success.sha256);
    yield* Ref.set(attempt.state, { _tag: "Building", image: names.image });
    const cloud = baseImageCloud(names.image, publish);
    let problem = "";
    while (true) {
      const stepped = yield* stepVmBaseImage({ cloud, installId, tree: tree.success }).pipe(
        Effect.map((state) => ({ _tag: "Stepped", state }) as const),
        Effect.catchTags({
          VmBaseImageConflictError: (error) =>
            Effect.succeed({ _tag: "Conflict", resource: error.resource } as const),
        }),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.succeed({ _tag: "Problem", cause } as const),
        ),
      );
      switch (stepped._tag) {
        case "Conflict":
          return yield* fail(names.image, conflictHint(stepped.resource), {
            resource: stepped.resource,
          });
        case "Problem": {
          // A boat error is tried again next step; the same one is logged once.
          const squashed = Cause.squash(stepped.cause);
          const key = squashed instanceof Error ? squashed.message : String(squashed);
          if (key !== problem) {
            problem = key;
            yield* Effect.logWarning("A base image build step failed", stepped.cause);
          }
          yield* Deferred.succeed(attempt.decided, undefined);
          break;
        }
        case "Stepped": {
          problem = "";
          const state = stepped.state;
          if (state._tag === "Failed") {
            return yield* fail(names.image, buildFailedHint(state.step), { step: state.step });
          }
          if (state._tag === "Ready") {
            yield* publish({ _tag: "Ready", image: state.image.saved });
            if (state.settled) return;
          } else {
            yield* publish({ _tag: "Building", image: state.image });
          }
        }
      }
      yield* Effect.sleep(BUILD_STEP_INTERVAL);
    }
  });

  const buildScope = yield* Effect.scope;
  const buildLock = yield* Semaphore.make(1);
  // Only touched while holding `buildLock`.
  let build: BuildAttempt | undefined;

  const startBuild = Effect.fn("BoatComputeDriver.startBaseImageBuild")(function* () {
    const attempt = {
      state: yield* Ref.make<BuildState>({ _tag: "Building", image: baseFamily }),
      decided: yield* Deferred.make<void>(),
    } satisfies BuildAttempt;
    // A build takes minutes, far past any caller's bound, so it never runs inside one.
    yield* runBuild(attempt).pipe(
      Effect.ensuring(Deferred.succeed(attempt.decided, undefined)),
      Effect.forkIn(buildScope),
    );
    return attempt;
  });

  /** The current build, or a new one in place of `failed`. */
  const currentBuild = (failed?: BuildAttempt) =>
    buildLock.withPermits(1)(
      Effect.gen(function* () {
        if (build === undefined || build === failed) build = yield* startBuild();
        return build;
      }),
    );

  /** With `retryFailed`, a failure is answered once and the next build starts behind it. */
  const builtBaseImage = Effect.fn("BoatComputeDriver.builtBaseImage")(function* (
    retryFailed: boolean,
  ) {
    const current = yield* currentBuild();
    yield* Deferred.await(current.decided);
    const state = yield* Ref.get(current.state);
    if (retryFailed && state._tag === "Failed") yield* currentBuild(current);
    switch (state._tag) {
      case "Ready":
        return { _tag: "Ready", image: state.image } as const;
      case "Building":
        return { _tag: "Building", ref: state.image } as const;
      case "Failed":
        return { _tag: "Missing", ref: state.ref, hint: state.hint } as const;
    }
  });

  // A test guest boots stock boat, so nothing builds or needs a base image.
  if (server.guest === undefined) yield* currentBuild();

  // `/etc/pair-image.json` of each base snapshot, since a saved snapshot has no description.
  const versions = new Map<string, string | null>();
  const baseImageInfo = Effect.fn("BoatComputeDriver.baseImageInfo")(function* (
    saved: BoatSavedSnapshot,
  ) {
    const digest = saved.snapshotId ?? saved.name;
    if (!versions.has(digest)) {
      const bytes =
        saved.snapshotId === undefined
          ? null
          : yield* api.snapshots.readFile(saved.snapshotId, snapshotPath(IMAGE_INFO_PATH));
      const match =
        bytes === null
          ? null
          : /"pairVersion"\s*:\s*"([^"]+)"/.exec(new TextDecoder().decode(bytes));
      versions.set(digest, match?.[1] ?? null);
    }
    return {
      ref: saved.name,
      digest,
      version: versions.get(digest) ?? null,
    } satisfies BaseImageInfo;
  });

  /** The saved snapshot a create boots from, and the base image it reports. */
  const bootSource = Effect.fn("BoatComputeDriver.bootSource")(function* (
    requested: ComputeDriverCreateInput["image"],
  ) {
    if (server.guest !== undefined) return { from: undefined, baseImage: null };
    if (requested.type === "build") {
      const saved = SAVED_NAME.test(requested.imageRef)
        ? yield* api.savedSnapshots.get(requested.imageRef)
        : null;
      if (saved?.status !== "ready") return yield* failure("create", "not-found");
      return { from: saved.name, baseImage: null };
    }
    const state = yield* builtBaseImage(false);
    switch (state._tag) {
      case "Ready":
        return { from: state.image.name, baseImage: yield* baseImageInfo(state.image) };
      case "Building":
        return yield* new ComputeDriverError({
          driverId,
          operation: "create",
          reason: "unavailable",
          retryable: true,
          image: { ref: state.ref, state: "building" },
        });
      case "Missing":
        return yield* new ComputeDriverError({
          driverId,
          operation: "create",
          reason: "not-found",
          retryable: false,
          image: { ref: state.ref, state: "missing", hint: state.hint },
        });
    }
  });

  const create = Effect.fn("BoatComputeDriver.create")(function* (input: ComputeDriverCreateInput) {
    const deadlineMs = deadlineFrom(yield* Clock.currentTimeMillis);
    if (
      input.tags[INSTALL_LABEL] !== installId ||
      !isHttpsUrl(config.runnerUrl) ||
      !hasApiKey(config)
    ) {
      return yield* failure("create", "invalid-request");
    }
    const text = yield* bootstrapFor("create", input.bootstrap);
    const { from, baseImage } = yield* bootSource(input.image);

    const matches = (sandbox: BoatSandbox) =>
      sandbox.labels?.[SANDBOX_LABEL] === input.tags[SANDBOX_LABEL] &&
      sandbox.labels?.[GENERATION_LABEL] === input.tags[GENERATION_LABEL];
    let sandbox = yield* locate(input.name);
    if (sandbox !== null && !matches(sandbox)) return yield* failure("create", "conflict");
    if (sandbox === null) {
      // The same body on every replay, since it holds no secret, so the key finds the first.
      const body: BoatSandboxCreate = {
        name: input.name,
        type: typeOf(config, input.size),
        ...(from === undefined ? {} : { from }),
        labels: input.tags,
        ttlSeconds: null,
        noEnv: true,
        monitoring: false,
        snapshots: true,
        ...(config.organization === undefined ? {} : { visibility: "private" }),
      };
      const created = yield* api.sandboxes.create(body, input.name).pipe(
        Effect.asSome,
        // The base image moved between attempts: the first attempt's sandbox is found by name.
        Effect.catchIf(
          (error) => error.failure === "status" && error.code === "idempotency_key_reused",
          () => Effect.succeed(Option.none<BoatSandbox>()),
        ),
      );
      if (Option.isSome(created)) {
        yield* Effect.logInfo("Created a boat sandbox", {
          driverRef: input.name,
          id: created.value.id,
        });
        ids.set(input.name, created.value.id);
        sandbox = created.value;
      } else {
        sandbox = yield* locate(input.name);
        if (sandbox === null || !matches(sandbox)) return yield* failure("create", "conflict");
      }
    }
    if (RESUMABLE_STATES.has(sandbox.state)) yield* resume(sandbox);
    const ready = yield* awaitReady("create", sandbox.id, deadlineMs);
    yield* deliver("create", ready, input.bootstrap, text);
    return { driverRef: input.name, baseImage };
  }, bounded("create"));

  const start = Effect.fn("BoatComputeDriver.start")(function* (
    driverRef: string,
    bootstrap: SandboxBootstrap,
  ) {
    const deadlineMs = deadlineFrom(yield* Clock.currentTimeMillis);
    const text = yield* bootstrapFor("start", bootstrap);
    const sandbox = yield* locate(driverRef);
    // A disk boat deleted after 14 days stopped is lost: the mirror rebuilds the checkout.
    if (sandbox === null || (sandbox.dataExpiredAt ?? null) !== null) {
      return yield* failure("start", "not-found");
    }
    if (RESUMABLE_STATES.has(sandbox.state)) yield* resume(sandbox);
    const ready = yield* awaitReady("start", sandbox.id, deadlineMs);
    yield* deliver("start", ready, bootstrap, text);
  }, bounded("start"));

  const stop = Effect.fn("BoatComputeDriver.stop")(function* (driverRef: string) {
    const sandbox = yield* locate(driverRef);
    if (sandbox === null) return yield* failure("stop", "not-found");
    if (STOPPED_STATES.has(sandbox.state)) return;
    yield* Effect.logInfo("Stopping a boat sandbox", { driverRef, id: sandbox.id });
    yield* api.sandboxes.stop(sandbox.id);
    // boat's own stop runs the pre-stop hook, stops containers and snapshots past our bound;
    // `archiving` is past our stop and unbilled.
    const settleBy = (yield* Clock.currentTimeMillis) + STOP_SETTLE_MS;
    while (true) {
      const current = yield* api.sandboxes.get(sandbox.id);
      if (current === null || STOPPED_STATES.has(current.state)) return;
      if ((yield* Clock.currentTimeMillis) + 1_000 > settleBy) return yield* notYet("stop");
      yield* Effect.sleep("1 second");
    }
  }, bounded("stop"));

  const destroy = Effect.fn("BoatComputeDriver.destroy")(function* (driverRef: string) {
    const sandbox = yield* locate(driverRef);
    if (sandbox === null) return;
    yield* Effect.logInfo("Deleting a boat sandbox", { driverRef, id: sandbox.id });
    yield* api.sandboxes.delete(sandbox.id);
    ids.delete(driverRef);
  }, bounded("destroy"));

  const view = Effect.fn("BoatComputeDriver.view")(function* (sandbox: BoatSandbox) {
    const created = Option.fromNullishOr(sandbox.createdAt).pipe(Option.flatMap(DateTime.make));
    const name = sandbox.name ?? sandbox.id;
    return {
      driverRef: name,
      name,
      sandboxId: parseSandboxTags(sandbox.labels ?? {})?.sandboxId ?? null,
      status: statusOf(sandbox.state),
      createdAt: Option.isSome(created) ? created.value : yield* DateTime.now,
    } satisfies BackendSandbox;
  });

  const status = Effect.fn("BoatComputeDriver.status")(function* (driverRef: string) {
    const sandbox = yield* locate(driverRef);
    if (sandbox !== null) return yield* view(sandbox);
    return {
      driverRef,
      name: driverRef,
      sandboxId: null,
      status: "missing",
      createdAt: yield* DateTime.now,
    } satisfies BackendSandbox;
  }, bounded("status"));

  const list = Effect.fn("BoatComputeDriver.list")(function* (
    tags: Readonly<Record<string, string>>,
  ) {
    if (tags[INSTALL_LABEL] !== undefined && tags[INSTALL_LABEL] !== installId) return [];
    const required = { ...tags, [INSTALL_LABEL]: installId };
    const found: Array<BackendSandbox> = [];
    for (const sandbox of yield* listAll(required)) {
      const labels = sandbox.labels ?? {};
      // `pair.sandbox` leaves out the base builder.
      if (
        labels[SANDBOX_LABEL] === undefined ||
        !Object.entries(required).every(([key, value]) => labels[key] === value)
      ) {
        continue;
      }
      if (sandbox.name != null) ids.set(sandbox.name, sandbox.id);
      found.push(yield* view(sandbox));
    }
    return found;
  }, bounded("list"));

  const deleteImage = Effect.fn("BoatComputeDriver.deleteImage")(function* (imageRef: string) {
    // Saved snapshots carry no labels: a name without this install's prefix is not ours.
    if (!imageRef.startsWith(ownPrefix) || !SAVED_NAME.test(imageRef)) return;
    yield* Effect.logInfo("Deleting a saved snapshot", { image: imageRef });
    yield* api.savedSnapshots.delete(imageRef);
  }, bounded("deleteImage"));

  const snapshot = Effect.fn("BoatComputeDriver.snapshot")(function* (
    driverRef: string,
    snapshotName: string,
  ) {
    const target = teamImageName(installId, snapshotName);
    if (target === null || !SAVED_NAME.test(target.name)) {
      return yield* failure("snapshot", "invalid-request");
    }
    const machine = yield* locate(driverRef);
    while (true) {
      const saved = yield* api.savedSnapshots.get(target.name);
      if (saved !== null) {
        // Never saved over: boat would replace the artifact.
        if (machine !== null && saved.sourceSandboxId !== machine.id) {
          return yield* failure("snapshot", "conflict");
        }
        if (saved.status === "ready") {
          return { imageRef: saved.name, sizeBytes: saved.sizeBytes ?? null };
        }
        if (saved.status === "failed") {
          // The replay saves it again.
          yield* api.savedSnapshots.delete(saved.name);
          return yield* notYet("snapshot");
        }
        yield* Effect.sleep("5 seconds");
        continue;
      }
      if (machine === null) return yield* failure("snapshot", "not-found");
      yield* Effect.logInfo("Saving a team image", {
        driverRef,
        id: machine.id,
        image: target.name,
      });
      // A running machine gets a fresh capture; the build program has finished writing by now.
      yield* api.savedSnapshots.save(machine.id, target.name);
    }
  }, bounded("snapshot"));

  // Saved snapshots leave out /tmp, caches and the Docker build cache, so a file is read from one.
  const readImageFile = Effect.fn("BoatComputeDriver.readImageFile")(function* (
    imageRef: string,
    path: string,
  ) {
    const saved = SAVED_NAME.test(imageRef) ? yield* api.savedSnapshots.get(imageRef) : null;
    if (saved?.snapshotId === undefined || saved.status !== "ready") return null;
    return yield* api.snapshots.readFile(saved.snapshotId, snapshotPath(path));
  }, bounded("readImageFile"));

  const health = Effect.gen(function* () {
    if (!hasApiKey(config)) {
      return yield* failure("health", "auth", { setupHint: NO_KEY_HINT });
    }
    if (!isHttpsUrl(config.runnerUrl)) {
      return yield* failure("health", "invalid-request", { setupHint: RUNNER_URL_HINT });
    }
    // One call proves the key and the plan.
    const limits = yield* api.limits;
    const available = new Set(
      (limits.machineTypes ?? []).filter((type) => type.available).map((type) => type.type),
    );
    if (SANDBOX_SIZES.some((size) => !available.has(typeOf(config, size)))) {
      return yield* failure("health", "quota", { setupHint: PLAN_HINT });
    }
    if (server.guest !== undefined) {
      return {
        isolation: "vm",
        privateNetworkBlock: { applied: false, reason: OUTSIDE_NETWORK },
        baseImage: null,
      } satisfies ComputeDriverHealth;
    }
    const state = yield* builtBaseImage(true);
    return {
      isolation: "vm",
      privateNetworkBlock: { applied: false, reason: OUTSIDE_NETWORK },
      baseImage:
        state._tag === "Ready"
          ? yield* baseImageInfo(state.image)
          : state._tag === "Building"
            ? { pulling: state.ref }
            : { missing: state.ref, hint: state.hint },
    } satisfies ComputeDriverHealth;
  }).pipe(bounded("health"), Effect.withSpan("BoatComputeDriver.health"));

  return ComputeDriver.of({
    driverId,
    kind: "boat",
    capabilities: capabilitiesOf(config),
    create,
    start,
    stop,
    destroy,
    status,
    list,
    deleteImage,
    snapshot,
    readImageFile,
    health,
  });
});

/**
 * The registry factory for `kind: "boat"`. Its credential is the driver's API key, read from the
 * secret store or its secret provider, and only on a cloud-only server.
 */
export const make = Effect.fn("BoatComputeDriver.make")(function* (config: BoatSandboxDriver) {
  const installId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  if (!(yield* ServerConfig).cloudOnly) return unsupportedDriver(config);
  const secrets = yield* SecretResolver.SecretResolver;
  const apiKey = Effect.fn("BoatComputeDriver.apiKey")(
    function* (refresh: boolean) {
      if (refresh && isSecretReference(config.apiKey)) yield* secrets.invalidate([config.apiKey]);
      return yield* requireSettingsSecret(secrets, config.apiKey);
    },
    Effect.mapError(() => new BoatApiError({ endpoint: "API key", failure: "credential" })),
  );
  const client = yield* nodeHttpClient;
  return yield* makeWithApi(
    config,
    installId,
    makeBoatApi(client, {
      apiKey,
      ...(config.organization === undefined ? {} : { organization: config.organization }),
    }),
    { cloudOnly: true, provisionTree: (yield* SandboxProvisionTree).current },
  );
});
