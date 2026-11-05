#!/usr/bin/env node

// Android masks a 72dp safe area inside 108dp; a solid background and a separate mark avoid double silhouettes/cropping.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

type IconVariant = "dev" | "nightly" | "prod";

const ADAPTIVE_CANVAS = 432;
const SPLASH_CANVAS = 1152;
const MARK = { x: 4, y: 4, width: 24, height: 24 };
// The mark fills 48dp of the 108dp adaptive canvas and 96dp of the 288dp splash canvas.
const ADAPTIVE_MARK_FRACTION = 48 / 108;
const SPLASH_MARK_FRACTION = 96 / 288;
const SVG_DENSITY = 300;
const OUTPUT_DIRECTORY = "apps/mobile/assets";
const TILE_COLOR = "#111113";
const MONOCHROME_COLOR = "#FFFFFF";
const NOTIFICATION_CANVAS = 96;

export class AndroidIconRenderError extends Schema.TaggedError<AndroidIconRenderError>()(
  "AndroidIconRenderError",
  { layer: Schema.String, cause: Schema.Defect() },
) {}

const markTransform = (size: number, fraction: number) => {
  const scale = (size * fraction) / MARK.width;
  const tx = (size - MARK.width * scale) / 2 - MARK.x * scale;
  const ty = (size - MARK.height * scale) / 2 - MARK.y * scale;
  return `translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(4)})`;
};

const canvasSvg = (size: number, inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">${inner}</svg>`;

const rasterize = (layer: string, svg: string, width: number, height = width) =>
  Effect.tryPromise({
    try: () =>
      sharp(Buffer.from(svg), { density: SVG_DENSITY }).resize(width, height).png().toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const composite = (
  layer: string,
  base: Buffer,
  overlays: ReadonlyArray<{ input: Buffer; left?: number; top?: number }>,
) =>
  Effect.tryPromise({
    try: () =>
      sharp(base)
        .composite([...overlays])
        .png()
        .toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const solidCanvas = (layer: string, size: number) =>
  Effect.tryPromise({
    try: () =>
      sharp({ create: { width: size, height: size, channels: 4, background: TILE_COLOR } })
        .png()
        .toBuffer(),
    catch: (cause) => new AndroidIconRenderError({ layer, cause }),
  });

const readMarkPaths = Effect.fn("androidIcons.readMarkPaths")(function* (
  repositoryRoot: string,
  variant: IconVariant,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* fs.readFileString(
    path.join(repositoryRoot, "assets", variant, "app-icon.icon", "Assets", "text.svg"),
  );
  return source.match(/<path[^>]*\/>/g) ?? [];
});

const renderMark = Effect.fn("androidIcons.renderMark")(function* (
  repositoryRoot: string,
  variant: IconVariant,
  size: number,
  fraction: number,
  monochrome = false,
) {
  const paths = yield* readMarkPaths(repositoryRoot, variant);
  const body = monochrome
    ? paths.map((tag) => tag.replace(/fill="[^"]*"/, `fill="${MONOCHROME_COLOR}"`))
    : paths;
  return yield* rasterize(
    `${variant}-mark`,
    canvasSvg(size, `<g transform="${markTransform(size, fraction)}">${body.join("")}</g>`),
    size,
  );
});

const renderSplashIcon = Effect.fn("androidIcons.renderSplashIcon")(function* (
  repositoryRoot: string,
  variant: IconVariant,
) {
  const background = yield* solidCanvas(`${variant}-splash-background`, SPLASH_CANVAS);
  const mark = yield* renderMark(repositoryRoot, variant, SPLASH_CANVAS, SPLASH_MARK_FRACTION);
  return yield* composite(`${variant}-splash`, background, [{ input: mark }]);
});

const exportAndroidIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const outputs = [
    [
      "android-icon-foreground.png",
      yield* renderMark(repositoryRoot, "prod", ADAPTIVE_CANVAS, ADAPTIVE_MARK_FRACTION),
    ],
    [
      "android-icon-mark.png",
      yield* renderMark(repositoryRoot, "prod", ADAPTIVE_CANVAS, ADAPTIVE_MARK_FRACTION, true),
    ],
    [
      "android-notification-icon.png",
      yield* renderMark(repositoryRoot, "prod", NOTIFICATION_CANVAS, 0.75, true),
    ],
    ["android-icon-background-dev.png", yield* solidCanvas("dev-background", ADAPTIVE_CANVAS)],
    [
      "android-icon-background-nightly.png",
      yield* solidCanvas("nightly-background", ADAPTIVE_CANVAS),
    ],
    ["android-splash-icon-dev.png", yield* renderSplashIcon(repositoryRoot, "dev")],
    ["android-splash-icon-nightly.png", yield* renderSplashIcon(repositoryRoot, "nightly")],
    ["android-splash-icon-prod.png", yield* renderSplashIcon(repositoryRoot, "prod")],
  ] as const;
  for (const [name, contents] of outputs) {
    yield* fs.writeFile(path.join(repositoryRoot, OUTPUT_DIRECTORY, name), contents);
    yield* Console.log(`wrote ${OUTPUT_DIRECTORY}/${name}`);
  }
});

if (import.meta.main) {
  exportAndroidIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
