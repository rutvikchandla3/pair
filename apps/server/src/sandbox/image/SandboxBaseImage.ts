import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { BaseImageInfo } from "../compute/ComputeDriver.ts";
import type { DockerEngine, EngineImage } from "../compute/DockerEngineApi.ts";

/** The canonical Pair repository's GHCR, where `sandbox-image.yml` publishes. */
export const DEFAULT_BASE_IMAGE_REPOSITORY = "ghcr.io/rutvikchandla3/t3-sandbox";
/** Built by `vp run sandbox-image:build`; never pulled. */
const DEV_BASE_IMAGE = "t3-sandbox:dev";

export interface BaseImageCandidate {
  readonly ref: string;
  readonly pull: boolean;
}

/** In order of preference: a developer's own build, then the image published for this version. */
export const baseImageCandidates = (input: {
  /** `ServerSettings.sandbox.baseImage`. */
  readonly override: string | undefined;
  /** The server's package version. */
  readonly version: string;
  /** Run from a checkout rather than a published package. */
  readonly fromSource: boolean;
}): ReadonlyArray<BaseImageCandidate> =>
  input.override !== undefined
    ? [{ ref: input.override, pull: true }]
    : [
        ...(input.fromSource ? [{ ref: DEV_BASE_IMAGE, pull: false }] : []),
        { ref: `${DEFAULT_BASE_IMAGE_REPOSITORY}:${input.version}`, pull: true },
      ];

export class BaseImageMissingError extends Schema.TaggedError<BaseImageMissingError>()(
  "BaseImageMissingError",
  {
    refs: Schema.Array(Schema.String),
    /** The local dev build was among the candidates, so building it is a way out. */
    fromSource: Schema.Boolean,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `No base image is available (${this.refs.join(", ")}).`;
  }
}

/** What the driver boots from: the daemon's id for it, so a sandbox runs exactly what was resolved. */
export interface ResolvedBaseImage extends BaseImageInfo {
  readonly id: string;
}

const resolvedBaseImage = (ref: string, image: EngineImage): ResolvedBaseImage => ({
  ref,
  digest: image.RepoDigests?.[0]?.split("@")[1] ?? image.Id,
  version: image.Config?.Labels?.["org.opencontainers.image.version"] ?? null,
  id: image.Id,
});

export const baseImageMissingHint = (error: BaseImageMissingError): string =>
  error.fromSource
    ? "Run `vp run sandbox-image:build`, or set Base image in Settings → Cloud."
    : `Could not pull ${error.refs.at(-1) ?? "the base image"}. Check that the package is public, or set Base image in Settings → Cloud.`;

/**
 * The first candidate already on the daemon wins; otherwise the first pullable one is pulled.
 * A pull takes minutes, so callers fork this and watch `onPulling`, which runs once the daemon has
 * accepted the pull; an image it refuses fails before that.
 */
export const ensureBaseImage = Effect.fn("SandboxBaseImage.ensure")(function* (
  engine: DockerEngine,
  candidates: ReadonlyArray<BaseImageCandidate>,
  hooks?: { readonly onPulling: (ref: string) => Effect.Effect<void> },
) {
  const missing = (cause?: unknown) =>
    new BaseImageMissingError({
      refs: candidates.map((candidate) => candidate.ref),
      fromSource: candidates.some((candidate) => !candidate.pull),
      ...(cause === undefined ? {} : { cause }),
    });
  const inspect = (ref: string) =>
    engine
      .inspectImage(ref)
      .pipe(Effect.map((image) => (image === null ? null : resolvedBaseImage(ref, image))));
  return yield* Effect.gen(function* () {
    for (const candidate of candidates) {
      const found = yield* inspect(candidate.ref);
      if (found !== null) return found;
    }
    const pullable = candidates.find((candidate) => candidate.pull);
    if (pullable === undefined) return yield* missing();
    yield* engine.pullImage(pullable.ref, hooks?.onPulling(pullable.ref));
    return (yield* inspect(pullable.ref)) ?? (yield* missing());
  }).pipe(Effect.catchTags({ DockerEngineError: (cause) => Effect.fail(missing(cause)) }));
});
