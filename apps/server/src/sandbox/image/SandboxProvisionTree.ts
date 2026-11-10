// @effect-diagnostics nodeBuiltinImport:off - Effect has no digest or gzip of its own.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import packageJson from "../../../package.json" with { type: "json" };
import { ustar } from "../compute/DockerEngineApi.ts";
import { CODEX_RELEASES, type CodexReleaseAsset } from "../../provider/codexReleases.ts";

export class SandboxImageCodexReleaseError extends Schema.TaggedError<SandboxImageCodexReleaseError>()(
  "SandboxImageCodexReleaseError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const LINUX_RELEASES = [
  { key: "linux-x64", suffix: "AMD64" },
  { key: "linux-arm64", suffix: "ARM64" },
] as const;

/** The `codex.env` that provision.sh reads, from the table managed Codex installs from. */
export const codexEnv = Effect.fn("sandboxImage.codexEnv")(function* (
  releases: Readonly<Record<string, CodexReleaseAsset>>,
) {
  const assets: Array<{ suffix: string; asset: CodexReleaseAsset }> = [];
  for (const { key, suffix } of LINUX_RELEASES) {
    const asset = releases[key];
    if (asset === undefined) {
      return yield* new SandboxImageCodexReleaseError({
        detail: `CODEX_RELEASES has no ${key} entry.`,
      });
    }
    assets.push({ suffix, asset });
  }
  const [{ asset: first }, { asset: second }] = assets as [(typeof assets)[0], (typeof assets)[0]];
  if (first.version !== second.version) {
    return yield* new SandboxImageCodexReleaseError({
      detail: "CODEX_RELEASES lists different versions for linux-x64 and linux-arm64.",
    });
  }
  return [
    `CODEX_VERSION=${first.version}`,
    ...assets.flatMap(({ suffix, asset }) => [
      `CODEX_URL_${suffix}=${asset.url}`,
      `CODEX_SHA256_${suffix}=${asset.sha256}`,
    ]),
    "",
  ].join("\n");
});

/** Compute Engine takes 256 KB per metadata value; the tree travels as one (`pair-provision`). */
export const PROVISION_TREE_MAX_BYTES = 200 * 1024;

export interface SandboxProvisionTreeInfo {
  /** The tree as a gzipped tar, base64: the `pair-provision` metadata value. */
  readonly tarGzBase64: string;
  /** Of the uncompressed tar, so it names the tree's content and nothing else. */
  readonly sha256: string;
  /** The server's version, which the build passes to provision.sh as `PAIR_VERSION`. */
  readonly pairVersion: string;
  /** `vm/base-build.sh`, the builder's startup script, which unpacks the rest. */
  readonly baseBuildScript: string;
}

export class SandboxProvisionTreeUnavailableError extends Schema.TaggedError<SandboxProvisionTreeUnavailableError>()(
  "SandboxProvisionTreeUnavailableError",
  {
    reason: Schema.Literals(["not-bundled", "too-large", "unreadable"]),
    sizeBytes: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-bundled":
        return "This server was built without the sandbox-image tree, so it cannot build a machine image. Install a Pair Cloud release.";
      case "too-large":
        return `The sandbox-image tree is ${this.sizeBytes ?? "over"} bytes once packed, over the ${PROVISION_TREE_MAX_BYTES} a cloud's instance metadata takes.`;
      case "unreadable":
        return "The sandbox-image tree could not be read.";
    }
  }
}

/** The provision tree (infra/sandbox-image) a VM driver's base image build runs. */
export class SandboxProvisionTree extends Context.Service<
  SandboxProvisionTree,
  {
    /** Released: `sandbox-image/` beside the server. From source: infra/sandbox-image and a generated codex.env. */
    readonly current: Effect.Effect<SandboxProvisionTreeInfo, SandboxProvisionTreeUnavailableError>;
  }
>()("t3/sandbox/image/SandboxProvisionTree") {}

interface TreeFile {
  readonly name: string;
  readonly executable: boolean;
  readonly content: Uint8Array;
}

const BASE_BUILD_SCRIPT = "vm/base-build.sh";

/** Sorted names, root-owned entries and zero times, so one tree always packs to one hash. */
const pack = (
  files: ReadonlyArray<TreeFile>,
  baseBuildScript: TreeFile,
): SandboxProvisionTreeInfo => {
  const tar = ustar(
    files
      .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((file) => ({
        name: file.name,
        mode: file.executable ? 0o755 : 0o644,
        content: file.content,
      })),
  );
  return {
    tarGzBase64: NodeZlib.gzipSync(tar, { level: 9 }).toString("base64"),
    sha256: NodeCrypto.createHash("sha256").update(tar).digest("hex"),
    pairVersion: packageJson.version,
    baseBuildScript: new TextDecoder().decode(baseBuildScript.content),
  };
};

const readFiles = Effect.fn("SandboxProvisionTree.readFiles")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<TreeFile> = [];
  for (const entry of yield* fs.readDirectory(directory, { recursive: true })) {
    const file = path.join(directory, entry);
    const info = yield* fs.stat(file);
    if (info.type !== "File") continue;
    files.push({
      name: entry.split(path.sep).join("/"),
      executable: (info.mode & 0o111) !== 0,
      content: yield* fs.readFile(file),
    });
  }
  return files;
});

const packChecked = (files: ReadonlyArray<TreeFile>) => {
  const baseBuildScript = files.find((file) => file.name === BASE_BUILD_SCRIPT);
  if (baseBuildScript === undefined) {
    return Effect.fail(new SandboxProvisionTreeUnavailableError({ reason: "not-bundled" }));
  }
  return Effect.try({
    try: () => pack(files, baseBuildScript),
    catch: (cause) => new SandboxProvisionTreeUnavailableError({ reason: "unreadable", cause }),
  }).pipe(
    Effect.filterOrFail(
      (info) => info.tarGzBase64.length <= PROVISION_TREE_MAX_BYTES,
      (info) =>
        new SandboxProvisionTreeUnavailableError({
          reason: "too-large",
          sizeBytes: info.tarGzBase64.length,
        }),
    ),
  );
};

const unreadable = (cause: unknown) =>
  new SandboxProvisionTreeUnavailableError({ reason: "unreadable", cause });

/** A release's `sandbox-image/`, written by `sandbox-image.ts context`, codex.env included. */
export const readReleasedTree = Effect.fn("SandboxProvisionTree.readReleased")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const complete = yield* Effect.forEach(["provision.sh", "codex.env"], (name) =>
    fs.exists(path.join(directory, name)),
  ).pipe(Effect.mapError(unreadable));
  if (complete.includes(false)) {
    return yield* new SandboxProvisionTreeUnavailableError({ reason: "not-bundled" });
  }
  return yield* packChecked(yield* readFiles(directory).pipe(Effect.mapError(unreadable)));
});

/** infra/sandbox-image as a checkout has it, with the codex.env a release generates beside it. */
export const readSourceTree = Effect.fn("SandboxProvisionTree.readSource")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(path.join(directory, "provision.sh")).pipe(Effect.mapError(unreadable)))) {
    return yield* new SandboxProvisionTreeUnavailableError({ reason: "not-bundled" });
  }
  const env = yield* codexEnv(CODEX_RELEASES).pipe(Effect.mapError(unreadable));
  const files = (yield* readFiles(directory).pipe(Effect.mapError(unreadable))).filter(
    (file) => file.name !== "codex.env",
  );
  return yield* packChecked([
    ...files,
    { name: "codex.env", executable: false, content: new TextEncoder().encode(env) },
  ]);
});

export const layer = Layer.effect(
  SandboxProvisionTree,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    // As RunnerBundle.layer: a `.ts` module runs from source; released, the module's directory is
    // `dist/` (npm) or the executable's own (a CLI archive).
    const read = import.meta.url.endsWith(".ts")
      ? path
          .fromFileUrl(new URL("../../../../../infra/sandbox-image", import.meta.url))
          .pipe(Effect.mapError(unreadable), Effect.flatMap(readSourceTree))
      : readReleasedTree(path.join(import.meta.dirname, "sandbox-image"));
    // Once per process: the tree is part of the release and never changes under a running server.
    const current = yield* Effect.cached(read.pipe(Effect.provideContext(context)));
    return SandboxProvisionTree.of({ current });
  }),
);
