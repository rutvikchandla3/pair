import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import type { EnvironmentId, GceSandboxDriver } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import {
  SandboxProvisionTree,
  type SandboxProvisionTreeInfo,
  type SandboxProvisionTreeUnavailableError,
} from "../image/SandboxProvisionTree.ts";
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
} from "./ComputeDriver.ts";
import {
  type GceApi,
  type GceApiError,
  type GceImage,
  type GceInstance,
  type GceInstanceInsert,
  type GceMetadataItem,
  type GceOperation,
  makeGceApi,
  mapGceError,
  operationError,
} from "./GceApi.ts";
import { makeGceMetadata } from "./GceMetadata.ts";
import {
  baseImagePairVersion,
  stepVmBaseImage,
  type VmBaseImageCloud,
  VmBaseImageConflictError,
  type VmBuilder,
  type VmBuilderLaunch,
  type VmImage,
  type VmImageCapture,
  vmBaseImageNames,
} from "./VmBaseImage.ts";

/** A driver call never runs past this, so it ends inside a sandbox effect's 60-second bound. */
const CALL_DEADLINE = "50 seconds";
const REPLAY_AFTER_MS = 5_000;
const CAPACITY_RETRY_MS = 60_000;
/** The outbox's fourth attempt at a wake that found no capacity. */
const MOVE_AFTER_SECONDS = 180;
const DEFAULT_DISK_GB = 50;
const DEFAULT_MACHINE_TYPES = {
  small: "e2-standard-2",
  default: "e2-standard-4",
  large: "e2-standard-8",
} as const;
/** An auto-mode network has a subnet in every region, so the instance's zone picks it. */
const DEFAULT_NETWORK = "global/networks/default";

const INSTALL_LABEL = "pair-install";
const SANDBOX_LABEL = "pair-sandbox";
const GENERATION_LABEL = "pair-generation";
const CAPACITY_LABEL = "pair-capacity-since";
const MOVE_FROM_LABEL = "pair-move-from";
const MACHINE_TYPE_LABEL = "pair-machine-type";
const TEAM_IMAGE_BUILD_LABEL = "pair-team-image-build";
const TEAM_IMAGE_MACHINE_LABEL = "pair-team-image-machine";
const BOOTSTRAP_KEY = "pair-bootstrap";
const GENERATION_KEY = "pair-generation";

/** Canonical's stock Ubuntu, by family so it is never a deprecated image (D13). */
const BUILDER_SOURCE_IMAGE = "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64";
/** Every machine's disk is at least its image's, so the base stays small; base-build.sh checks room. */
const BUILDER_DISK_GB = 20;
const BUILD_STEP_INTERVAL = "30 seconds";
const PROVISION_RESULT = /pair-provision-result=(\S+)/g;
const BUILD_LOG_LINE = /pair-base-build: .*/g;

const NOT_CLOUD_ONLY =
  "The Google Cloud driver runs only on a Pair Cloud server (started with --cloud-only). On any other server, agents could use this machine's Google Cloud access.";
// The builder is deleted on failure, so its console lines go to this server's log instead.
const buildFailedHint = (step: string) =>
  `The base image build failed at \`${step}\`. The builder's last console lines are in this server's log. Choose Refresh to build it again.`;
const conflictHint = (resource: string) =>
  `\`${resource}\` is in this project but this server did not make it, so it is left alone. Delete or rename it, then choose Refresh.`;
const BASE_IMAGE_SETTING_HINT =
  "The image in this driver's Base image setting was not found, or is not ready. Check its name and project.";
const NO_FIREWALL_CLAIM = "Set by your VPC's firewall rules.";

const SIZES: ComputeCapabilities["sizes"] = [
  { size: "small", vcpus: 2, memoryGb: 8 },
  { size: "default", vcpus: 4, memoryGb: 16 },
  { size: "large", vcpus: 8, memoryGb: 32 },
];

const CAPACITY_CODES = new Set([
  "ZONE_RESOURCE_POOL_EXHAUSTED",
  "ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS",
]);

const CLOUD_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const LABEL_KEY = /^[a-z][a-z0-9_-]{0,62}$/;
const LABEL_VALUE = /^[a-z0-9_-]{0,63}$/;

/** A Compute Engine resource name for `name`, or null when even the mapped name is not one. */
export const cloudSafeName = (name: string): string | null => {
  const mapped = name.toLowerCase().replace(/[_:.]/g, "-");
  return CLOUD_NAME.test(mapped) ? mapped : null;
};

/** `sandboxTags` as labels (`pair.install` is `pair-install`), or null when one cannot be a label. */
const toCloudLabels = (
  tags: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | null => {
  const labels = Object.fromEntries(
    Object.entries(tags).map(([key, value]) => [key.replaceAll(".", "-"), value]),
  );
  return Object.entries(labels).every(
    ([key, value]) => LABEL_KEY.test(key) && LABEL_VALUE.test(value),
  )
    ? labels
    : null;
};

/** The reverse of `toCloudLabels` for `pair-*` keys, so `parseSandboxTags` reads them. */
const fromCloudLabels = (
  labels: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(labels).map(([key, value]) => [key.replace(/^pair-/, "pair."), value]),
  );

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The `pair-bootstrap` metadata value: Docker's `bootstrap.env` lines. Null when a value holds a
 * line break or the runner URL is not http(s), since a VM cannot dial the server's socket.
 */
export const vmBootstrapText = (bootstrap: SandboxBootstrap): string | null => {
  if (!/^https?:\/\//.test(bootstrap.serverUrl)) return null;
  const values = {
    PAIR_RUNNER_URL: bootstrap.serverUrl,
    PAIR_SANDBOX_ID: bootstrap.sandboxId,
    PAIR_RUNNER_BUILD: bootstrap.runnerBuildId,
    PAIR_RUNNER_ENROLL: Redacted.value(bootstrap.enrollmentSecret),
  };
  if (Object.values(values).some((value) => /[\0\n\r]/.test(value))) return null;
  return Object.entries(values)
    .map(([name, value]) => `${name}=${shellQuote(value)}\n`)
    .join("");
};

/**
 * `t3-team-image:14` is `pair-<install8>-team-image-14` in family `pair-<install8>-team-image`;
 * null when the name has no `:<build>` or does not fit a resource name.
 */
export const teamImageName = (
  installId: EnvironmentId,
  snapshotName: string,
): { readonly name: string; readonly family: string; readonly build: string } | null => {
  const colon = snapshotName.lastIndexOf(":");
  if (colon <= 0) return null;
  const family = cloudSafeName(
    `pair-${installId.slice(0, 8)}-${snapshotName.slice(0, colon).replace(/^t3-/, "")}`,
  );
  const build = cloudSafeName(`b${snapshotName.slice(colon + 1)}`)?.slice(1);
  const name = family === null || build === undefined ? null : cloudSafeName(`${family}-${build}`);
  return name === null || family === null || build === undefined ? null : { name, family, build };
};

const statusOf = (status: string): BackendSandboxStatus => {
  switch (status) {
    case "PROVISIONING":
    case "STAGING":
      return "starting";
    case "RUNNING":
    case "STOPPING":
    case "SUSPENDING":
      return "running";
    case "TERMINATED":
    case "STOPPED":
    case "SUSPENDED":
      return "stopped";
    default:
      return "failed";
  }
};

const isStopped = (instance: GceInstance) =>
  instance.status === "TERMINATED" || instance.status === "STOPPED";

const metadataValue = (instance: GceInstance, key: string) =>
  instance.metadata?.items?.find((item) => item.key === key)?.value;

const lastSegment = (link: string) => link.slice(link.lastIndexOf("/") + 1);

const baseImageInfo = (image: GceImage): BaseImageInfo => ({
  ref: image.selfLink,
  digest: image.id,
  version: baseImagePairVersion(image.description),
});

/** An image reference: a self link, `projects/P/global/images/[family/]X`, `global/images/…` or a name. */
const parseImageRef = (
  reference: string,
): { readonly project?: string; readonly name: string; readonly family: boolean } | null => {
  const path = reference.replace(/^https:\/\/(www|compute)\.googleapis\.com\/compute\/v1\//, "");
  const match = /^(?:(?:projects\/([^/]+)\/)?global\/images\/)?(family\/)?([^/]+)$/.exec(path);
  if (match === null || !CLOUD_NAME.test(match[3]!)) return null;
  return {
    ...(match[1] === undefined ? {} : { project: match[1] }),
    name: match[3]!,
    family: match[2] !== undefined,
  };
};

/** One resolution of the base image: a named one, or the one this server builds. */
type BaseImageState =
  | { readonly _tag: "Ready"; readonly image: GceImage }
  | { readonly _tag: "Building"; readonly ref: string }
  | { readonly _tag: "Missing"; readonly ref: string; readonly hint: string };

/** Where the base image build stands; `Failed` is final until `health` starts another. */
type BuildState =
  | { readonly _tag: "Building"; readonly image: string }
  | { readonly _tag: "Ready"; readonly image: GceImage }
  | { readonly _tag: "Failed"; readonly ref: string; readonly hint: string };

/** One build fiber; readers wait for its first decision, never for the whole build. */
interface BuildAttempt {
  readonly state: Ref.Ref<BuildState>;
  readonly decided: Deferred.Deferred<void>;
}

type BaseImage = VmImage & { readonly gce: GceImage };

const vmImage = (image: GceImage): BaseImage => ({
  name: image.name,
  status: image.status === "READY" ? "ready" : image.status === "FAILED" ? "failed" : "pending",
  installId: image.labels?.[INSTALL_LABEL] ?? null,
  createdAtMs: Date.parse(image.creationTimestamp ?? "") || 0,
  gce: image,
});

/** The last `pair-provision-result=` base-build.sh printed, for a stopped builder's lost attributes. */
const serialResult = (output: string) =>
  Array.from(output.matchAll(PROVISION_RESULT)).at(-1)?.[1] ?? null;

const capabilitiesOf = (config: GceSandboxDriver): ComputeCapabilities => {
  const zone = config.zones?.[0];
  return {
    persistentDisk: true,
    memoryOnStop: false,
    snapshot: false,
    imageBuild: "snapshot",
    maxSessionMs: null,
    diskRetentionDays: null,
    isolation: "vm",
    egressRules: "none",
    regions: zone === undefined ? [] : [zone.replace(/-[a-z]$/, "")],
    nestedDocker: true,
    sizes: SIZES,
    defaultRunningCap: 20,
    sleepOnSettle: false,
    defaultIdleSleepMs: 20 * 60_000,
  };
};

/** Off cloud-only every call fails before any network call (the metadata server included). */
const unsupportedDriver = (config: GceSandboxDriver) => {
  const refuse = (operation: ComputeDriverError["operation"]) =>
    Effect.fn(`GceComputeDriver.${operation}`)(() =>
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
    kind: "gce",
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

/** The driver over a Compute Engine client; `make` builds the client from the server VM's identity. */
export const makeWithApi = Effect.fn("GceComputeDriver.makeWithApi")(function* (
  config: GceSandboxDriver,
  installId: EnvironmentId,
  api: GceApi,
  server: {
    readonly cloudOnly: boolean;
    readonly project: Effect.Effect<string, GceApiError>;
    /** Tried in order; the first is where a create lands when it has capacity. */
    readonly zones: Effect.Effect<ReadonlyArray<string>, GceApiError>;
    /** Test only: a `startup-script` for the contract's stand-in guest. Sessions never get one. */
    readonly guest?: { readonly startupScript: string };
    /** What the base image build boots with when `config.baseImage` is unset. */
    readonly provisionTree: Effect.Effect<
      SandboxProvisionTreeInfo,
      SandboxProvisionTreeUnavailableError
    >;
  },
) {
  if (!server.cloudOnly) return unsupportedDriver(config);
  const driverId = config.id;
  const installKey = installId.slice(0, 8);
  const baseFamily = `pair-${installKey}-base`;
  // Where each instance was last seen; asked again when it is not there.
  const zoneOf = yield* Effect.sync(() => new Map<string, string>());

  const failure = (
    operation: ComputeDriverError["operation"],
    reason: ComputeDriverError["reason"],
    extra: { readonly retryable?: boolean; readonly retryAfterMs?: number } = {},
  ) =>
    new ComputeDriverError({
      driverId,
      operation,
      reason,
      retryable: extra.retryable ?? false,
      ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
    });
  const notYet = (operation: ComputeDriverError["operation"]) =>
    failure(operation, "unavailable", { retryable: true, retryAfterMs: REPLAY_AFTER_MS });

  /** Maps Compute Engine failures and ends the call at the deadline; the outbox replays it. */
  const bounded =
    (operation: ComputeDriverError["operation"]) =>
    <A>(effect: Effect.Effect<A, ComputeDriverError | GceApiError>) =>
      effect.pipe(
        Effect.catchTags({
          GceApiError: (error) => Effect.fail(mapGceError(error, { driverId, operation })),
        }),
        Effect.timeoutOrElse({
          duration: CALL_DEADLINE,
          orElse: () => Effect.fail(notYet(operation)),
        }),
      );

  const ours = (labels: Readonly<Record<string, string>> | undefined) =>
    labels?.[INSTALL_LABEL] === installId;
  const regionOf = (zone: string) => zone.replace(/-[a-z]$/, "");
  const kms = config.kmsKey === undefined ? undefined : { kmsKeyName: config.kmsKey };
  const isCapacity = (error: GceApiError | null) =>
    error !== null && error.failure === "operation" && CAPACITY_CODES.has(error.reason ?? "");
  const isConflict = (error: GceApiError) => error.failure === "status" && error.status === 409;
  const isMissing = (error: GceApiError) => error.failure === "status" && error.status === 404;

  /** Follows an operation to `DONE` and answers its failure, if any. */
  const settle = Effect.fn("GceComputeDriver.settle")(function* (
    endpoint: string,
    zone: string | null,
    started: GceOperation,
  ) {
    let operation = started;
    while (operation.status !== "DONE") {
      operation =
        zone === null
          ? yield* api.waitGlobalOperation(operation.name)
          : yield* api.waitZoneOperation(zone, operation.name);
    }
    return operationError(endpoint, operation);
  });
  const settled = (endpoint: string, zone: string | null) => (started: GceOperation) =>
    settle(endpoint, zone, started).pipe(
      Effect.flatMap((error) => (error === null ? Effect.void : Effect.fail(error))),
    );

  const locate = Effect.fn("GceComputeDriver.locate")(function* (name: string) {
    const zones = yield* server.zones;
    const known = zoneOf.get(name);
    const order = known === undefined ? zones : [known, ...zones.filter((zone) => zone !== known)];
    for (const zone of order) {
      const instance = yield* api.instances.get(zone, name);
      if (instance !== null) {
        zoneOf.set(name, zone);
        return { zone, instance };
      }
    }
    zoneOf.delete(name);
    return null;
  });

  const nameFor = (operation: ComputeDriverError["operation"], reference: string) => {
    const name = cloudSafeName(reference);
    return name === null
      ? Effect.fail(failure(operation, "invalid-request"))
      : Effect.succeed(name);
  };
  const bootstrapFor = (
    operation: ComputeDriverError["operation"],
    bootstrap: SandboxBootstrap,
  ) => {
    const text = vmBootstrapText(bootstrap);
    return text === null
      ? Effect.fail(failure(operation, "invalid-request"))
      : Effect.succeed(text);
  };

  const bootstrapItems = (text: string, generation: number): ReadonlyArray<GceMetadataItem> => [
    { key: BOOTSTRAP_KEY, value: text },
    { key: GENERATION_KEY, value: String(generation) },
  ];
  const insertItems = (text: string, generation: number): ReadonlyArray<GceMetadataItem> => [
    ...bootstrapItems(text, generation),
    { key: "block-project-ssh-keys", value: "TRUE" },
    { key: "enable-oslogin", value: "FALSE" },
    { key: "serial-port-enable", value: "FALSE" },
    ...(server.guest === undefined
      ? []
      : [{ key: "startup-script", value: server.guest.startupScript }]),
  ];

  const insertBody = (input: {
    readonly zone: string;
    readonly name: string;
    readonly machineType: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly source: { readonly sourceImage: string } | { readonly sourceSnapshot: string };
    readonly items: ReadonlyArray<GceMetadataItem>;
    readonly diskGb?: number;
  }): GceInstanceInsert => ({
    name: input.name,
    machineType: `zones/${input.zone}/machineTypes/${input.machineType}`,
    labels: input.labels,
    ...(config.networkTags === undefined || config.networkTags.length === 0
      ? {}
      : { tags: { items: config.networkTags } }),
    disks: [
      {
        boot: true,
        autoDelete: true,
        type: "PERSISTENT",
        initializeParams: {
          ...input.source,
          diskSizeGb: String(input.diskGb ?? config.diskGb ?? DEFAULT_DISK_GB),
          diskType: `zones/${input.zone}/diskTypes/pd-balanced`,
          labels: input.labels,
        },
        ...(kms === undefined ? {} : { diskEncryptionKey: kms }),
      },
    ],
    // No accessConfigs: a machine never has an external address.
    networkInterfaces: [
      config.subnetwork === undefined
        ? { network: DEFAULT_NETWORK }
        : { subnetwork: config.subnetwork },
    ],
    // No identity: a machine can never act as a service account.
    serviceAccounts: [],
    metadata: { items: input.items },
    shieldedInstanceConfig: { enableVtpm: true, enableIntegrityMonitoring: true },
    // A restarted machine could not enroll again: its secret is spent.
    scheduling: { automaticRestart: false, onHostMaintenance: "MIGRATE" },
    canIpForward: false,
    deletionProtection: false,
  });

  /**
   * Inserts in each zone in order until one has capacity. A 409 means an earlier attempt landed.
   * Only a finished operation's stockout moves on: a refused request may still have landed.
   */
  const insertInZones = Effect.fn("GceComputeDriver.insertInZones")(function* (
    operation: "create" | "start",
    zones: ReadonlyArray<string>,
    body: (zone: string) => GceInstanceInsert,
  ) {
    let stockout: GceApiError | null = null;
    for (const zone of zones) {
      const started = yield* api.instances
        .insert(zone, body(zone))
        .pipe(Effect.catchIf(isConflict, () => Effect.succeed(null)));
      const error =
        started === null ? null : yield* settle("POST /zones/{zone}/instances", zone, started);
      if (isCapacity(error)) {
        stockout = error;
        continue;
      }
      if (error !== null) return yield* error;
      zoneOf.set(body(zone).name, zone);
      return zone;
    }
    return yield* stockout === null
      ? failure(operation, "capacity", { retryable: true, retryAfterMs: CAPACITY_RETRY_MS })
      : mapGceError(stockout, { driverId, operation });
  });

  // The base image this server builds itself when `config.baseImage` is unset (D13).
  const builderMachineType = config.machineTypes?.small ?? DEFAULT_MACHINE_TYPES.small;
  const notOurs = (resource: string) => new VmBaseImageConflictError({ resource });
  const isRefused = (error: GceApiError) =>
    error.failure === "status" && (error.status === 400 || error.status === 404);

  const builderResult = Effect.fn("GceComputeDriver.builderResult")(function* (
    zone: string,
    name: string,
    stopped: boolean,
  ) {
    const attributes = yield* api.instances
      .getGuestAttributes(zone, name, "pair/")
      .pipe(Effect.catchIf(isRefused, () => Effect.succeed([])));
    const reported = attributes.find(
      (entry) => entry.namespace === "pair" && entry.key === "provision",
    )?.value;
    if (reported !== undefined) return reported;
    if (!stopped) return null;
    // A stopped machine may have lost its attributes; base-build.sh prints its result on the console too.
    return serialResult(yield* builderConsole(zone, name));
  });
  const builderConsole = (zone: string, name: string) =>
    api.instances
      .getSerialPortOutput(zone, name)
      .pipe(Effect.catchIf(isRefused, () => Effect.succeed("")));

  /** One build's view of the cloud; `publish` lets readers go as soon as the image is found or not. */
  const baseImageCloud = (
    imageName: string,
    publish: (state: BuildState) => Effect.Effect<void>,
  ): VmBaseImageCloud<BaseImage, GceApiError | ComputeDriverError | VmBaseImageConflictError> => {
    // The result `findBuilder` last read, so a builder deleted short of `ok` leaves its console in the log.
    let lastResult: string | null = null;
    return {
      findImage: Effect.fn("GceComputeDriver.findBaseImage")(function* (name: string) {
        const image = yield* api.images.get(name);
        // A foreign image is a conflict, which the step answers next.
        if (image === null || ours(image.labels)) {
          yield* publish(
            image?.status === "READY"
              ? { _tag: "Ready", image }
              : { _tag: "Building", image: imageName },
          );
        }
        return image === null ? null : vmImage(image);
      }),
      listImages: Effect.fn("GceComputeDriver.listBaseImages")(function* (family: string) {
        const images: Array<BaseImage> = [];
        let pageToken: string | undefined;
        do {
          const page = yield* api.images.list({
            filter: `(labels.${INSTALL_LABEL} = "${installId}")`,
            ...(pageToken === undefined ? {} : { pageToken }),
          });
          images.push(...page.items.filter((image) => image.family === family).map(vmImage));
          pageToken = page.nextPageToken ?? undefined;
        } while (pageToken !== undefined);
        return images;
      }),
      deleteImage: Effect.fn("GceComputeDriver.deleteBaseImage")(function* (name: string) {
        const image = yield* api.images.get(name);
        if (image === null) return;
        if (!ours(image.labels)) return yield* notOurs(name);
        yield* Effect.logInfo("Deleting a base image", { image: name, status: image.status });
        yield* api.images.delete(name).pipe(
          Effect.flatMap(settled("DELETE /global/images/{name}", null)),
          Effect.catchIf(isMissing, () => Effect.void),
        );
      }),
      findBuilder: Effect.fn("GceComputeDriver.findBuilder")(function* (name: string) {
        const found = yield* locate(name);
        if (found === null) return null;
        const { zone, instance } = found;
        const status = statusOf(instance.status);
        const state =
          status === "stopped" ? "stopped" : status === "starting" ? "starting" : "running";
        const createdAtMs = Date.parse(instance.creationTimestamp ?? "");
        // A foreign machine's guest is never read.
        lastResult = ours(instance.labels)
          ? yield* builderResult(zone, name, state === "stopped")
          : null;
        return {
          name,
          installId: instance.labels?.[INSTALL_LABEL] ?? null,
          state,
          createdAtMs: Number.isNaN(createdAtMs) ? 0 : createdAtMs,
          result: lastResult,
        } satisfies VmBuilder;
      }),
      launchBuilder: Effect.fn("GceComputeDriver.launchBuilder")(function* (
        input: VmBuilderLaunch,
      ) {
        yield* Effect.logInfo("Launching the base image builder", {
          builder: input.name,
          image: imageName,
        });
        // No bootstrap and no identity: the builder reaches nothing of ours.
        yield* insertInZones("create", yield* server.zones, (zone) =>
          insertBody({
            zone,
            name: input.name,
            machineType: builderMachineType,
            // No `pair-sandbox` label, so `list` and the reconciler never see it.
            labels: { [INSTALL_LABEL]: installId },
            source: { sourceImage: BUILDER_SOURCE_IMAGE },
            diskGb: BUILDER_DISK_GB,
            items: [
              { key: "startup-script", value: input.startupScript },
              ...Object.entries(input.metadata).map(([key, value]) => ({ key, value })),
              { key: "enable-guest-attributes", value: "TRUE" },
              { key: "block-project-ssh-keys", value: "TRUE" },
              { key: "enable-oslogin", value: "FALSE" },
              { key: "serial-port-enable", value: "FALSE" },
            ],
          }),
        );
      }),
      captureImage: Effect.fn("GceComputeDriver.captureBaseImage")(function* (
        input: VmImageCapture,
      ) {
        const found = yield* locate(input.builder);
        if (found === null) return;
        if (!ours(found.instance.labels)) return yield* notOurs(input.builder);
        const disk = found.instance.disks?.find((entry) => entry.boot === true)?.source;
        if (disk === undefined) return;
        yield* Effect.logInfo("Capturing the base image from its builder", {
          builder: input.builder,
          image: input.name,
        });
        yield* api.images
          .insert({
            name: input.name,
            sourceDisk: disk,
            family: input.family,
            description: input.description,
            labels: { [INSTALL_LABEL]: installId },
            storageLocations: [regionOf(found.zone)],
            ...(kms === undefined ? {} : { imageEncryptionKey: kms }),
          })
          .pipe(
            Effect.flatMap(settled("POST /global/images", null)),
            Effect.catchIf(isConflict, () => Effect.void),
          );
      }),
      deleteBuilder: Effect.fn("GceComputeDriver.deleteBuilder")(function* (name: string) {
        const found = yield* locate(name);
        if (found === null) return;
        if (!ours(found.instance.labels)) return yield* notOurs(name);
        if (lastResult !== "ok") {
          const output = yield* builderConsole(found.zone, name);
          yield* Effect.logWarning("The base image builder's last console lines", {
            builder: name,
            result: lastResult,
            lines: Array.from(output.matchAll(BUILD_LOG_LINE), (line) => line[0].trim()).slice(-20),
          });
        }
        yield* Effect.logInfo("Deleting the base image builder", { builder: name });
        yield* api.instances.delete(found.zone, name).pipe(
          Effect.flatMap(settled("DELETE /zones/{zone}/instances/{name}", found.zone)),
          Effect.catchIf(isMissing, () => Effect.void),
        );
        zoneOf.delete(name);
      }),
    };
  };

  /** Steps the build every 30 seconds until the image is ready and settled, or the build fails. */
  const runBuild = Effect.fn("GceComputeDriver.buildBaseImage")(function* (attempt: BuildAttempt) {
    let shown = "";
    const publish = Effect.fn("GceComputeDriver.publishBaseImageState")(function* (
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
          // A cloud error is tried again next step; the same one is logged once.
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
            yield* publish({ _tag: "Ready", image: state.image.gce });
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

  const startBuild = Effect.fn("GceComputeDriver.startBaseImageBuild")(function* () {
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
  const builtBaseImage = Effect.fn("GceComputeDriver.builtBaseImage")(function* (
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

  if (config.baseImage === undefined) yield* currentBuild();

  const resolveBaseImage = Effect.fn("GceComputeDriver.resolveBaseImage")(function* (
    retryFailedBuild: boolean,
  ) {
    if (config.baseImage === undefined) return yield* builtBaseImage(retryFailedBuild);
    const reference = parseImageRef(config.baseImage);
    if (reference === null) {
      return { _tag: "Missing", ref: config.baseImage, hint: BASE_IMAGE_SETTING_HINT } as const;
    }
    const image = reference.family
      ? yield* api.images.getFromFamily(reference.name, reference.project)
      : yield* api.images.get(reference.name, reference.project);
    return image === null || image.status !== "READY"
      ? ({ _tag: "Missing", ref: config.baseImage, hint: BASE_IMAGE_SETTING_HINT } as const)
      : ({ _tag: "Ready", image } as const);
  });

  const bootImage = Effect.fn("GceComputeDriver.bootImage")(function* (
    requested: ComputeDriverCreateInput["image"],
  ) {
    if (requested.type === "build") {
      const reference = parseImageRef(requested.imageRef);
      const image =
        reference === null || reference.family
          ? null
          : yield* api.images.get(reference.name, reference.project);
      if (image === null || image.status !== "READY") {
        return yield* failure("create", "not-found");
      }
      return { sourceImage: image.selfLink, baseImage: null };
    }
    const state: BaseImageState = yield* resolveBaseImage(false);
    switch (state._tag) {
      case "Ready":
        // A machine boots from the image it resolved, never from a family that could move.
        return { sourceImage: state.image.selfLink, baseImage: baseImageInfo(state.image) };
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

  /** Stops and answers once the instance is `TERMINATED`; null when it is gone. */
  const stopInstance = Effect.fn("GceComputeDriver.stopInstance")(function* (
    zone: string,
    name: string,
  ) {
    while (true) {
      const instance = yield* api.instances.get(zone, name);
      if (instance === null || isStopped(instance)) return instance;
      if (instance.status === "STOPPING") {
        yield* Effect.sleep("2 seconds");
        continue;
      }
      yield* api.instances
        .stop(zone, name)
        .pipe(Effect.flatMap(settled("POST /instances/{name}/stop", zone)));
    }
  });

  /** Deletes the zone move's snapshot when it is this install's. */
  const deleteMoveSnapshot = Effect.fn("GceComputeDriver.deleteMoveSnapshot")(function* (
    name: string,
  ) {
    const snapshot = yield* api.snapshots.get(`${name}-move`);
    if (snapshot === null || !ours(snapshot.labels)) return;
    yield* api.snapshots.delete(snapshot.name).pipe(
      Effect.flatMap(settled("DELETE /global/snapshots/{name}", null)),
      Effect.catchIf(isMissing, () => Effect.void),
    );
  });

  const sandboxLabels = (labels: Readonly<Record<string, string>> | undefined) =>
    Object.fromEntries(
      Object.entries(labels ?? {}).filter(
        ([key]) => key !== CAPACITY_LABEL && key !== MOVE_FROM_LABEL && key !== MACHINE_TYPE_LABEL,
      ),
    );

  /** Inserts the moved instance from its snapshot in the zones after the one it left. */
  const finishMove = Effect.fn("GceComputeDriver.finishMove")(function* (
    name: string,
    snapshot: { readonly selfLink: string; readonly labels?: Readonly<Record<string, string>> },
    text: string,
    generation: number,
  ) {
    const zones = yield* server.zones;
    const from = snapshot.labels?.[MOVE_FROM_LABEL] ?? "";
    const index = zones.indexOf(from);
    const order = [...zones.slice(index + 1), ...zones.slice(0, Math.max(index, 0))].filter(
      (zone) => zone !== from,
    );
    const labels = sandboxLabels(snapshot.labels);
    yield* insertInZones("start", order, (zone) =>
      insertBody({
        zone,
        name,
        machineType: snapshot.labels?.[MACHINE_TYPE_LABEL] ?? DEFAULT_MACHINE_TYPES.default,
        labels,
        source: { sourceSnapshot: snapshot.selfLink },
        items: insertItems(text, generation),
      }),
    );
    yield* deleteMoveSnapshot(name);
  });

  /** Snapshots the disk, deletes the instance and inserts it again in the next zone. */
  const moveZone = Effect.fn("GceComputeDriver.moveZone")(function* (
    zone: string,
    instance: GceInstance,
    text: string,
    generation: number,
  ) {
    const name = instance.name;
    const snapshotName = `${name}-move`;
    let snapshot = yield* api.snapshots.get(snapshotName);
    if (snapshot === null) {
      const disk = lastSegment(
        instance.disks?.find((entry) => entry.boot === true)?.source ?? name,
      );
      yield* api.disks
        .createSnapshot(zone, disk, {
          name: snapshotName,
          labels: {
            ...sandboxLabels(instance.labels),
            [MOVE_FROM_LABEL]: zone,
            [MACHINE_TYPE_LABEL]: lastSegment(
              instance.machineType ?? DEFAULT_MACHINE_TYPES.default,
            ),
          },
          storageLocations: [regionOf(zone)],
          ...(kms === undefined ? {} : { snapshotEncryptionKey: kms }),
        })
        .pipe(
          Effect.flatMap(settled("POST /zones/{zone}/disks/{disk}/createSnapshot", zone)),
          Effect.catchIf(isConflict, () => Effect.void),
        );
      snapshot = yield* api.snapshots.get(snapshotName);
    }
    if (snapshot === null || !ours(snapshot.labels)) return yield* failure("start", "conflict");
    while (snapshot.status !== "READY") {
      if (snapshot.status === "FAILED") return yield* failure("start", "unavailable");
      yield* Effect.sleep("5 seconds");
      snapshot = yield* api.snapshots.get(snapshotName);
      if (snapshot === null) return yield* notYet("start");
    }
    yield* api.instances.delete(zone, name).pipe(
      Effect.flatMap(settled("DELETE /zones/{zone}/instances/{name}", zone)),
      Effect.catchIf(isMissing, () => Effect.void),
    );
    zoneOf.delete(name);
    yield* finishMove(name, snapshot, text, generation);
  });

  /** Boots a found instance with this bootstrap; a replay of a booted generation does nothing. */
  const boot = Effect.fn("GceComputeDriver.boot")(function* (
    zone: string,
    found: GceInstance,
    bootstrap: SandboxBootstrap,
    text: string,
  ) {
    const name = found.name;
    let instance = found;
    if (!isStopped(instance)) {
      // A replay must not restart a healthy runner of the same generation.
      if (
        metadataValue(instance, GENERATION_KEY) === String(bootstrap.generation) &&
        statusOf(instance.status) !== "failed" &&
        instance.status !== "STOPPING"
      ) {
        yield* deleteMoveSnapshot(name);
        return;
      }
      const stopped = yield* stopInstance(zone, name);
      if (stopped === null) return yield* failure("start", "not-found");
      instance = stopped;
    }
    const keys = new Set([BOOTSTRAP_KEY, GENERATION_KEY]);
    yield* api.instances
      .setMetadata(zone, name, {
        fingerprint: instance.metadata?.fingerprint ?? "",
        items: [
          ...(instance.metadata?.items ?? []).filter((item) => !keys.has(item.key)),
          ...bootstrapItems(text, bootstrap.generation),
        ],
      })
      .pipe(Effect.flatMap(settled("POST /instances/{name}/setMetadata", zone)));
    const error = yield* api.instances
      .start(zone, name)
      .pipe(Effect.flatMap((started) => settle("POST /instances/{name}/start", zone, started)));
    if (isCapacity(error)) {
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const since = Number(instance.labels?.[CAPACITY_LABEL] ?? Number.NaN);
      if (!Number.isFinite(since)) {
        yield* api.instances
          .setLabels(zone, name, {
            labels: { ...instance.labels, [CAPACITY_LABEL]: String(now) },
            labelFingerprint: instance.labelFingerprint ?? "",
          })
          .pipe(Effect.flatMap(settled("POST /instances/{name}/setLabels", zone)));
      } else if (now - since >= MOVE_AFTER_SECONDS && (yield* server.zones).length > 1) {
        return yield* moveZone(zone, instance, text, bootstrap.generation);
      }
      return yield* failure("start", "capacity", {
        retryable: true,
        retryAfterMs: CAPACITY_RETRY_MS,
      });
    }
    if (error !== null) return yield* error;
    if (instance.labels?.[CAPACITY_LABEL] !== undefined) {
      const current = yield* api.instances.get(zone, name);
      if (current !== null) {
        yield* api.instances
          .setLabels(zone, name, {
            labels: sandboxLabels(current.labels),
            labelFingerprint: current.labelFingerprint ?? "",
          })
          .pipe(Effect.flatMap(settled("POST /instances/{name}/setLabels", zone)));
      }
    }
    yield* deleteMoveSnapshot(name);
  });

  const create = Effect.fn("GceComputeDriver.create")(function* (input: ComputeDriverCreateInput) {
    const name = yield* nameFor("create", input.name);
    const labels = toCloudLabels(input.tags);
    if (labels === null || labels[INSTALL_LABEL] !== installId) {
      return yield* failure("create", "invalid-request");
    }
    const text = yield* bootstrapFor("create", input.bootstrap);
    const { sourceImage, baseImage } = yield* bootImage(input.image);
    const found = yield* locate(name);
    if (found !== null) {
      const existing = found.instance.labels ?? {};
      if (
        !ours(existing) ||
        existing[SANDBOX_LABEL] !== labels[SANDBOX_LABEL] ||
        existing[GENERATION_LABEL] !== labels[GENERATION_LABEL]
      ) {
        return yield* failure("create", "conflict");
      }
      if (isStopped(found.instance)) yield* boot(found.zone, found.instance, input.bootstrap, text);
      return { driverRef: name, baseImage };
    }
    const machineType = config.machineTypes?.[input.size] ?? DEFAULT_MACHINE_TYPES[input.size];
    yield* insertInZones("create", yield* server.zones, (zone) =>
      insertBody({
        zone,
        name,
        machineType,
        labels,
        source: { sourceImage },
        items: insertItems(text, input.bootstrap.generation),
      }),
    );
    return { driverRef: name, baseImage };
  }, bounded("create"));

  const start = Effect.fn("GceComputeDriver.start")(function* (
    driverRef: string,
    bootstrap: SandboxBootstrap,
  ) {
    const name = yield* nameFor("start", driverRef);
    const text = yield* bootstrapFor("start", bootstrap);
    const found = yield* locate(name);
    if (found === null) {
      // A zone move that deleted the instance resumes at the insert.
      const snapshot = yield* api.snapshots.get(`${name}-move`);
      if (snapshot !== null && ours(snapshot.labels) && snapshot.status === "READY") {
        return yield* finishMove(name, snapshot, text, bootstrap.generation);
      }
      return yield* failure("start", "not-found");
    }
    if (!ours(found.instance.labels)) return yield* failure("start", "invalid-request");
    yield* boot(found.zone, found.instance, bootstrap, text);
  }, bounded("start"));

  const stop = Effect.fn("GceComputeDriver.stop")(function* (driverRef: string) {
    const name = yield* nameFor("stop", driverRef);
    const found = yield* locate(name);
    if (found === null) return yield* failure("stop", "not-found");
    if (!ours(found.instance.labels)) return yield* failure("stop", "invalid-request");
    yield* stopInstance(found.zone, name);
  }, bounded("stop"));

  const destroy = Effect.fn("GceComputeDriver.destroy")(function* (driverRef: string) {
    const name = cloudSafeName(driverRef);
    if (name === null) return;
    const found = yield* locate(name);
    if (found !== null) {
      // A shared project holds others' instances: delete only this install's.
      if (!ours(found.instance.labels)) return yield* failure("destroy", "invalid-request");
      yield* api.instances.delete(found.zone, name).pipe(
        Effect.flatMap(settled("DELETE /zones/{zone}/instances/{name}", found.zone)),
        Effect.catchIf(isMissing, () => Effect.void),
      );
      zoneOf.delete(name);
    }
    yield* deleteMoveSnapshot(name);
  }, bounded("destroy"));

  const view = Effect.fn("GceComputeDriver.view")(function* (instance: GceInstance) {
    const now = yield* DateTime.now;
    return {
      driverRef: instance.name,
      name: instance.name,
      sandboxId: parseSandboxTags(fromCloudLabels(instance.labels ?? {}))?.sandboxId ?? null,
      status: statusOf(instance.status),
      createdAt: Option.getOrElse(
        instance.creationTimestamp === undefined
          ? Option.none()
          : DateTime.make(instance.creationTimestamp),
        () => now,
      ),
    } satisfies BackendSandbox;
  });

  const status = Effect.fn("GceComputeDriver.status")(function* (driverRef: string) {
    const name = cloudSafeName(driverRef);
    const found = name === null ? null : yield* locate(name);
    if (found !== null) return yield* view(found.instance);
    return {
      driverRef,
      name: name ?? driverRef,
      sandboxId: null,
      status: "missing",
      createdAt: yield* DateTime.now,
    } satisfies BackendSandbox;
  }, bounded("status"));

  const list = Effect.fn("GceComputeDriver.list")(function* (
    tags: Readonly<Record<string, string>>,
  ) {
    const wanted = toCloudLabels(tags);
    if (wanted === null) return yield* failure("list", "invalid-request");
    if (wanted[INSTALL_LABEL] !== undefined && wanted[INSTALL_LABEL] !== installId) return [];
    // The install label is always required, and `pair-sandbox` leaves out the base builder.
    const required = { ...wanted, [INSTALL_LABEL]: installId };
    const filter = [
      ...Object.entries(required).map(([key, value]) => `(labels.${key} = "${value}")`),
      `(labels.${SANDBOX_LABEL}:*)`,
    ].join(" ");
    const found: Array<BackendSandbox> = [];
    for (const zone of yield* server.zones) {
      let pageToken: string | undefined;
      do {
        const page = yield* api.instances.list(zone, {
          filter,
          ...(pageToken === undefined ? {} : { pageToken }),
        });
        for (const instance of page.items) {
          const labels = instance.labels ?? {};
          if (
            labels[SANDBOX_LABEL] === undefined ||
            !Object.entries(required).every(([key, value]) => labels[key] === value)
          ) {
            continue;
          }
          zoneOf.set(instance.name, zone);
          found.push(yield* view(instance));
        }
        pageToken = page.nextPageToken ?? undefined;
      } while (pageToken !== undefined);
    }
    return found;
  }, bounded("list"));

  const deleteImage = Effect.fn("GceComputeDriver.deleteImage")(function* (imageRef: string) {
    const reference = parseImageRef(imageRef) ?? parseImageRef(cloudSafeName(imageRef) ?? "");
    if (reference === null || reference.family) {
      return yield* failure("deleteImage", "invalid-request");
    }
    if (reference.project !== undefined && reference.project !== (yield* server.project)) {
      return yield* failure("deleteImage", "invalid-request");
    }
    const image = yield* api.images.get(reference.name);
    if (image === null) return;
    // A shared project holds others' images: delete only this install's.
    if (!ours(image.labels)) return yield* failure("deleteImage", "invalid-request");
    yield* api.images.delete(image.name).pipe(
      Effect.flatMap(settled("DELETE /global/images/{name}", null)),
      Effect.catchIf(isMissing, () => Effect.void),
    );
  }, bounded("deleteImage"));

  const snapshot = Effect.fn("GceComputeDriver.snapshot")(function* (
    driverRef: string,
    snapshotName: string,
  ) {
    const machine = yield* nameFor("snapshot", driverRef);
    const target = teamImageName(installId, snapshotName);
    if (target === null) return yield* failure("snapshot", "invalid-request");
    const labels = {
      [INSTALL_LABEL]: installId,
      [TEAM_IMAGE_BUILD_LABEL]: target.build,
      [TEAM_IMAGE_MACHINE_LABEL]: machine,
    };
    const made = (image: GceImage) =>
      Object.entries(labels).every(([key, value]) => image.labels?.[key] === value);
    while (true) {
      const image = yield* api.images.get(target.name);
      if (image !== null) {
        if (!made(image)) return yield* failure("snapshot", "conflict");
        if (image.status === "READY") {
          const size = Number(image.archiveSizeBytes);
          return { imageRef: image.selfLink, sizeBytes: Number.isFinite(size) ? size : null };
        }
        if (image.status === "FAILED") {
          // The replay inserts it again.
          yield* api.images.delete(image.name).pipe(
            Effect.flatMap(settled("DELETE /global/images/{name}", null)),
            Effect.catchIf(isMissing, () => Effect.void),
          );
          return yield* notYet("snapshot");
        }
        yield* Effect.sleep("5 seconds");
        continue;
      }
      const found = yield* locate(machine);
      if (found === null) return yield* failure("snapshot", "not-found");
      if (!ours(found.instance.labels)) return yield* failure("snapshot", "invalid-request");
      const stopped = yield* stopInstance(found.zone, machine);
      const disk = stopped?.disks?.find((entry) => entry.boot === true)?.source;
      if (disk === undefined) return yield* failure("snapshot", "not-found");
      yield* api.images
        .insert({
          name: target.name,
          sourceDisk: disk,
          family: target.family,
          labels,
          storageLocations: [regionOf(found.zone)],
          ...(kms === undefined ? {} : { imageEncryptionKey: kms }),
        })
        .pipe(
          Effect.flatMap(settled("POST /global/images", null)),
          Effect.catchIf(isConflict, () => Effect.void),
        );
    }
  }, bounded("snapshot"));

  const health = Effect.gen(function* () {
    const zones = yield* server.zones;
    // One call proves the token, the API and the project.
    yield* api.instances.list(zones[0] ?? "", {
      filter: `(labels.${INSTALL_LABEL} = "${installId}")`,
      maxResults: 1,
    });
    const state: BaseImageState = yield* resolveBaseImage(true);
    return {
      isolation: "vm",
      privateNetworkBlock: { applied: false, reason: NO_FIREWALL_CLAIM },
      baseImage:
        state._tag === "Ready"
          ? baseImageInfo(state.image)
          : state._tag === "Building"
            ? { pulling: state.ref }
            : { missing: state.ref, hint: state.hint },
    } satisfies ComputeDriverHealth;
  }).pipe(bounded("health"), Effect.withSpan("GceComputeDriver.health"));

  return ComputeDriver.of({
    driverId,
    kind: "gce",
    capabilities: capabilitiesOf(config),
    create,
    start,
    stop,
    destroy,
    status,
    list,
    deleteImage,
    snapshot,
    // An image is the whole disk, so it holds every write.
    readImageFile: Effect.fn("GceComputeDriver.readImageFile")(() =>
      Effect.succeed("whole-disk" as const),
    ),
    health,
  });
});

// node:http, not undici: a single executable cannot import the undici the server keeps external.
const nodeHttpClient = NodeHttpClient.makeAgent(undefined).pipe(
  Effect.flatMap((agent) =>
    NodeHttpClient.makeNodeHttp.pipe(Effect.provideService(NodeHttpClient.HttpAgent, agent)),
  ),
);

/**
 * The registry factory for `kind: "gce"`. Its only credential is the server VM's service account,
 * read from the metadata server, and only on a cloud-only server.
 */
export const make = Effect.fn("GceComputeDriver.make")(function* (config: GceSandboxDriver) {
  const installId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  if (!(yield* ServerConfig).cloudOnly) return unsupportedDriver(config);
  const client = yield* nodeHttpClient;
  const metadata = yield* makeGceMetadata(client);
  const project =
    config.project === undefined ? metadata.projectId : Effect.succeed(config.project);
  const zones: Effect.Effect<ReadonlyArray<string>, GceApiError> = config.zones === undefined
    ? metadata.zone.pipe(Effect.map((zone) => [zone]))
    : Effect.succeed(config.zones);
  return yield* makeWithApi(config, installId, makeGceApi(client, metadata, project), {
    cloudOnly: true,
    project,
    zones,
    provisionTree: (yield* SandboxProvisionTree).current,
  });
});
