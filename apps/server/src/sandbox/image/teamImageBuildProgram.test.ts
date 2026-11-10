import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  TEAM_IMAGE_NO_SUDO_EXIT_CODE,
  TeamImageBuildOutput,
  teamImageBuildProgram,
} from "./teamImageBuildProgram.ts";

const STUBS: Record<string, string> = {
  id: "echo t3",
  // Ownership and system paths are the machine's; here they are plain directories.
  sudo: [
    // `sudo -n` fails when SUDO_BROKEN is set, as on a machine whose setuid bits are ignored.
    'if [ "$1" = -n ]; then [ -z "${SUDO_BROKEN:-}" ] || exit 1; shift; fi',
    'case "$1" in',
    '  install) for last; do :; done; mkdir -p "$last" ;;',
    "  chown) ;;",
    '  *) exec "$@" ;;',
    "esac",
  ].join("\n"),
  git: [
    'printf "%s\\n" "$*" >>"$HOME/../git-calls"',
    'while [ "$1" = -c ]; do shift 2; done',
    'case "$1" in',
    '  clone) mkdir -p "$4" ;;',
    "  -C) echo 0123456789abcdef0123456789abcdef01234567 ;;",
    "esac",
  ].join("\n"),
  claude: "echo 2.0.0",
  codex: "echo 0.50.0",
};

const runBuild = Effect.fn("teamImageBuildProgram.test.runBuild")(function* (
  install: string,
  env: Record<string, string> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-build-program-" });
  const home = `${root}/home`;
  yield* fs.makeDirectory(`${home}/.t3-build`, { recursive: true });
  yield* fs.makeDirectory(`${root}/bin`);
  for (const [name, body] of Object.entries(STUBS)) {
    yield* fs.writeFileString(`${root}/bin/${name}`, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }
  yield* fs.writeFileString(
    `${root}/pair-image.json`,
    '{"pairVersion":"1.2.3","providers":{"claudeAgent":"2.0.0","codex":"0.50.0"}}',
  );
  yield* fs.writeFileString(`${home}/.t3-build/install.sh`, install);
  yield* fs.writeFileString(
    `${home}/.t3-build/t3-build.sh`,
    teamImageBuildProgram({
      buildId: "tib_0123",
      repos: [
        {
          projectId: "project-1",
          url: "https://github.com/acme/web",
          path: `${root}/image/github.com/acme/web`,
          tokenVariable: "T3_CLONE_TOKEN_0",
        },
      ],
      excludedEnvNames: ["NPM_TOKEN", "T3_CLONE_TOKEN_0"],
      leakCheckNames: ["NPM_TOKEN", "T3_CLONE_TOKEN_0"],
      paths: {
        imageRoot: `${root}/image`,
        output: `${root}/etc/build.json`,
        baseInfo: `${root}/pair-image.json`,
      },
    }),
  );
  const child = yield* spawner.spawn(
    ChildProcess.make("bash", [`${home}/.t3-build/t3-build.sh`], {
      cwd: home,
      env: {
        HOME: home,
        PATH: `${root}/bin:${yield* Config.String("PATH").pipe(Config.withDefault("/usr/bin:/bin"))}`,
        NPM_TOKEN: "npm-secret-value",
        T3_CLONE_TOKEN_0: "clone-token-value",
        ...env,
      },
    }),
  );
  const { output, exitCode } = yield* Effect.all(
    {
      output: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      exitCode: child.exitCode.pipe(Effect.map(Number)),
    },
    { concurrency: "unbounded" },
  );
  const phases = output
    .split("\n")
    .filter((line) => line.startsWith("::t3-phase::"))
    .map((line) => line.slice("::t3-phase::".length));
  const result =
    exitCode === 0
      ? yield* fs
          .readFileString(`${root}/etc/build.json`)
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(TeamImageBuildOutput))),
          )
      : null;
  return {
    output,
    exitCode,
    phases,
    leaks: output
      .split("\n")
      .filter((line) => line.startsWith("::t3-leak::"))
      .map((line) =>
        line.slice("::t3-leak::".length).replace(home, "$HOME").replace(root, "$ROOT"),
      ),
    result,
    gitCalls: yield* fs.readFileString(`${root}/git-calls`).pipe(Effect.orElseSucceed(() => "")),
    buildDirLeft: yield* fs.exists(`${home}/.t3-build`),
  };
});

describe("teamImageBuildProgram", () => {
  it.live("runs every phase and records the env the install added", () =>
    Effect.gen(function* () {
      const build = yield* runBuild(
        [
          `echo 'export PATH="$HOME/.local/bin:$PATH"' >>"$HOME/.profile"`,
          `echo 'export TOOL_HOME=/opt/tool' >>"$HOME/.profile"`,
          `echo "export NPM_TOKEN=$NPM_TOKEN" >>"$HOME/.profile"`,
        ].join("\n"),
      );
      assert.strictEqual(build.exitCode, 0, build.output);
      assert.deepStrictEqual(build.phases, [
        "preflight",
        "clone",
        "install",
        "env",
        "verify",
        "clean",
        "manifest",
      ]);
      const result = build.result!;
      assert.strictEqual(result.buildId, "tib_0123");
      assert.match(result.imageEnv.PATH ?? "", /\/home\/\.local\/bin:/);
      assert.strictEqual(result.imageEnv.TOOL_HOME, "/opt/tool");
      assert.notProperty(result.imageEnv, "NPM_TOKEN");
      assert.deepStrictEqual(result.providers, { claudeAgent: "2.0.0", codex: "0.50.0" });
      assert.deepStrictEqual(
        result.repos.map((repo) => [repo.projectId, repo.headSha]),
        [["project-1", "0123456789abcdef0123456789abcdef01234567"]],
      );
      // The helper reads the token from the env; it is never on a command line or in the log.
      assert.include(build.gitCalls, "${T3_CLONE_TOKEN_0}");
      assert.notInclude(build.gitCalls, "clone-token-value");
      assert.notInclude(build.output, "npm-secret-value");
      assert.isFalse(build.buildDirLeft);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("stops at preflight when the build user can't use sudo", () =>
    Effect.gen(function* () {
      const build = yield* runBuild("exit 0", { SUDO_BROKEN: "1" });
      assert.strictEqual(build.exitCode, TEAM_IMAGE_NO_SUDO_EXIT_CODE);
      assert.deepStrictEqual(build.phases, ["preflight"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("stops at install when the install script fails", () =>
    Effect.gen(function* () {
      const build = yield* runBuild("exit 7");
      assert.strictEqual(build.exitCode, 7);
      assert.deepStrictEqual(build.phases, ["preflight", "clone", "install"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fails at clean naming every secret and file, and never prints a value", () =>
    Effect.gen(function* () {
      const build = yield* runBuild(
        [
          `echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" >"$HOME/.npmrc"`,
          `mkdir -p "$HOME/.config/tool" && echo "$T3_CLONE_TOKEN_0" >"$HOME/.config/tool/auth"`,
          `echo 'NPM_TOKEN=\${NPM_TOKEN}' >"$HOME/.netrc"`,
        ].join("\n"),
      );
      assert.strictEqual(build.exitCode, 3, build.output);
      assert.deepStrictEqual(build.phases, [
        "preflight",
        "clone",
        "install",
        "env",
        "verify",
        "clean",
      ]);
      // `.netrc` holds the text `${NPM_TOKEN}`, not the value, so it is not a hit.
      assert.deepStrictEqual([...build.leaks].toSorted(), [
        "NPM_TOKEN::$HOME/.npmrc",
        "T3_CLONE_TOKEN_0::$HOME/.config/tool/auth",
      ]);
      assert.notInclude(build.output, "npm-secret-value");
      assert.notInclude(build.output, "clone-token-value");
      assert.isTrue(build.buildDirLeft);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fails when an exported secret reaches the manifest's imageEnv", () =>
    Effect.gen(function* () {
      const build = yield* runBuild(`echo "export REGISTRY_AUTH=$NPM_TOKEN" >>"$HOME/.profile"`);
      assert.strictEqual(build.exitCode, 3, build.output);
      assert.strictEqual(build.phases.at(-1), "manifest");
      assert.deepStrictEqual(build.leaks, ["NPM_TOKEN::$ROOT/etc/build.json"]);
      assert.notInclude(build.output, "npm-secret-value");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
