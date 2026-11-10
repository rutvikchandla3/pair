import {
  type SandboxDriverHealth,
  type SandboxBaseImageInfo,
  type SandboxDriverIsolation,
  type SandboxOverview as SandboxOverviewResult,
  SandboxOverviewError,
  type TeamImageCurrentBase,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import packageJson from "../../../package.json" with { type: "json" };
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type {
  ComputeCapabilities,
  ComputeDriver,
  ComputeDriverError,
  ComputeDriverHealth,
} from "../compute/ComputeDriver.ts";
import { ComputeDriverRegistry } from "../compute/ComputeDriverRegistry.ts";
import { DEFAULT_BASE_IMAGE_REPOSITORY } from "../image/SandboxBaseImage.ts";
import { CheckpointMirror } from "../mirror/CheckpointMirror.ts";
import { STARTS_PER_MINUTE } from "./SandboxAdmission.ts";
import { SandboxRestoreMode } from "./SandboxRestoreMode.ts";

/** A Docker host that does not answer must not hold the page. */
const HEALTH_TIMEOUT = "10 seconds";

export class SandboxOverview extends Context.Service<
  SandboxOverview,
  { readonly read: Effect.Effect<SandboxOverviewResult, SandboxOverviewError> }
>()("t3/sandbox/lifecycle/SandboxOverview") {}

const isolationOf = (isolation: ComputeCapabilities["isolation"]): SandboxDriverIsolation => {
  switch (isolation) {
    case "container":
      return "runc";
    case "rootless-container":
      return "rootless";
    case "gvisor":
      return "gvisor";
    default:
      return "unknown";
  }
};

// The driver's own message names its operation; this one says what to check, never the host.
const unreachableMessage = (error: ComputeDriverError): string => {
  switch (error.reason) {
    case "unsupported":
      return "This Docker host is not supported. Use a unix:// socket or tcp://.";
    case "invalid-request":
      return "This Docker host's settings are incomplete, such as DOCKER_CERT_PATH missing ca.pem, cert.pem or key.pem.";
    case "auth":
      return "Docker refused this server's credentials.";
    default:
      return "Docker is not reachable from this server.";
  }
};

const baseImageMessage = (baseImage: ComputeDriverHealth["baseImage"]): string | undefined => {
  if (baseImage === null) return undefined;
  if ("pulling" in baseImage) return "Downloading the base image.";
  if ("missing" in baseImage) return `Machine image not found. ${baseImage.hint}`;
  return undefined;
};

/** `None` is a timeout. */
const probeHealth = (driver: ComputeDriver["Service"]) =>
  driver.health.pipe(Effect.timeoutOption(HEALTH_TIMEOUT), Effect.result);

const resolvedImage = (baseImage: ComputeDriverHealth["baseImage"]): SandboxBaseImageInfo | null =>
  baseImage !== null && "digest" in baseImage ? baseImage : null;

/** The base this driver resolved, or null while it is pulling, missing or unreachable. */
export const driverBaseImage = Effect.fn("SandboxOverview.driverBaseImage")(function* (
  driver: ComputeDriver["Service"],
) {
  const health = yield* probeHealth(driver);
  return health._tag === "Success" && health.success._tag === "Some"
    ? resolvedImage(health.success.value.baseImage)
    : null;
});

/** What a new machine would boot: the driver's resolved image, else the override, else this version's. */
export const currentBaseImage = (input: {
  readonly resolved: SandboxBaseImageInfo | null | undefined;
  /** `ServerSettings.sandbox.baseImage`. */
  readonly override: string | undefined;
  /** The server's package version. */
  readonly version: string;
}): TeamImageCurrentBase =>
  input.resolved != null
    ? input.resolved
    : input.override !== undefined
      ? { ref: input.override, digest: null, version: null }
      : {
          ref: `${DEFAULT_BASE_IMAGE_REPOSITORY}:${input.version}`,
          digest: null,
          version: input.version,
        };

const driverHealth = Effect.fn("SandboxOverview.driverHealth")(function* (
  driver: ComputeDriver["Service"],
  runningCap: number,
) {
  const health = yield* probeHealth(driver);
  const base = { driverId: driver.driverId, runningCap };
  if (health._tag === "Failure" || health.success._tag === "None") {
    const report: SandboxDriverHealth = {
      ...base,
      reachable: false,
      isolation: "unknown",
      message:
        health._tag === "Failure"
          ? unreachableMessage(health.failure)
          : "Docker did not answer in time.",
    };
    return { report, baseImage: null };
  }
  const { isolation, baseImage } = health.success.value;
  const message = baseImageMessage(baseImage);
  const report: SandboxDriverHealth = {
    ...base,
    reachable: true,
    isolation: isolationOf(isolation),
    ...(message === undefined ? {} : { message }),
  };
  return { report, baseImage: resolvedImage(baseImage) };
});

const make = Effect.gen(function* () {
  const registry = yield* ComputeDriverRegistry;
  const settings = yield* ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const mirror = yield* CheckpointMirror;
  const restoreMode = yield* SandboxRestoreMode;
  const version = packageJson.version;

  const read = Effect.gen(function* () {
    const drivers = yield* registry.list;
    const { baseImage: override, restoreModeSince } = (yield* settings.getSettings).sandbox ?? {};
    const healths = yield* Effect.forEach(
      drivers,
      (driver) =>
        registry
          .runningCap(driver.driverId)
          .pipe(Effect.flatMap((runningCap) => driverHealth(driver, runningCap))),
      { concurrency: "unbounded" },
    );
    const machines = yield* projections.countSandboxStates;
    const mirrorBytes = yield* mirror.diskBytes;
    const current = currentBaseImage({
      resolved: healths.flatMap((entry) => (entry.baseImage === null ? [] : [entry.baseImage]))[0],
      override,
      version,
    });
    const configured = new Set(drivers.map((driver) => driver.driverId));
    const stopped =
      restoreModeSince === undefined
        ? []
        : (yield* restoreMode.machines).filter((machine) => configured.has(machine.driverId));
    const baseImage = {
      ref: current.ref,
      label:
        current.version !== null ? `Pair base ${current.version}` : `Base image ${current.ref}`,
    };
    return {
      drivers: healths.map((entry) => entry.report),
      machines,
      startsPerMinute: STARTS_PER_MINUTE,
      baseImage,
      mirrorBytes,
      ...(restoreModeSince === undefined
        ? {}
        : { restoreMode: { since: restoreModeSince, machines: stopped } }),
    } satisfies SandboxOverviewResult;
  }).pipe(
    Effect.mapError((cause) => new SandboxOverviewError({ cause })),
    Effect.withSpan("SandboxOverview.read"),
  );

  return SandboxOverview.of({ read });
});

export const layer = Layer.effect(SandboxOverview, make);
