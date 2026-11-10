import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { SandboxProvisionTreeInfo } from "../image/SandboxProvisionTree.ts";

/**
 * A VM driver's base image, built in the customer's own account (D13): a builder machine boots the
 * cloud's stock Ubuntu with the provision tree in its metadata, runs `vm/base-build.sh`, reports
 * and powers off; the driver captures its disk. The state lives in the cloud, found by name, so a
 * restarted server resumes where the last one stopped.
 */

/** A builder that has not reported by then is deleted and the build fails. */
const BASE_BUILD_TIMEOUT_MS = 30 * 60_000;

export const vmBaseImageNames = (installId: string, treeSha256: string) => {
  const install8 = installId.slice(0, 8).toLowerCase();
  const tree12 = treeSha256.slice(0, 12);
  return {
    image: `pair-${install8}-base-${tree12}`,
    family: `pair-${install8}-base`,
    builder: `pair-${install8}-basebuild-${tree12}`,
  };
};

export interface VmImage {
  readonly name: string;
  readonly status: "pending" | "ready" | "failed";
  /** Its `pair-install` label; null when it has none. */
  readonly installId: string | null;
  readonly createdAtMs: number;
}

export interface VmBuilder {
  readonly name: string;
  /** Its `pair-install` label; null when it has none. */
  readonly installId: string | null;
  /** `stopped` once the guest has powered off. */
  readonly state: "starting" | "running" | "stopped";
  readonly createdAtMs: number;
  /**
   * The guest's report (`pair/provision` on GCE): `ok`, `failed:<step>`, or null before it wrote
   * one. It must still be readable once the builder has stopped.
   */
  readonly result: string | null;
}

export interface VmBuilderLaunch {
  readonly name: string;
  /** Instance metadata (user data on EC2) for `vm/base-build.sh`: the guest contract's base keys. */
  readonly metadata: Readonly<Record<string, string>>;
  /** `vm/base-build.sh`, the builder's startup script. */
  readonly startupScript: string;
}

export interface VmImageCapture {
  readonly name: string;
  readonly family: string;
  /** The stopped builder whose boot disk becomes the image. */
  readonly builder: string;
  readonly description: string;
}

/**
 * What a cloud gives the state machine. Each method is one read or one write; a write is safe to
 * replay, since a crashed server's next `step` reads the cloud again first. The image and builder
 * are this install's by their `pair-install` label, which every write sets.
 */
export interface VmBaseImageCloud<Image extends VmImage, E> {
  readonly findImage: (name: string) => Effect.Effect<Image | null, E>;
  /** Every image in `family`, in any status. */
  readonly listImages: (family: string) => Effect.Effect<ReadonlyArray<Image>, E>;
  readonly deleteImage: (name: string) => Effect.Effect<void, E>;
  readonly findBuilder: (name: string) => Effect.Effect<VmBuilder | null, E>;
  /**
   * A machine on the driver's network with no service account, no external address, the install
   * label and no `pair-sandbox` label, so the reconciler never lists it.
   */
  readonly launchBuilder: (input: VmBuilderLaunch) => Effect.Effect<void, E>;
  /** From the stopped builder's boot disk, with the install label and the customer's key when set. */
  readonly captureImage: (input: VmImageCapture) => Effect.Effect<void, E>;
  readonly deleteBuilder: (name: string) => Effect.Effect<void, E>;
}

export type VmBaseImageState<Image extends VmImage> =
  | {
      readonly _tag: "Ready";
      readonly image: Image;
      /** False while an older base image is left to delete; step again until it is true. */
      readonly settled: boolean;
    }
  | { readonly _tag: "Building"; readonly image: string }
  /** `step` is base-build.sh's step, `timeout`, or `no-report` (it stopped without one). */
  | { readonly _tag: "Failed"; readonly step: string };

export class VmBaseImageConflictError extends Schema.TaggedError<VmBaseImageConflictError>()(
  "VmBaseImageConflictError",
  { resource: Schema.String },
) {
  override get message(): string {
    return `${this.resource} exists but this server did not make it, so it is left alone.`;
  }
}

/** A label value takes no dot, so the image's description carries the version it was built from. */
const baseImageDescription = (tree: SandboxProvisionTreeInfo): string =>
  `Pair base image. pair-version=${tree.pairVersion} provision-sha256=${tree.sha256}`;

/** `pair-version=<v>` in an image's description (m5-byoc.md, Shared names). */
export const baseImagePairVersion = (description: string | undefined): string | null =>
  /(?:^|\s)pair-version=(\S+)/.exec(description ?? "")?.[1] ?? null;

const failedStep = (result: string): string => {
  const step = result.startsWith("failed:") ? result.slice("failed:".length) : "";
  return /^[a-z][a-z-]{0,31}$/.test(step) ? step : "unknown";
};

/**
 * One step toward this tree's base image: at most one cloud write, then the state. The driver
 * steps until `Ready` and settled, or `Failed`; stepping after `Failed` starts a new build.
 */
export const stepVmBaseImage = Effect.fn("VmBaseImage.step")(function* <
  Image extends VmImage,
  E,
>(input: {
  readonly cloud: VmBaseImageCloud<Image, E>;
  readonly installId: string;
  readonly tree: SandboxProvisionTreeInfo;
}) {
  const { cloud, installId, tree } = input;
  const names = vmBaseImageNames(installId, tree.sha256);
  const building = { _tag: "Building", image: names.image } as const;
  const ready = (image: Image, settled: boolean) => ({ _tag: "Ready", image, settled }) as const;

  const image = yield* cloud.findImage(names.image);
  if (image !== null && image.installId !== installId) {
    return yield* new VmBaseImageConflictError({ resource: names.image });
  }
  const builder = yield* cloud.findBuilder(names.builder);
  if (builder !== null && builder.installId !== installId) {
    return yield* new VmBaseImageConflictError({ resource: names.builder });
  }

  if (image?.status === "ready") {
    if (builder !== null) {
      yield* cloud.deleteBuilder(builder.name);
      return ready(image, false);
    }
    // The current image and the newest other ready one, so a downgrade finds its base.
    const others = (yield* cloud.listImages(names.family))
      .filter(
        (other) =>
          other.installId === installId &&
          other.name.startsWith(`${names.family}-`) &&
          other.name !== image.name &&
          other.status !== "pending",
      )
      .toSorted((a, b) => b.createdAtMs - a.createdAtMs);
    const keep = others.find((other) => other.status === "ready");
    const surplus = others.filter((other) => other !== keep);
    const oldest = surplus.at(-1);
    if (oldest === undefined) return ready(image, true);
    yield* cloud.deleteImage(oldest.name);
    return ready(image, surplus.length === 1);
  }
  if (image?.status === "pending") return building;
  if (image?.status === "failed") {
    // The builder, if still there, is captured again by the next step.
    yield* cloud.deleteImage(image.name);
    return building;
  }

  if (builder === null) {
    yield* cloud.launchBuilder({
      name: names.builder,
      metadata: {
        "pair-role": "base",
        "pair-provision": tree.tarGzBase64,
        "pair-version": tree.pairVersion,
      },
      startupScript: tree.baseBuildScript,
    });
    return building;
  }
  const failed = (step: string) =>
    cloud.deleteBuilder(builder.name).pipe(Effect.as({ _tag: "Failed", step } as const));
  if (builder.result !== null && builder.result !== "ok") {
    return yield* failed(failedStep(builder.result));
  }
  if (builder.state === "stopped") {
    if (builder.result !== "ok") return yield* failed("no-report");
    yield* cloud.captureImage({
      name: names.image,
      family: names.family,
      builder: builder.name,
      description: baseImageDescription(tree),
    });
    return building;
  }
  if ((yield* Clock.currentTimeMillis) - builder.createdAtMs >= BASE_BUILD_TIMEOUT_MS) {
    return yield* failed("timeout");
  }
  return building;
});
