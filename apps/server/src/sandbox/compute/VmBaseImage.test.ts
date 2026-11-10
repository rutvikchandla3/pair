import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type { SandboxProvisionTreeInfo } from "../image/SandboxProvisionTree.ts";
import {
  baseImagePairVersion,
  stepVmBaseImage,
  type VmBaseImageCloud,
  type VmBuilder,
  type VmBuilderLaunch,
  type VmImage,
  type VmImageCapture,
  vmBaseImageNames,
} from "./VmBaseImage.ts";

const INSTALL = "0a1b2c3d-0000-4000-8000-000000000000";

const tree = (sha: string): SandboxProvisionTreeInfo => ({
  tarGzBase64: `tree-${sha}`,
  sha256: sha.repeat(64).slice(0, 64),
  pairVersion: "0.1.7-pair.9",
  baseBuildScript: "#!/bin/bash\n",
});
const TREE = tree("a");

/** The cloud as a stub: what exists, and every write in order. */
const makeCloud = () => {
  const images = new Map<string, VmImage>();
  const builders = new Map<string, VmBuilder>();
  const writes: Array<string> = [];
  const launches: Array<VmBuilderLaunch> = [];
  const captures: Array<VmImageCapture> = [];
  const cloud: VmBaseImageCloud<VmImage, never> = {
    findImage: (name) => Effect.sync(() => images.get(name) ?? null),
    listImages: (family) =>
      Effect.sync(() => [...images.values()].filter((image) => image.name.startsWith(family))),
    deleteImage: (name) =>
      Effect.sync(() => {
        writes.push(`deleteImage ${name}`);
        images.delete(name);
      }),
    findBuilder: (name) => Effect.sync(() => builders.get(name) ?? null),
    launchBuilder: (input) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        writes.push(`launch ${input.name}`);
        launches.push(input);
        builders.set(input.name, {
          name: input.name,
          installId: INSTALL,
          state: "running",
          createdAtMs: now,
          result: null,
        });
      }),
    captureImage: (input) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        writes.push(`capture ${input.name}`);
        captures.push(input);
        images.set(input.name, {
          name: input.name,
          status: "pending",
          installId: INSTALL,
          createdAtMs: now,
        });
      }),
    deleteBuilder: (name) =>
      Effect.sync(() => {
        writes.push(`deleteBuilder ${name}`);
        builders.delete(name);
      }),
  };
  /** The guest writes its report and powers off. */
  const report = (name: string, result: string) => {
    const builder = builders.get(name)!;
    builders.set(name, { ...builder, state: "stopped", result });
  };
  const finishCaptures = () => {
    for (const image of images.values()) images.set(image.name, { ...image, status: "ready" });
  };
  return { cloud, images, builders, writes, launches, captures, report, finishCaptures };
};

const step = (cloud: VmBaseImageCloud<VmImage, never>, provision = TREE) =>
  stepVmBaseImage({ cloud, installId: INSTALL, tree: provision });

/** Steps until settled, playing the guest and the cloud; `replay` steps twice, as after a crash. */
const build = Effect.fn("VmBaseImageTest.build")(function* (
  stub: ReturnType<typeof makeCloud>,
  provision = TREE,
  replay = false,
) {
  const names = vmBaseImageNames(INSTALL, provision.sha256);
  for (let round = 0; round < 20; round++) {
    if (replay) yield* step(stub.cloud, provision);
    const state = yield* step(stub.cloud, provision);
    if (state._tag === "Failed") return state;
    if (state._tag === "Ready" && state.settled) return state;
    yield* TestClock.adjust("1 minute");
    if (stub.builders.get(names.builder)?.state === "running") stub.report(names.builder, "ok");
    stub.finishCaptures();
  }
  return assert.fail("the build did not settle");
});

describe("stepVmBaseImage", () => {
  it.effect("walks the numbered steps, one write at a time", () =>
    Effect.gen(function* () {
      const stub = makeCloud();
      const names = vmBaseImageNames(INSTALL, TREE.sha256);
      assert.deepStrictEqual(names, {
        image: "pair-0a1b2c3d-base-aaaaaaaaaaaa",
        family: "pair-0a1b2c3d-base",
        builder: "pair-0a1b2c3d-basebuild-aaaaaaaaaaaa",
      });

      // 2. No image and no builder: launch one.
      assert.deepStrictEqual(yield* step(stub.cloud), { _tag: "Building", image: names.image });
      assert.deepStrictEqual(stub.launches, [
        {
          name: names.builder,
          metadata: {
            "pair-role": "base",
            "pair-provision": TREE.tarGzBase64,
            "pair-version": TREE.pairVersion,
          },
          startupScript: TREE.baseBuildScript,
        },
      ]);
      // 3. The builder runs.
      assert.strictEqual((yield* step(stub.cloud))._tag, "Building");
      assert.strictEqual(stub.writes.length, 1);
      // 4. It stopped with `ok`: capture.
      stub.report(names.builder, "ok");
      assert.strictEqual((yield* step(stub.cloud))._tag, "Building");
      assert.deepStrictEqual(
        stub.captures.map(({ name, family, builder }) => ({ name, family, builder })),
        [{ name: names.image, family: names.family, builder: names.builder }],
      );
      assert.strictEqual(baseImagePairVersion(stub.captures[0]!.description), TREE.pairVersion);
      // The capture runs.
      assert.strictEqual((yield* step(stub.cloud))._tag, "Building");
      assert.strictEqual(stub.writes.length, 2);
      // 5. The image is ready and the builder remains: delete it.
      stub.finishCaptures();
      const deleted = yield* step(stub.cloud);
      assert.isTrue(deleted._tag === "Ready" && !deleted.settled);
      // 1. The image exists and is ready.
      const ready = yield* step(stub.cloud);
      assert.isTrue(ready._tag === "Ready" && ready.settled && ready.image.name === names.image);
      assert.deepStrictEqual(stub.writes, [
        `launch ${names.builder}`,
        `capture ${names.image}`,
        `deleteBuilder ${names.builder}`,
      ]);
    }),
  );

  it.effect("a crash and a restart at every step end in one image and no builder", () =>
    Effect.gen(function* () {
      const stub = makeCloud();
      const state = yield* build(stub, TREE, true);
      assert.strictEqual(state._tag, "Ready");
      assert.deepStrictEqual(
        [...stub.images.keys()],
        [vmBaseImageNames(INSTALL, TREE.sha256).image],
      );
      assert.strictEqual(stub.builders.size, 0);
      assert.strictEqual(stub.launches.length, 1);
      assert.strictEqual(stub.captures.length, 1);
    }),
  );

  it.effect("a changed tree makes a new image and removes the third-newest", () =>
    Effect.gen(function* () {
      const stub = makeCloud();
      const trees = [tree("a"), tree("b"), tree("c")];
      for (const provision of trees) {
        assert.strictEqual((yield* build(stub, provision))._tag, "Ready");
        yield* TestClock.adjust("1 day");
      }
      const name = (provision: SandboxProvisionTreeInfo) =>
        vmBaseImageNames(INSTALL, provision.sha256).image;
      assert.deepStrictEqual(
        [...stub.images.keys()].toSorted(),
        [name(trees[1]!), name(trees[2]!)].toSorted(),
      );
      assert.include(stub.writes, `deleteImage ${name(trees[0]!)}`);
      // Going back to an older tree's image keeps that one and the newest other.
      stub.writes.length = 0;
      assert.strictEqual((yield* build(stub, trees[1]!))._tag, "Ready");
      assert.deepStrictEqual(stub.writes, []);
    }),
  );

  it.effect("reaps a builder that has not reported after 30 minutes", () =>
    Effect.gen(function* () {
      const stub = makeCloud();
      const names = vmBaseImageNames(INSTALL, TREE.sha256);
      yield* step(stub.cloud);
      yield* TestClock.adjust("29 minutes");
      assert.strictEqual((yield* step(stub.cloud))._tag, "Building");
      yield* TestClock.adjust("2 minutes");
      assert.deepStrictEqual(yield* step(stub.cloud), { _tag: "Failed", step: "timeout" });
      assert.isFalse(stub.builders.has(names.builder));
    }),
  );

  it.effect("a failure names its step and deletes the builder; the next step starts again", () =>
    Effect.gen(function* () {
      const cases = [
        { report: "failed:provision", step: "provision" },
        { report: "failed:../etc", step: "unknown" },
      ];
      for (const { report, step: expected } of cases) {
        const stub = makeCloud();
        const names = vmBaseImageNames(INSTALL, TREE.sha256);
        yield* step(stub.cloud);
        stub.report(names.builder, report);
        assert.deepStrictEqual(yield* step(stub.cloud), { _tag: "Failed", step: expected });
        assert.isFalse(stub.builders.has(names.builder));
        assert.strictEqual((yield* step(stub.cloud))._tag, "Building");
        assert.strictEqual(stub.launches.length, 2);
      }

      // Powered off with no report.
      const stub = makeCloud();
      const names = vmBaseImageNames(INSTALL, TREE.sha256);
      yield* step(stub.cloud);
      stub.builders.set(names.builder, { ...stub.builders.get(names.builder)!, state: "stopped" });
      assert.deepStrictEqual(yield* step(stub.cloud), { _tag: "Failed", step: "no-report" });
    }),
  );

  it.effect("never adopts or deletes an image or builder of another install", () =>
    Effect.gen(function* () {
      const names = vmBaseImageNames(INSTALL, TREE.sha256);
      const imageStub = makeCloud();
      imageStub.images.set(names.image, {
        name: names.image,
        status: "ready",
        installId: "someone-else",
        createdAtMs: 0,
      });
      const builderStub = makeCloud();
      builderStub.builders.set(names.builder, {
        name: names.builder,
        installId: null,
        state: "stopped",
        createdAtMs: 0,
        result: "failed:provision",
      });
      for (const [stub, name] of [
        [imageStub, names.image],
        [builderStub, names.builder],
      ] as const) {
        const error = yield* Effect.flip(step(stub.cloud));
        assert.strictEqual(error.resource, name);
        assert.deepStrictEqual(stub.writes, []);
      }
    }),
  );
});
