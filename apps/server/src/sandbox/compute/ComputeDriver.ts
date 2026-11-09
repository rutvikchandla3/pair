import {
  ComputeDriverId,
  type ComputeDriverKind,
  EnvironmentId,
  NonNegativeInt,
  SandboxId,
  type SandboxSize,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const ComputeDriverErrorReason = Schema.Literals([
  "not-found",
  "conflict",
  "capacity",
  "quota",
  "rate-limited",
  "auth",
  "invalid-request",
  "unsupported",
  "unavailable",
]);
export type ComputeDriverErrorReason = typeof ComputeDriverErrorReason.Type;

// 04 §6's `detail` is dropped: effect-services.md forbids copying cause text into attributes.
export class ComputeDriverError extends Schema.TaggedError<ComputeDriverError>()(
  "ComputeDriverError",
  {
    driverId: ComputeDriverId,
    operation: Schema.Literals([
      "create",
      "start",
      "stop",
      "destroy",
      "status",
      "list",
      "deleteImage",
      "health",
    ]),
    reason: ComputeDriverErrorReason,
    // Set where the error is built, never derived later from `reason`.
    retryable: Schema.Boolean,
    retryAfterMs: Schema.optionalKey(NonNegativeInt),
    // The backend's own status, e.g. the Engine API's HTTP status.
    backendStatus: Schema.optionalKey(Schema.Number),
    /** The base image a create could not boot from; `hint` says how to fix a missing one. */
    image: Schema.optionalKey(
      Schema.Struct({
        ref: Schema.String,
        state: Schema.Literals(["pulling", "missing"]),
        hint: Schema.optionalKey(Schema.String),
      }),
    ),
    /** How an admin fixes a host the driver cannot run machines on. */
    setupHint: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  // Sandbox failures show this text to the user.
  override get message(): string {
    if (this.setupHint !== undefined) return this.setupHint;
    if (this.image?.state === "pulling") {
      return "The machine image is still downloading. Retry in a few minutes.";
    }
    if (this.image?.hint !== undefined) return `Machine image not found. ${this.image.hint}`;
    return `Compute driver ${this.driverId} failed to ${this.operation}: ${this.reason}.`;
  }
}

/** Static per driver kind; `health` reports what a configured backend actually offers. */
export interface ComputeCapabilities {
  readonly persistentDisk: boolean;
  /** Pair leaves it off (decision 10). */
  readonly memoryOnStop: boolean;
  readonly snapshot: boolean;
  readonly imageBuild: "snapshot" | "buildImage";
  readonly maxSessionMs: number | null;
  readonly diskRetentionDays: number | null;
  readonly isolation: "container" | "rootless-container" | "gvisor" | "microvm" | "vm";
  readonly egressRules: "none" | "allowlist" | "allowlist-and-brokering";
  readonly regions: ReadonlyArray<string>;
  readonly nestedDocker: boolean;
  readonly sizes: ReadonlyArray<{
    readonly size: SandboxSize;
    readonly vcpus: number;
    readonly memoryGb: number;
  }>;
  /** How many of this instance's sandboxes may run at once before new ones queue. */
  readonly defaultRunningCap: number;
  /** Whether a ready machine stops once its threads settle; per-hour drivers may wait for idle. */
  readonly sleepOnSettle: boolean;
  /** How long a ready machine may sit unused before it sleeps. */
  readonly defaultIdleSleepMs: number;
}

export interface SandboxBootstrap {
  readonly sandboxId: SandboxId;
  readonly generation: number;
  /** The server serves this build's runner (decision 5). */
  readonly runnerBuildId: string;
  /** What the runner dials: `http(s)://host` or `unix:/path`. */
  readonly serverUrl: string;
  /** One use, 15 minutes, this generation only. */
  readonly enrollmentSecret: Redacted.Redacted<string>;
}

export type BackendSandboxStatus = "starting" | "running" | "stopped" | "failed" | "missing";

export interface BackendSandbox {
  readonly driverRef: string;
  readonly name: string;
  /** Parsed from our tags; null for a backend resource without them. */
  readonly sandboxId: SandboxId | null;
  readonly status: BackendSandboxStatus;
  readonly createdAt: DateTime.Utc;
}

export interface BaseImageInfo {
  readonly ref: string;
  readonly digest: string;
  readonly version: string | null;
}

export interface ComputeDriverHealth {
  readonly isolation: ComputeCapabilities["isolation"];
  readonly privateNetworkBlock:
    | { readonly applied: true }
    | { readonly applied: false; readonly reason: string };
  readonly baseImage:
    | BaseImageInfo
    | { readonly pulling: string }
    | { readonly missing: string; readonly hint: string }
    | null;
}

export interface ComputeDriverCreateInput {
  /** From `sandboxBackendName`; creating twice with one name yields one sandbox. */
  readonly name: string;
  readonly sandboxId: SandboxId;
  readonly generation: number;
  readonly image: { readonly type: "build"; readonly imageRef: string } | { readonly type: "base" };
  readonly size: SandboxSize;
  /** From `sandboxTags`. */
  readonly tags: Readonly<Record<string, string>>;
  readonly bootstrap: SandboxBootstrap;
}

export interface ComputeDriverCreateResult {
  readonly driverRef: string;
  readonly baseImage: BaseImageInfo | null;
}

// snapshot and buildImage join in M3 (04 §10 #17); nothing calls them in M1.
export class ComputeDriver extends Context.Service<
  ComputeDriver,
  {
    readonly driverId: ComputeDriverId;
    readonly kind: ComputeDriverKind;
    readonly capabilities: ComputeCapabilities;
    /** Creates and boots; replaying a create for the same name returns the same `driverRef`. */
    readonly create: (
      input: ComputeDriverCreateInput,
    ) => Effect.Effect<ComputeDriverCreateResult, ComputeDriverError>;
    /** Boots a stopped sandbox with a new generation's bootstrap; the disk is kept. */
    readonly start: (
      driverRef: string,
      bootstrap: SandboxBootstrap,
    ) => Effect.Effect<void, ComputeDriverError>;
    /** Frees CPU and memory, keeps the disk. Stopping a stopped sandbox succeeds. */
    readonly stop: (driverRef: string) => Effect.Effect<void, ComputeDriverError>;
    /** Removes the sandbox and its disk. Destroying a missing sandbox succeeds. */
    readonly destroy: (driverRef: string) => Effect.Effect<void, ComputeDriverError>;
    /** A missing sandbox is `status: "missing"`, not an error. */
    readonly status: (driverRef: string) => Effect.Effect<BackendSandbox, ComputeDriverError>;
    /** Sandboxes carrying every given tag. */
    readonly list: (
      tags: Readonly<Record<string, string>>,
    ) => Effect.Effect<ReadonlyArray<BackendSandbox>, ComputeDriverError>;
    /** A missing image succeeds. */
    readonly deleteImage: (imageRef: string) => Effect.Effect<void, ComputeDriverError>;
    /** What Settings → Cloud's Test button shows. */
    readonly health: Effect.Effect<ComputeDriverHealth, ComputeDriverError>;
  }
>()("t3/sandbox/compute/ComputeDriver") {}

/** The install id is the server's environment id, never the telemetry id (P2). */
export const sandboxBackendName = (
  installId: EnvironmentId,
  sandboxId: SandboxId,
  generation: number,
): string => `pair-${installId.slice(0, 8)}-${sandboxId}-g${generation}`;

export interface SandboxTagValues {
  readonly installId: EnvironmentId;
  readonly sandboxId: SandboxId;
  readonly generation: number;
  readonly driverId: ComputeDriverId;
}

export const sandboxTags = (values: SandboxTagValues): Readonly<Record<string, string>> => ({
  "pair.install": values.installId,
  "pair.sandbox": values.sandboxId,
  "pair.generation": String(values.generation),
  "pair.driver": values.driverId,
});

const decodeInstallId = Schema.decodeUnknownOption(EnvironmentId);
const decodeSandboxId = Schema.decodeUnknownOption(SandboxId);
const decodeDriverId = Schema.decodeUnknownOption(ComputeDriverId);

/** Null unless every tag `sandboxTags` writes is present and valid. */
export const parseSandboxTags = (
  tags: Readonly<Record<string, string>>,
): SandboxTagValues | null => {
  const installId = decodeInstallId(tags["pair.install"]);
  const sandboxId = decodeSandboxId(tags["pair.sandbox"]);
  const driverId = decodeDriverId(tags["pair.driver"]);
  const generationText = tags["pair.generation"] ?? "";
  if (
    installId._tag === "None" ||
    sandboxId._tag === "None" ||
    driverId._tag === "None" ||
    !/^(0|[1-9][0-9]{0,8})$/.test(generationText)
  ) {
    return null;
  }
  return {
    installId: installId.value,
    sandboxId: sandboxId.value,
    generation: Number(generationText),
    driverId: driverId.value,
  };
};
