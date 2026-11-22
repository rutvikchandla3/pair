// @effect-diagnostics nodeBuiltinImport:off - the base template's name hashes its image and entrypoint.
import * as NodeCrypto from "node:crypto";

import {
  type Agent37SandboxDriver,
  type EnvironmentId,
  isSecretReference,
  type SandboxSize,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { AGENT37_MACHINE_SPECS, sandboxDriverSizes } from "@t3tools/shared/sandbox";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import packageJson from "../../../package.json" with { type: "json" };
import { ServerConfig } from "../../config.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import { requireSettingsSecret } from "../../secrets/settingsSecretValue.ts";
import { SANDBOX_ROOT } from "../../workspaceHost/WorkspaceHost.ts";
import { DEFAULT_BASE_IMAGE_REPOSITORY } from "../image/SandboxBaseImage.ts";
import {
  type Agent37Api,
  Agent37ApiError,
  type Agent37Instance,
  type Agent37InstanceType,
  type Agent37Region,
  type Agent37Resources,
  type Agent37Template,
  makeAgent37Api,
  mapAgent37Error,
} from "./Agent37Api.ts";
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
import { nodeHttpClient, teamImageName, vmBootstrapText } from "./vmHelpers.ts";

/** A driver call never runs past this, so it ends inside a sandbox effect's 60-second bound. */
const CALL_DEADLINE_MS = 50_000;
/** What `awaitReady` leaves of the deadline for the bootstrap's delivery. */
const DELIVERY_RESERVE_MS = 8_000;
const REPLAY_AFTER_MS = 5_000;
/** How long `stop` waits for Agent37 to read `stopped`. */
const STOP_SETTLE_MS = 10_000;
const REGISTER_RETRY = "30 seconds";
/** How long a reader waits on the base image's copy before hearing it is still under way. */
const SLOW_IMPORT = "5 seconds";

const INSTALL_TAG = "pair.install";
const SANDBOX_TAG = "pair.sandbox";
const GENERATION_TAG = "pair.generation";
/** On a team image's instance: the image name, and the machine it was forked from. */
const IMAGE_TAG = "pair.image";
const IMAGE_SOURCE_TAG = "pair.image-source";

/** Each size gets its shape's largest disk on the default type; a fork may need more. */
const DISK_GB: Readonly<Record<SandboxSize, number>> = { small: 12, default: 20, large: 40 };

/**
 * The template's entrypoint for Pair's sandbox image. Agent37 boots it with no bootstrap, so it
 * clears the last boot's runner state and waits for the driver's delivery. A runner that exits
 * stays down until the next delivery, as `Restart=no` leaves a VM's.
 */
const BOOT_SCRIPT = [
  "d=/etc/pair-runner",
  "r=/run/pair-runner",
  'rm -f "$d/bootstrap.env" "$d/.bootstrap.env" "$d/generation"',
  "while :; do",
  '  rm -rf "$r"',
  '  install -d -m 0711 "$r"',
  '  while [ ! -s "$d/bootstrap.env" ]; do sleep 1; done',
  '  /usr/local/bin/pair-bootstrap || echo "pair-agent37: the runner exited ($?)" >&2',
  "done",
].join("\n");
const ENTRYPOINT = ["/usr/bin/tini", "-g", "--", "/bin/sh", "-c", BOOT_SCRIPT] as const;

/**
 * One root exec that hands this boot's bootstrap to the entrypoint. The secret rides in the
 * command, base64 so no quoting can break it; a runner of this generation that enrolled is kept.
 */
export const deliveryCommand = (generation: number, bootstrapText: string) =>
  [
    "set -eu",
    `g=${generation}`,
    "d=/etc/pair-runner",
    'if [ "$(cat "$d/generation" 2>/dev/null || true)" = "$g" ] && [ -s /run/pair-runner/token ]; then exit 0; fi',
    "umask 077",
    'mkdir -p "$d"',
    `printf %s '${Buffer.from(bootstrapText, "utf8").toString("base64")}' | base64 -d >"$d/.bootstrap.env"`,
    'printf "%s\\n" "$g" >"$d/generation"',
    'chmod 0644 "$d/generation"',
    'mv -f "$d/.bootstrap.env" "$d/bootstrap.env"',
  ].join("; ");

const BOOT_LOG_LINE = /pair-agent37: .*/g;

const STARTING_STATES = new Set(["provisioning", "starting", "restarting", "updating", "waking"]);
/** Nothing runs; `start` brings each back. A sleeper only sleeps if someone else slept it. */
const STOPPED_STATES = new Set(["stopped", "sleeping"]);

const NOT_CLOUD_ONLY =
  "The Agent37 driver runs only on a Pair Cloud server (started with --cloud-only). On any other server, agents could use this machine's Agent37 workspace.";
const NO_KEY_HINT = "Paste an Agent37 API key.";
const RUNNER_URL_HINT =
  "Set the Runner URL to an https:// address Agent37 machines reach: this server's public address, or a public hostname for its runner listener.";
const REGION_HINT =
  "Agent37 runs only VM instances outside the US. Set Instance type to VM, or the region to US.";
const importFailedHint = (imageRef: string) =>
  `Agent37 could not import ${imageRef}. It must be a public linux/amd64 image of at most 8 GB. Set Base image in this driver's settings, then choose Test.`;
const conflictHint = (name: string) =>
  `The template \`${name}\` is in this Agent37 workspace but holds another image, so it is left alone. Delete it, then choose Test.`;

/** The workspace template for an image: a changed image or entrypoint registers a new one. */
export const agent37BaseTemplateName = (installId: EnvironmentId, imageRef: string) =>
  `pair-${installId.slice(0, 8).toLowerCase()}-base-${NodeCrypto.createHash("sha256")
    .update([imageRef, ...ENTRYPOINT].join("\0"))
    .digest("hex")
    .slice(0, 12)}`;

/** An https URL: the secret and token cross the internet. */
const isHttpsUrl = (value: string | undefined) => {
  if (value === undefined) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const hasApiKey = (config: Agent37SandboxDriver) =>
  isSecretReference(config.apiKey) || config.apiKey.trim() !== "";

const placementOf = (config: Agent37SandboxDriver) => {
  const region: Agent37Region = config.region ?? "us";
  const type: Agent37InstanceType = config.instanceType ?? "default";
  // `eu` and `ap-south` refuse a `default` create.
  return { region, type, valid: region === "us" || type !== "default" };
};

const resourcesOf = (size: SandboxSize): Agent37Resources => ({
  cpu: AGENT37_MACHINE_SPECS[size].vcpus,
  memory: AGENT37_MACHINE_SPECS[size].memoryGb,
  disk: DISK_GB[size],
});

/** Our tags are metadata strings; anything else there is not ours. */
const tagsOf = (instance: Agent37Instance): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(instance.metadata ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

const statusOf = (status: string): BackendSandboxStatus => {
  if (STARTING_STATES.has(status)) return "starting";
  if (status === "running") return "running";
  if (status === "stopping" || STOPPED_STATES.has(status)) return "stopped";
  if (status === "failed") return "failed";
  return "missing";
};

const capabilitiesOf = (config: Agent37SandboxDriver): ComputeCapabilities => {
  const { region, type } = placementOf(config);
  return {
    persistentDisk: true,
    // `stop` drops memory; the driver never sleeps a machine (decision 10).
    memoryOnStop: false,
    snapshot: false,
    imageBuild: "snapshot",
    maxSessionMs: null,
    diskRetentionDays: null,
    isolation: type === "vm" ? "vm" : "gvisor",
    egressRules: "none",
    regions: [region],
    // The image runs no Docker daemon of its own.
    nestedDocker: false,
    sizes: sandboxDriverSizes(config),
    // A topped-up workspace may run 40 GB at once: five Medium machines.
    defaultRunningCap: 5,
    discardOnArchive: true,
    defaultIdleSleepMs: 20 * 60_000,
  };
};

/** Off cloud-only every call fails before any call to Agent37. */
const unsupportedDriver = (config: Agent37SandboxDriver) => {
  const refuse = (operation: ComputeDriverError["operation"]) =>
    Effect.fn(`Agent37ComputeDriver.${operation}`)(() =>
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
    kind: "agent37",
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

/** Where the base template stands; `Failed` is final until `health` starts another attempt. */
type BaseState =
  | { readonly _tag: "Registering"; readonly ref: string }
  | { readonly _tag: "Ready"; readonly template: string; readonly info: BaseImageInfo }
  | { readonly _tag: "Failed"; readonly ref: string; readonly hint: string };

/** One registration fiber; readers wait for its first decision, never for the whole copy. */
interface Registration {
  readonly state: Ref.Ref<BaseState>;
  readonly decided: Deferred.Deferred<void>;
}

/** The driver over an Agent37 client; `make` builds the client from the driver's API key. */
export const makeWithApi = Effect.fn("Agent37ComputeDriver.makeWithApi")(function* (
  config: Agent37SandboxDriver,
  installId: EnvironmentId,
  api: Agent37Api,
  server: {
    readonly cloudOnly: boolean;
    /** The server's version, which names the published sandbox image. */
    readonly version: string;
    /**
     * Test only: machines boot this stock template, nothing is registered, and delivery runs this
     * command in place of the bootstrap hand-off. Sessions never get one.
     */
    readonly guest?: {
      readonly template: string;
      readonly command: (generation: number, bootstrapText: string) => string;
    };
  },
) {
  if (!server.cloudOnly) return unsupportedDriver(config);
  const driverId = config.id;
  const install8 = installId.slice(0, 8).toLowerCase();
  const ownPrefix = `pair-${install8}-`;
  const basePrefix = `pair-${install8}-base-`;
  const placement = placementOf(config);
  const imageRef = config.baseImage ?? `${DEFAULT_BASE_IMAGE_REPOSITORY}:${server.version}`;
  const baseTemplate = agent37BaseTemplateName(installId, imageRef);
  // Agent37's id for each name, asked again when it is not there.
  const ids = new Map<string, string>();

  const failure = (
    operation: ComputeDriverError["operation"],
    reason: ComputeDriverError["reason"],
    extra: { readonly setupHint?: string } = {},
  ) =>
    new ComputeDriverError({
      driverId,
      operation,
      reason,
      retryable: false,
      ...(extra.setupHint === undefined ? {} : { setupHint: extra.setupHint }),
    });
  const notYet = (operation: ComputeDriverError["operation"]) =>
    new ComputeDriverError({
      driverId,
      operation,
      reason: "unavailable",
      retryable: true,
      retryAfterMs: REPLAY_AFTER_MS,
    });

  /** Maps Agent37 failures and ends the call at the deadline; the outbox replays it. */
  const bounded =
    (operation: ComputeDriverError["operation"]) =>
    <A>(effect: Effect.Effect<A, ComputeDriverError | Agent37ApiError>) =>
      effect.pipe(
        Effect.catchTags({
          Agent37ApiError: (error) => Effect.fail(mapAgent37Error(error, { driverId, operation })),
        }),
        Effect.timeoutOrElse({
          duration: CALL_DEADLINE_MS,
          orElse: () => Effect.fail(notYet(operation)),
        }),
        Effect.mapError((error) =>
          operation === "start" || operation === "stop" ? wakeFailure(error) : error,
        ),
      );

  const ours = (instance: Agent37Instance) => tagsOf(instance)[INSTALL_TAG] === installId;
  const createdSeconds = (instance: Agent37Instance) => instance.created ?? 0;
  const deadlineFrom = (startedMs: number) => startedMs + CALL_DEADLINE_MS - DELIVERY_RESERVE_MS;

  /** This install's instances named `name`, oldest first. */
  const named = Effect.fn("Agent37ComputeDriver.named")(function* (name: string) {
    return (yield* api.instances.list)
      .filter((instance) => instance.name === name && ours(instance))
      .toSorted((a, b) => createdSeconds(a) - createdSeconds(b));
  });

  /**
   * This install's instance of `name`, or null. Agent37 has no idempotency key, so a create the
   * deadline cut short can leave a second one; the oldest is the machine.
   */
  const locate = Effect.fn("Agent37ComputeDriver.locate")(function* (name: string) {
    const known = ids.get(name);
    if (known !== undefined) {
      const instance = yield* api.instances.get(known);
      if (instance !== null && instance.name === name && ours(instance)) return instance;
      ids.delete(name);
    }
    const oldest = (yield* named(name))[0];
    if (oldest === undefined) return null;
    ids.set(name, oldest.id);
    return oldest;
  });

  /** Deletes the copies a cut-short create left beside `keep`. */
  const dropDuplicates = Effect.fn("Agent37ComputeDriver.dropDuplicates")(function* (
    name: string,
    keep: string,
  ) {
    const extra = (yield* named(name)).filter((instance) => instance.id !== keep);
    if (extra.length === 0) return;
    yield* Effect.logWarning("Deleting Agent37 instances that repeat a machine's name", {
      name,
      ids: extra.map((instance) => instance.id),
    });
    yield* Effect.forEach(extra, (instance) => api.instances.delete(instance.id), {
      discard: true,
    });
  });

  /** Reads the instance every second until it runs, while the deadline leaves time to deliver. */
  // Untraced: one span per poll would be noise.
  const awaitReady = Effect.fnUntraced(function* (
    operation: "create" | "start",
    id: string,
    deadlineMs: number,
  ) {
    while (true) {
      const instance = yield* api.instances.get(id);
      if (instance === null) return yield* notYet(operation);
      if (instance.status === "running") return instance;
      if (!STARTING_STATES.has(instance.status)) return yield* notYet(operation);
      if ((yield* Clock.currentTimeMillis) + 1_000 > deadlineMs) return yield* notYet(operation);
      yield* Effect.sleep("1 second");
    }
  });

  /** Hands this boot's bootstrap to the entrypoint, which starts the runner with it. */
  const deliver = Effect.fn("Agent37ComputeDriver.deliver")(function* (
    operation: "create" | "start",
    instance: Agent37Instance,
    bootstrap: SandboxBootstrap,
  ) {
    const text = vmBootstrapText(bootstrap);
    if (text === null) return yield* failure(operation, "invalid-request");
    const command =
      server.guest?.command(bootstrap.generation, text) ??
      deliveryCommand(bootstrap.generation, text);
    const result = yield* api.instances.exec(instance.id, command);
    if (result.exit_code === 0) return;
    // Only its own lines: nothing else of the command's output reaches the log.
    yield* Effect.logWarning("The Agent37 bootstrap hand-off failed", {
      id: instance.id,
      exitCode: result.exit_code,
      lines: Array.from((result.stderr ?? "").matchAll(BOOT_LOG_LINE), (line) => line[0]),
    });
    return yield* notYet(operation);
  });

  /** Brings a stopped, sleeping or failed instance up, waits for it and delivers. */
  const boot = Effect.fn("Agent37ComputeDriver.boot")(function* (
    operation: "create" | "start",
    instance: Agent37Instance,
    bootstrap: SandboxBootstrap,
    deadlineMs: number,
  ) {
    if (instance.status === "stopping") return yield* notYet(operation);
    if (STOPPED_STATES.has(instance.status) || instance.status === "failed") {
      yield* Effect.logInfo("Starting an Agent37 instance", {
        driverRef: instance.name,
        id: instance.id,
      });
      yield* api.instances.start(instance.id);
    }
    const ready = yield* awaitReady(operation, instance.id, deadlineMs);
    yield* deliver(operation, ready, bootstrap);
  });

  // The base template. Agent37 copies the image into its storage before it answers, which can
  // take minutes, so the copy runs in its own fiber and callers read where it stands.
  const registerScope = yield* Effect.scope;
  const registerLock = yield* Semaphore.make(1);
  // Only touched while holding `registerLock`.
  let registration: Registration | undefined;

  const readyState = (template: Agent37Template): BaseState => ({
    _tag: "Ready",
    template: template.name,
    info: {
      ref: imageRef,
      digest: template.image_digest ?? template.name,
      version: config.baseImage === undefined ? server.version : null,
    },
  });

  /** Older base templates of this install; machines made from them keep their image. */
  const dropOldTemplates = Effect.fn("Agent37ComputeDriver.dropOldTemplates")(function* () {
    const old = (yield* api.templates.list).filter(
      (template) => template.name.startsWith(basePrefix) && template.name !== baseTemplate,
    );
    for (const template of old) {
      yield* Effect.logInfo("Deleting an old base template", { template: template.name });
      yield* api.templates.delete(template.name);
    }
  });

  const runRegistration = Effect.fn("Agent37ComputeDriver.registerBaseTemplate")(function* (
    attempt: Registration,
  ) {
    const publish = (state: BaseState) =>
      Ref.set(attempt.state, state).pipe(
        Effect.andThen(Deferred.succeed(attempt.decided, undefined)),
      );
    let warned = "";
    while (true) {
      const step = yield* Effect.result(
        Effect.gen(function* () {
          const existing = yield* api.templates.get(baseTemplate);
          if (existing !== null && existing.image_ref != null && existing.image_ref !== imageRef) {
            return { _tag: "Conflict" } as const;
          }
          if (existing?.image_digest != null) return { _tag: "Ready", template: existing } as const;
          // Another attempt is copying it.
          if (existing !== null) return { _tag: "Pending" } as const;
          yield* Effect.logInfo("Importing the base image into Agent37", {
            image: imageRef,
            template: baseTemplate,
          });
          // Readers wait for a quick copy, and hear a slow one is under way.
          const announce = yield* Effect.sleep(SLOW_IMPORT).pipe(
            Effect.andThen(publish({ _tag: "Registering", ref: imageRef })),
            Effect.forkChild({ startImmediately: true }),
          );
          const created = yield* api.templates
            .create({
              name: baseTemplate,
              image_ref: imageRef,
              description: `Pair sandbox image ${imageRef}`,
              entrypoint: ENTRYPOINT,
            })
            .pipe(
              Effect.asSome,
              Effect.catchIf(
                (error) => error.failure === "status" && error.code === "template_conflict",
                () => Effect.succeed(Option.none<Agent37Template>()),
              ),
              Effect.ensuring(Fiber.interrupt(announce)),
            );
          return Option.isSome(created) && created.value.image_digest != null
            ? ({ _tag: "Ready", template: created.value } as const)
            : ({ _tag: "Pending" } as const);
        }),
      );
      if (step._tag === "Success") {
        switch (step.success._tag) {
          case "Conflict":
            yield* Effect.logWarning("A base template of this name holds another image", {
              template: baseTemplate,
            });
            return yield* publish({
              _tag: "Failed",
              ref: imageRef,
              hint: conflictHint(baseTemplate),
            });
          case "Ready":
            yield* dropOldTemplates().pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not delete old base templates", cause),
              ),
            );
            yield* Effect.logInfo("The base template is ready", { template: baseTemplate });
            return yield* publish(readyState(step.success.template));
          case "Pending":
            yield* publish({ _tag: "Registering", ref: imageRef });
            break;
        }
      } else {
        const mapped = mapAgent37Error(step.failure, { driverId, operation: "health" });
        if (!mapped.retryable) {
          yield* Effect.logWarning("The base template could not be registered", {
            image: imageRef,
            status: step.failure.status,
            code: step.failure.code,
          });
          return yield* publish({
            _tag: "Failed",
            ref: imageRef,
            hint:
              mapped.setupHint ??
              (mapped.reason === "invalid-request" ? importFailedHint(imageRef) : mapped.message),
          });
        }
        // The same failure is logged once.
        if (step.failure.message !== warned) {
          warned = step.failure.message;
          yield* Effect.logWarning("A base template step failed; trying again", {
            status: step.failure.status,
            code: step.failure.code,
          });
        }
        yield* publish({ _tag: "Registering", ref: imageRef });
      }
      yield* Effect.sleep(REGISTER_RETRY);
    }
  });

  const startRegistration = Effect.fn("Agent37ComputeDriver.startBaseTemplateRegistration")(
    function* () {
      const attempt = {
        state: yield* Ref.make<BaseState>({ _tag: "Registering", ref: imageRef }),
        decided: yield* Deferred.make<void>(),
      } satisfies Registration;
      yield* runRegistration(attempt).pipe(
        Effect.ensuring(Deferred.succeed(attempt.decided, undefined)),
        Effect.forkIn(registerScope),
      );
      return attempt;
    },
  );

  /** The current registration, or a new one in place of `failed`. */
  const currentRegistration = (failed?: Registration) =>
    registerLock.withPermits(1)(
      Effect.gen(function* () {
        if (registration === undefined || registration === failed) {
          registration = yield* startRegistration();
        }
        return registration;
      }),
    );

  /** With `retryFailed`, a failure is answered once and the next attempt starts behind it. */
  const baseState = Effect.fn("Agent37ComputeDriver.baseState")(function* (retryFailed: boolean) {
    const current = yield* currentRegistration();
    yield* Deferred.await(current.decided);
    const state = yield* Ref.get(current.state);
    if (retryFailed && state._tag === "Failed") yield* currentRegistration(current);
    return state;
  });

  // A test guest boots a stock template, so nothing is registered.
  if (server.guest === undefined) yield* currentRegistration();

  /** This install's team image of `name`, or null. */
  const findImage = Effect.fn("Agent37ComputeDriver.findImage")(function* (name: string) {
    return (yield* named(name)).find((instance) => tagsOf(instance)[IMAGE_TAG] === name) ?? null;
  });

  /** What a create boots: a template, or a team image's instance to fork. */
  const bootSource = Effect.fn("Agent37ComputeDriver.bootSource")(function* (
    requested: ComputeDriverCreateInput["image"],
  ) {
    if (server.guest !== undefined) {
      return { _tag: "Template", template: server.guest.template, baseImage: null } as const;
    }
    if (requested.type === "build") {
      const image = requested.imageRef.startsWith(ownPrefix)
        ? yield* findImage(requested.imageRef)
        : null;
      if (image === null || image.status === "failed") return yield* failure("create", "not-found");
      return { _tag: "Fork", image, baseImage: null } as const;
    }
    const state = yield* baseState(false);
    switch (state._tag) {
      case "Ready":
        return { _tag: "Template", template: state.template, baseImage: state.info } as const;
      case "Registering":
        return yield* new ComputeDriverError({
          driverId,
          operation: "create",
          reason: "unavailable",
          retryable: true,
          image: { ref: state.ref, state: "pulling" },
        });
      case "Failed":
        return yield* new ComputeDriverError({
          driverId,
          operation: "create",
          reason: "not-found",
          retryable: false,
          image: { ref: state.ref, state: "missing", hint: state.hint },
        });
    }
  });

  const create = Effect.fn("Agent37ComputeDriver.create")(function* (
    input: ComputeDriverCreateInput,
  ) {
    const deadlineMs = deadlineFrom(yield* Clock.currentTimeMillis);
    if (
      input.tags[INSTALL_TAG] !== installId ||
      !isHttpsUrl(config.runnerUrl) ||
      !hasApiKey(config) ||
      !placement.valid ||
      vmBootstrapText(input.bootstrap) === null
    ) {
      return yield* failure("create", "invalid-request");
    }
    const source = yield* bootSource(input.image);

    const matches = (instance: Agent37Instance) =>
      tagsOf(instance)[SANDBOX_TAG] === input.tags[SANDBOX_TAG] &&
      tagsOf(instance)[GENERATION_TAG] === input.tags[GENERATION_TAG];
    let instance = yield* locate(input.name);
    if (instance !== null && !matches(instance)) return yield* failure("create", "conflict");
    if (instance === null) {
      const resources = resourcesOf(input.size);
      instance =
        source._tag === "Template"
          ? yield* api.instances.create({
              template: source.template,
              type: placement.type,
              region: placement.region,
              resources,
              name: input.name,
              metadata: input.tags,
              // The disk Agent37 bills and keeps: every machine's checkouts live under it.
              mount_path: SANDBOX_ROOT,
              auto_sleep: false,
            })
          : yield* api.instances.fork(source.image.id, {
              name: input.name,
              metadata: input.tags,
              // A fork's disk can only match or grow its source's.
              resources: {
                ...resources,
                disk: Math.max(resources.disk, source.image.resources?.disk ?? 0),
              },
            });
      yield* Effect.logInfo("Created an Agent37 instance", {
        driverRef: input.name,
        id: instance.id,
      });
      ids.set(input.name, instance.id);
    }
    yield* boot("create", instance, input.bootstrap, deadlineMs);
    yield* dropDuplicates(input.name, instance.id);
    return { driverRef: input.name, baseImage: source.baseImage };
  }, bounded("create"));

  const start = Effect.fn("Agent37ComputeDriver.start")(function* (
    driverRef: string,
    bootstrap: SandboxBootstrap,
  ) {
    const deadlineMs = deadlineFrom(yield* Clock.currentTimeMillis);
    if (vmBootstrapText(bootstrap) === null) return yield* failure("start", "invalid-request");
    const instance = yield* locate(driverRef);
    if (instance === null) return yield* failure("start", "not-found");
    yield* boot("start", instance, bootstrap, deadlineMs);
  }, bounded("start"));

  const stop = Effect.fn("Agent37ComputeDriver.stop")(function* (driverRef: string) {
    const instance = yield* locate(driverRef);
    if (instance === null) return yield* failure("stop", "not-found");
    // Nothing runs on a sleeper or a failed one, and stopping either can refuse.
    if (STOPPED_STATES.has(instance.status) || instance.status === "failed") return;
    if (instance.status === "running") {
      yield* Effect.logInfo("Stopping an Agent37 instance", { driverRef, id: instance.id });
      if ((yield* api.instances.stop(instance.id)) === "stopped") return;
    } else if (instance.status !== "stopping") {
      return yield* notYet("stop");
    }
    const settleBy = (yield* Clock.currentTimeMillis) + STOP_SETTLE_MS;
    while (true) {
      const current = yield* api.instances.get(instance.id);
      if (current === null || current.status === "stopped") return;
      if ((yield* Clock.currentTimeMillis) + 1_000 > settleBy) return yield* notYet("stop");
      yield* Effect.sleep("1 second");
    }
  }, bounded("stop"));

  const destroy = Effect.fn("Agent37ComputeDriver.destroy")(function* (driverRef: string) {
    // Every copy of the name, so a cut-short create's duplicate goes too.
    for (const instance of yield* named(driverRef)) {
      yield* Effect.logInfo("Deleting an Agent37 instance", { driverRef, id: instance.id });
      yield* api.instances.delete(instance.id);
    }
    ids.delete(driverRef);
  }, bounded("destroy"));

  const view = Effect.fn("Agent37ComputeDriver.view")(function* (instance: Agent37Instance) {
    const name = instance.name ?? instance.id;
    const created =
      instance.created == null ? Option.none() : DateTime.make(instance.created * 1000);
    return {
      driverRef: name,
      name,
      sandboxId: parseSandboxTags(tagsOf(instance))?.sandboxId ?? null,
      status: statusOf(instance.status),
      createdAt: Option.isSome(created) ? created.value : yield* DateTime.now,
    } satisfies BackendSandbox;
  });

  const status = Effect.fn("Agent37ComputeDriver.status")(function* (driverRef: string) {
    const instance = yield* locate(driverRef);
    if (instance !== null) return yield* view(instance);
    return {
      driverRef,
      name: driverRef,
      sandboxId: null,
      status: "missing",
      createdAt: yield* DateTime.now,
    } satisfies BackendSandbox;
  }, bounded("status"));

  const list = Effect.fn("Agent37ComputeDriver.list")(function* (
    tags: Readonly<Record<string, string>>,
  ) {
    if (tags[INSTALL_TAG] !== undefined && tags[INSTALL_TAG] !== installId) return [];
    const required = { ...tags, [INSTALL_TAG]: installId };
    const found = new Map<string, Agent37Instance>();
    // Oldest first, so a name's machine is the one `locate` answers.
    for (const instance of (yield* api.instances.list).toSorted(
      (a, b) => createdSeconds(a) - createdSeconds(b),
    )) {
      const instanceTags = tagsOf(instance);
      // `pair.sandbox` leaves out team images.
      if (
        instanceTags[SANDBOX_TAG] === undefined ||
        instance.name == null ||
        found.has(instance.name) ||
        !Object.entries(required).every(([key, value]) => instanceTags[key] === value)
      ) {
        continue;
      }
      ids.set(instance.name, instance.id);
      found.set(instance.name, instance);
    }
    return yield* Effect.forEach(found.values(), view);
  }, bounded("list"));

  const deleteImage = Effect.fn("Agent37ComputeDriver.deleteImage")(function* (imageRef: string) {
    // A name without this install's prefix is not ours.
    if (!imageRef.startsWith(ownPrefix)) return;
    const image = yield* findImage(imageRef);
    if (image === null) return;
    yield* Effect.logInfo("Deleting a team image", { image: imageRef, id: image.id });
    yield* api.instances.delete(image.id);
  }, bounded("deleteImage"));

  /**
   * A team image is a stopped fork of the machine: a fork copies its whole disk, and a create
   * from the image forks that again.
   */
  const snapshot = Effect.fn("Agent37ComputeDriver.snapshot")(function* (
    driverRef: string,
    snapshotName: string,
  ) {
    const target = teamImageName(installId, snapshotName);
    if (target === null) return yield* failure("snapshot", "invalid-request");
    const machine = yield* locate(driverRef);
    while (true) {
      const image = yield* findImage(target.name);
      if (image !== null) {
        // Never forked over: the name is the image.
        if (machine !== null && tagsOf(image)[IMAGE_SOURCE_TAG] !== driverRef) {
          return yield* failure("snapshot", "conflict");
        }
        if (image.status === "stopped") return { imageRef: target.name, sizeBytes: null };
        if (image.status === "failed") {
          // The replay forks it again.
          yield* api.instances.delete(image.id);
          return yield* notYet("snapshot");
        }
        if (image.status === "running") yield* api.instances.stop(image.id);
        else yield* Effect.sleep("2 seconds");
        continue;
      }
      if (machine === null) return yield* failure("snapshot", "not-found");
      yield* Effect.logInfo("Forking a team image", {
        driverRef,
        id: machine.id,
        image: target.name,
      });
      // The build program has finished writing by now; the fork copies the disk as it is.
      yield* api.instances.fork(machine.id, {
        name: target.name,
        metadata: {
          [INSTALL_TAG]: installId,
          [IMAGE_TAG]: target.name,
          [IMAGE_SOURCE_TAG]: driverRef,
        },
      });
    }
  }, bounded("snapshot"));

  // A fork holds the machine's whole disk, so every file the build wrote is in it.
  const readImageFile = Effect.fn("Agent37ComputeDriver.readImageFile")(function* (
    imageRef: string,
    _path: string,
  ) {
    const image = imageRef.startsWith(ownPrefix) ? yield* findImage(imageRef) : null;
    return image === null || image.status === "failed" ? null : ("whole-disk" as const);
  }, bounded("readImageFile"));

  const health = Effect.gen(function* () {
    if (!hasApiKey(config)) {
      return yield* failure("health", "auth", { setupHint: NO_KEY_HINT });
    }
    if (!isHttpsUrl(config.runnerUrl)) {
      return yield* failure("health", "invalid-request", { setupHint: RUNNER_URL_HINT });
    }
    if (!placement.valid) {
      return yield* failure("health", "invalid-request", { setupHint: REGION_HINT });
    }
    // One call proves the key and the wallet.
    if ((yield* api.billing).past_due === true) {
      return yield* mapAgent37Error(
        new Agent37ApiError({ endpoint: "GET /billing", failure: "status", status: 402 }),
        { driverId, operation: "health" },
      );
    }
    const isolation = placement.type === "vm" ? "vm" : "gvisor";
    // Agent37 never lets an instance reach a private range, another instance or its host.
    const privateNetworkBlock = { applied: true } as const;
    if (server.guest !== undefined) {
      return { isolation, privateNetworkBlock, baseImage: null } satisfies ComputeDriverHealth;
    }
    const state = yield* baseState(true);
    return {
      isolation,
      privateNetworkBlock,
      baseImage:
        state._tag === "Ready"
          ? state.info
          : state._tag === "Registering"
            ? { pulling: state.ref }
            : { missing: state.ref, hint: state.hint },
    } satisfies ComputeDriverHealth;
  }).pipe(bounded("health"), Effect.withSpan("Agent37ComputeDriver.health"));

  return ComputeDriver.of({
    driverId,
    kind: "agent37",
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
 * The registry factory for `kind: "agent37"`. Its credential is the driver's API key, read from
 * the secret store or its secret provider, and only on a cloud-only server.
 */
export const make = Effect.fn("Agent37ComputeDriver.make")(function* (
  config: Agent37SandboxDriver,
) {
  const installId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  if (!(yield* ServerConfig).cloudOnly) return unsupportedDriver(config);
  const secrets = yield* SecretResolver.SecretResolver;
  const apiKey = Effect.fn("Agent37ComputeDriver.apiKey")(
    function* (refresh: boolean) {
      if (refresh && isSecretReference(config.apiKey)) yield* secrets.invalidate([config.apiKey]);
      return yield* requireSettingsSecret(secrets, config.apiKey);
    },
    Effect.mapError(() => new Agent37ApiError({ endpoint: "API key", failure: "credential" })),
  );
  const client = yield* nodeHttpClient;
  return yield* makeWithApi(config, installId, makeAgent37Api(client, { apiKey }), {
    cloudOnly: true,
    version: packageJson.version,
  });
});
