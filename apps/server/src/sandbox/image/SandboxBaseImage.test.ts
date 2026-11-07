import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeDockerEngine } from "../compute/DockerEngineApi.ts";
import {
  BaseImageMissingError,
  baseImageCandidates,
  baseImageMissingHint,
  DEFAULT_BASE_IMAGE_REPOSITORY,
  ensureBaseImage,
} from "./SandboxBaseImage.ts";

const published = `${DEFAULT_BASE_IMAGE_REPOSITORY}:1.2.3`;

describe("baseImageCandidates", () => {
  it.each([
    {
      name: "an override alone, pullable",
      input: { override: "registry.example.com/base:7", fromSource: true },
      expected: [{ ref: "registry.example.com/base:7", pull: true }],
    },
    {
      name: "a released server's version tag",
      input: { override: undefined, fromSource: false },
      expected: [{ ref: published, pull: true }],
    },
    {
      name: "a source-run server's dev build, never pulled, then the version tag",
      input: { override: undefined, fromSource: true },
      expected: [
        { ref: "t3-sandbox:dev", pull: false },
        { ref: published, pull: true },
      ],
    },
  ])("lists $name", ({ input, expected }) => {
    assert.deepStrictEqual(baseImageCandidates({ ...input, version: "1.2.3" }), expected);
  });
});

/** An Engine API holding images in memory; `pulls` records each pull's `fromImage:tag`. */
const fakeEngine = (present: Map<string, object>, pullBody: (ref: string) => string) => {
  const pulls: Array<string> = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const reply = (status: number, body: string) =>
        HttpClientResponse.fromWeb(request, new Response(body, { status }));
      if (url.pathname.endsWith("/images/create")) {
        const ref = `${url.searchParams.get("fromImage")}:${url.searchParams.get("tag")}`;
        pulls.push(ref);
        const body = pullBody(ref);
        if (!body.includes('"error"')) present.set(ref, { Id: "sha256:pulled" });
        return reply(200, body);
      }
      const ref = decodeURIComponent(url.pathname)
        .split("/images/")[1]!
        .replace(/\/json$/, "");
      const image = present.get(ref);
      return image === undefined ? reply(404, "{}") : reply(200, JSON.stringify(image));
    }),
  );
  return { engine: makeDockerEngine(client, "http://docker"), pulls };
};

const progress = '{"status":"Pulling"}\n{"status":"Download complete"}\n';

describe("ensureBaseImage", () => {
  it.effect("takes the first candidate on the daemon without pulling", () => {
    const { engine, pulls } = fakeEngine(
      new Map([
        ["t3-sandbox:dev", { Id: "sha256:dev", Config: { Labels: {} } }],
        [published, { Id: "sha256:published" }],
      ]),
      () => progress,
    );
    return Effect.gen(function* () {
      const image = yield* ensureBaseImage(
        engine,
        baseImageCandidates({ override: undefined, version: "1.2.3", fromSource: true }),
      );
      assert.deepStrictEqual(image, {
        ref: "t3-sandbox:dev",
        digest: "sha256:dev",
        version: null,
        id: "sha256:dev",
      });
      assert.deepStrictEqual(pulls, []);
    });
  });

  it.effect("pulls an absent image once, reports it, and reads its digest and version", () => {
    const present = new Map<string, object>();
    const { engine, pulls } = fakeEngine(present, () => progress);
    return Effect.gen(function* () {
      const announced: Array<string> = [];
      const image = yield* ensureBaseImage(
        engine,
        baseImageCandidates({ override: undefined, version: "1.2.3", fromSource: false }),
        { onPulling: (ref) => Effect.sync(() => announced.push(ref)) },
      );
      assert.deepStrictEqual(pulls, [`${DEFAULT_BASE_IMAGE_REPOSITORY}:1.2.3`]);
      assert.deepStrictEqual(announced, [published]);
      assert.strictEqual(image.id, "sha256:pulled");

      present.set(published, {
        Id: "sha256:a",
        RepoDigests: [`${DEFAULT_BASE_IMAGE_REPOSITORY}@sha256:b`],
        Config: { Labels: { "org.opencontainers.image.version": "1.2.3" } },
      });
      const labelled = yield* ensureBaseImage(engine, [{ ref: published, pull: true }]);
      assert.deepStrictEqual(labelled, {
        ref: published,
        digest: "sha256:b",
        version: "1.2.3",
        id: "sha256:a",
      });
      assert.lengthOf(pulls, 1);
    });
  });

  it.effect("fails with the refs tried when the pull stream carries an error line", () => {
    const { engine } = fakeEngine(new Map(), () => '{"error":"denied: not public"}\n');
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        ensureBaseImage(
          engine,
          baseImageCandidates({ override: undefined, version: "1.2.3", fromSource: true }),
        ),
      );
      assert.deepStrictEqual([error.refs, error.fromSource], [["t3-sandbox:dev", published], true]);
    });
  });
});

describe("baseImageMissingHint", () => {
  it.each([
    {
      name: "a source-run server",
      error: new BaseImageMissingError({ refs: ["t3-sandbox:dev", published], fromSource: true }),
      hint: "Run `vp run sandbox-image:build`, or set Base image in Settings → Cloud.",
    },
    {
      name: "a released server",
      error: new BaseImageMissingError({ refs: [published], fromSource: false }),
      hint: `Could not pull ${published}. Check that the package is public, or set Base image in Settings → Cloud.`,
    },
  ])("words $name", ({ error, hint }) => {
    assert.strictEqual(baseImageMissingHint(error), hint);
  });
});
