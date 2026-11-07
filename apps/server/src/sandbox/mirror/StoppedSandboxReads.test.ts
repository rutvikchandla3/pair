import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointRef,
  CheckpointScopeId,
  type OrchestrationV2Sandbox,
  ProjectId,
  RunId,
  SandboxId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import type { ProjectionCheckpointContext } from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as WorkspaceHostTesting from "../../workspaceHost/WorkspaceHostTesting.ts";
import * as CheckpointMirror from "./CheckpointMirror.ts";
import * as StoppedSandboxReads from "./StoppedSandboxReads.ts";

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const sandboxId = SandboxId.make("sbx_00000000000000000033");
const projectId = ProjectId.make("project:stopped-reads");
const checkout = `/t3-sandbox/${sandboxId}/worktrees/main`;
const firstThread = ThreadId.make("thread:stopped-reads:1");
const forkThread = ThreadId.make("thread:stopped-reads:fork");
const BIG_FILE_BYTES = 1024 * 1024 + 10;

const layerBase = Layer.mergeAll(
  VcsProcess.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "stopped-reads-test-" }),
).pipe(
  Layer.provideMerge(WorkspaceHostTesting.layerFromContext),
  Layer.provideMerge(NodeServices.layer),
);

const contextFor = (
  turns: ReadonlyArray<{ readonly ref: string; readonly turn: number }>,
): ProjectionCheckpointContext => {
  const runId = RunId.make("run:stopped-reads");
  const scopeId = CheckpointScopeId.make(`scope:stopped-reads:${turns[0]?.ref ?? "none"}`);
  return {
    runs: [{ id: runId, ordinal: 1, status: "completed" }],
    checkpointScopes: [{ id: scopeId, runId, kind: "root_run", cwd: checkout }],
    checkpoints: turns.map(({ ref, turn }) => ({
      scopeId,
      runId,
      ordinalWithinScope: turn,
      appRunOrdinal: turn,
      status: "ready" as const,
      ref: CheckpointRef.make(ref),
    })),
  };
};

const layerReads = (contexts: ReadonlyMap<ThreadId, ProjectionCheckpointContext>) =>
  StoppedSandboxReads.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getSandbox: () =>
          Effect.succeed({ id: sandboxId, projectId, state: "sleeping" } as OrchestrationV2Sandbox),
        listSandboxThreads: () =>
          Effect.succeed(
            [...contexts.keys()].map((threadId) => ({
              threadId,
              attachedAt: DateTime.makeUnsafe(0),
              archived: false,
            })),
          ),
        getCheckpointContext: (threadId) => Effect.succeed(contexts.get(threadId)!),
      }),
    ),
  );

/** A repo with one commit per entry in `commits`, each under its ref, fetched into the project's mirror. */
const seedMirror = Effect.fn("StoppedSandboxReadsTest.seedMirror")(function* (
  commits: ReadonlyArray<{
    readonly ref: string;
    readonly date: string;
    readonly files: Readonly<Record<string, string | Uint8Array>>;
  }>,
  fetched: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const source = yield* fs.makeTempDirectoryScoped({ prefix: "stopped-reads-source-" });
  const git = (cwd: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) =>
    vcs.run({
      operation: "StoppedSandboxReadsTest.git",
      command: "git",
      cwd,
      args,
      env: { ...GIT_IDENTITY, ...env },
    });
  yield* git(source, ["init", "--quiet"]);
  for (const commit of commits) {
    for (const [name, contents] of Object.entries(commit.files)) {
      yield* fs.makeDirectory(path.dirname(path.join(source, name)), { recursive: true });
      yield* typeof contents === "string"
        ? fs.writeFileString(path.join(source, name), contents)
        : fs.writeFile(path.join(source, name), contents);
    }
    yield* git(source, ["add", "-A"]);
    yield* git(source, ["commit", "--quiet", "-m", commit.ref], {
      GIT_AUTHOR_DATE: commit.date,
      GIT_COMMITTER_DATE: commit.date,
    });
    yield* git(source, ["update-ref", commit.ref, "HEAD"]);
  }
  const gitDir = CheckpointMirror.mirrorGitDir(path, stateDir, projectId);
  yield* fs.makeDirectory(gitDir, { recursive: true });
  yield* git(gitDir, ["init", "--bare", "--quiet", gitDir]);
  if (fetched.length > 0) {
    yield* git(gitDir, [
      `--git-dir=${gitDir}`,
      "fetch",
      "--quiet",
      source,
      ...fetched.map((ref) => `${ref}:${ref}`),
    ]);
  }
});

const firstRef = "refs/t3/checkpoints/stopped-reads/1";

const seedOneCheckpoint = seedMirror(
  [
    {
      ref: firstRef,
      date: "2026-01-01T00:00:00Z",
      files: {
        "README.md": "hello\n",
        "src/index.ts": "export const greeting = 'Hello';\nconst other = 'hello world';\n",
        "src/util/deep.ts": "export const deep = 1;\n",
        ".config/tool.json": "{}\n",
        "logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
        "big.txt": "a".repeat(BIG_FILE_BYTES),
      },
    },
  ],
  [firstRef],
);

it.effect("reads a stopped checkout from the mirror's checkpoint", () =>
  Effect.gen(function* () {
    yield* seedOneCheckpoint;
    const reads = yield* StoppedSandboxReads.StoppedSandboxReads.pipe(
      Effect.provide(
        layerReads(new Map([[firstThread, contextFor([{ ref: firstRef, turn: 4 }])]])),
      ),
    );
    const view = yield* reads.viewFor(checkout, sandboxId);
    assert.strictEqual(view.threadId, firstThread);
    assert.strictEqual(view.turn, 4);
    assert.strictEqual(view.prefix, "");

    const all = yield* reads.list(view, { cwd: checkout });
    assert.deepStrictEqual(
      all.entries.map((entry) => `${entry.kind}:${entry.path}`),
      [
        "directory:.config",
        "file:.config/tool.json",
        "file:big.txt",
        "file:logo.png",
        "file:README.md",
        "directory:src",
        "file:src/index.ts",
        "directory:src/util",
        "file:src/util/deep.ts",
      ],
    );
    const folder = yield* reads.list(view, { cwd: checkout, directoryPath: "src" });
    assert.deepStrictEqual(folder.entries, [
      { path: "src/index.ts", kind: "file" },
      { path: "src/util", kind: "directory" },
    ]);
    const escaped = yield* reads
      .list(view, { cwd: checkout, directoryPath: "../.." })
      .pipe(Effect.flip);
    assert.strictEqual(escaped._tag, "WorkspaceEntriesReadDirectoryError");

    const named = yield* reads.search(view, { cwd: checkout, query: "deep", limit: 10 });
    assert.deepStrictEqual(named.entries, [{ path: "src/util/deep.ts", kind: "file" }]);
    const images = yield* reads.search(view, {
      cwd: checkout,
      query: "",
      limit: 10,
      imageOnly: true,
    });
    assert.deepStrictEqual(images.entries, [{ path: "logo.png", kind: "file" }]);

    const file = yield* reads.readFile(view, { cwd: checkout, relativePath: "src/index.ts" });
    assert.deepStrictEqual(file, {
      relativePath: "src/index.ts",
      contents: "export const greeting = 'Hello';\nconst other = 'hello world';\n",
      byteLength: 62,
      truncated: false,
    });
    const absolute = yield* reads.readFile(view, {
      cwd: checkout,
      relativePath: `${checkout}/README.md`,
    });
    assert.strictEqual(absolute.contents, "hello\n");
    const big = yield* reads.readFile(view, { cwd: checkout, relativePath: "big.txt" });
    assert.strictEqual(big.truncated, true);
    assert.strictEqual(big.byteLength, BIG_FILE_BYTES);
    assert.strictEqual(big.contents.length, 1024 * 1024);
    const binary = yield* reads
      .readFile(view, { cwd: checkout, relativePath: "logo.png" })
      .pipe(Effect.flip);
    assert.strictEqual(binary._tag, "WorkspaceBinaryFileError");
    const missing = yield* reads.readFile(view, {
      cwd: checkout,
      relativePath: "nope.ts",
      allowMissing: true,
    });
    assert.strictEqual(missing.exists, false);
    const outside = yield* reads
      .readFile(view, { cwd: checkout, relativePath: "../other/secret.txt" })
      .pipe(Effect.flip);
    assert.strictEqual(outside._tag, "WorkspacePathOutsideRootError");

    const contents = yield* reads.searchContents(view, {
      cwd: checkout,
      query: "hello",
      limit: 10,
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    assert.deepStrictEqual(
      contents.matches.map((match) => [match.path, match.lineNumber, match.matchRanges]),
      [
        ["README.md", 1, [{ start: 0, end: 5 }]],
        ["src/index.ts", 1, [{ start: 25, end: 30 }]],
        ["src/index.ts", 2, [{ start: 15, end: 20 }]],
      ],
    );
    assert.strictEqual(contents.truncated, false);

    const browsed = yield* reads.browse(view, { cwd: checkout, partialPath: "./" });
    assert.deepStrictEqual(browsed, {
      parentPath: checkout,
      entries: [
        { name: ".config", fullPath: `${checkout}/.config` },
        { name: "src", fullPath: `${checkout}/src` },
      ],
    });
    const prefixed = yield* reads.browse(view, { cwd: checkout, partialPath: "./src/u" });
    assert.deepStrictEqual(prefixed.entries, [{ name: "util", fullPath: `${checkout}/src/util` }]);
  }).pipe(Effect.provide(layerBase), Effect.scoped),
);

it.effect("serves a subfolder cwd relative to the checkout's tree", () =>
  Effect.gen(function* () {
    yield* seedOneCheckpoint;
    const reads = yield* StoppedSandboxReads.StoppedSandboxReads.pipe(
      Effect.provide(
        layerReads(new Map([[firstThread, contextFor([{ ref: firstRef, turn: 4 }])]])),
      ),
    );
    const view = yield* reads.viewFor(`${checkout}/src`, sandboxId);
    assert.strictEqual(view.prefix, "src");
    const all = yield* reads.list(view, { cwd: `${checkout}/src` });
    assert.deepStrictEqual(
      all.entries.map((entry) => entry.path),
      ["index.ts", "util", "util/deep.ts"],
    );
    const file = yield* reads.readFile(view, {
      cwd: `${checkout}/src`,
      relativePath: "util/deep.ts",
    });
    assert.strictEqual(file.contents, "export const deep = 1;\n");
  }).pipe(Effect.provide(layerBase), Effect.scoped),
);

it.effect("answers SandboxAsleep while no checkpoint has reached the mirror", () =>
  Effect.gen(function* () {
    yield* seedMirror(
      [{ ref: firstRef, date: "2026-01-01T00:00:00Z", files: { "README.md": "hello\n" } }],
      [],
    );
    const reads = yield* StoppedSandboxReads.StoppedSandboxReads.pipe(
      Effect.provide(
        layerReads(new Map([[firstThread, contextFor([{ ref: firstRef, turn: 1 }])]])),
      ),
    );
    const asleep = yield* reads.viewFor(checkout, sandboxId).pipe(Effect.flip);
    assert.deepStrictEqual(
      { tag: asleep._tag, sandboxId: asleep.sandboxId, state: asleep.state },
      { tag: "SandboxAsleep", sandboxId, state: "sleeping" },
    );
  }).pipe(Effect.provide(layerBase), Effect.scoped),
);

it.effect("reads the newest checkpoint among threads sharing the checkout", () =>
  Effect.gen(function* () {
    const forkRef = "refs/t3/checkpoints/stopped-reads/fork-2";
    const pendingRef = "refs/t3/checkpoints/stopped-reads/fork-3";
    yield* seedMirror(
      [
        { ref: firstRef, date: "2026-01-01T00:00:00Z", files: { "README.md": "first\n" } },
        { ref: forkRef, date: "2026-01-02T00:00:00Z", files: { "README.md": "fork\n" } },
        { ref: pendingRef, date: "2026-01-03T00:00:00Z", files: { "README.md": "pending\n" } },
      ],
      // The fork's newest capture has not synced; the view must not name it.
      [firstRef, forkRef],
    );
    const reads = yield* StoppedSandboxReads.StoppedSandboxReads.pipe(
      Effect.provide(
        layerReads(
          new Map([
            [firstThread, contextFor([{ ref: firstRef, turn: 7 }])],
            [
              forkThread,
              contextFor([
                { ref: forkRef, turn: 2 },
                { ref: pendingRef, turn: 3 },
              ]),
            ],
          ]),
        ),
      ),
    );
    const view = yield* reads.viewFor(checkout, sandboxId);
    assert.deepStrictEqual(
      { threadId: view.threadId, turn: view.turn },
      { threadId: forkThread, turn: 2 },
    );
    const file = yield* reads.readFile(view, { cwd: checkout, relativePath: "README.md" });
    assert.strictEqual(file.contents, "fork\n");
  }).pipe(Effect.provide(layerBase), Effect.scoped),
);
