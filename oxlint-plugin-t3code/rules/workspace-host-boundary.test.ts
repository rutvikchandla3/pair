import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/workspace-host-boundary");

describe("t3code/workspace-host-boundary", () => {
  rule.valid(
    "allows type-only imports of host modules",
    `
      import type * as NodeFs from "node:fs";
      import { type ChildProcess } from "node:child_process";

      export type Stats = NodeFs.Stats;
      export type Child = ChildProcess;
    `,
  );

  rule.valid(
    "allows type references to host services and unrelated process members",
    `
      import type * as FileSystem from "effect/FileSystem";
      import * as HostProcess from "@t3tools/shared/HostProcess";

      declare const env: { process: string };
      export type Fs = FileSystem.FileSystem;
      export const name = env.process;
      export const other = process.envx;
      export const hostname = HostProcess.Hostname;
    `,
  );

  rule.valid(
    "allows a file-level disable with a known reason prefix",
    `
      /* oxlint-disable t3code/workspace-host-boundary -- server-scoped: logs */
      import * as NodeFs from "node:fs";

      export const read = NodeFs.readFileSync;
    `,
  );

  for (const source of [
    "node:child_process",
    "child_process",
    "node:fs",
    "fs",
    "node:fs/promises",
    "fs/promises",
    "node-pty",
  ]) {
    rule.invalid(
      `reports a value import from ${source}`,
      `
        import * as Host from "${source}";

        export const host = Host;
      `,
      (output) => {
        assert.match(output, /WorkspaceHosts\.forPath\(cwd\)/);
      },
    );
  }

  rule.invalid(
    "reports ChildProcessSpawner and PtyAdapter services",
    `
      import * as Effect from "effect/Effect";
      import { ChildProcessSpawner } from "effect/process";
      import * as PtyAdapter from "./PtyAdapter.ts";

      export const program = Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const pty = yield* PtyAdapter.PtyAdapter;
        return [spawner, pty];
      });
    `,
    (output) => {
      assert.match(output, /instead of ChildProcessSpawner/);
      assert.match(output, /instead of PtyAdapter/);
    },
  );

  rule.invalid(
    "reports HostProcess host facts",
    `
      import * as Effect from "effect/Effect";
      import * as Host from "@t3tools/shared/HostProcess";

      export const program = Effect.gen(function* () {
        const platform = yield* Host.Platform;
        const home = yield* Host.HomeDirectory;
        const env = yield* Host.Environment;
        const windows = yield* Host.isWindows;
        return [platform, home, env, windows];
      });
    `,
    (output) => {
      for (const fact of ["Platform", "HomeDirectory", "Environment", "isWindows"]) {
        assert.match(output, new RegExp(`not HostProcess\\.${fact}`));
      }
    },
  );

  rule.invalid(
    "reports process.env and globalThis.process.env",
    `
      export const home = process.env.HOME;
      export const path = globalThis.process.env.PATH;
    `,
    (output) => {
      assert.match(output, /host\.info\.environment/);
    },
  );

  rule.invalid(
    "reports the FileSystem service",
    `
      import * as Effect from "effect/Effect";
      import * as FileSystem from "effect/FileSystem";

      export const program = Effect.gen(function* () {
        return yield* FileSystem.FileSystem;
      });
    `,
    (output) => {
      assert.match(output, /host\.fileSystem/);
    },
  );
});
