// @effect-diagnostics nodeBuiltinImport:off - Builds real symlinks in a temp directory.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { renderCliShim, repairCommandLinks } from "./DesktopCliShim.ts";

const launcher = (path: string, executable: string, home: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const content = renderCliShim({
    target: { kind: "direct", executable, entry: "/app/bin.mjs" },
    shimPath: path,
    t3Home: home,
  });
  NodeFS.writeFileSync(path, content, { mode: 0o755 });
  return content;
};

it.effect("repoints t3 links that run this app through a stale launcher", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-repair-"));
    try {
      const app = "/Applications/Pair.app/Contents/MacOS/Pair";
      const current = `${root}/pair-app/bin/t3`;
      const content = launcher(current, app, `${root}/pair-app`);
      launcher(`${root}/t3/bin/t3`, app, `${root}/t3`);
      launcher(`${root}/other/bin/t3`, "/Applications/Other.app/Contents/MacOS/Other", root);
      NodeFS.writeFileSync(`${root}/foreign`, "#!/bin/sh\necho hi\n", { mode: 0o755 });
      const [stale, other, foreign, fine] = ["stale", "other", "foreign", "fine"].map((name) => {
        NodeFS.mkdirSync(`${root}/${name}-bin`);
        return `${root}/${name}-bin`;
      });
      NodeFS.symlinkSync(`${root}/t3/bin/t3`, `${stale}/t3`);
      NodeFS.symlinkSync(`${root}/other/bin/t3`, `${other}/t3`);
      NodeFS.symlinkSync(`${root}/foreign`, `${foreign}/t3`);
      NodeFS.symlinkSync(current, `${fine}/t3`);

      const repaired = yield* repairCommandLinks({
        directories: [stale!, other!, foreign!, fine!, `${root}/missing`],
        shimPath: current,
        content,
      });

      expect(repaired).toEqual([`${stale}/t3`]);
      expect(NodeFS.readlinkSync(`${stale}/t3`)).toBe(current);
      expect(NodeFS.readlinkSync(`${other}/t3`)).toBe(`${root}/other/bin/t3`);
      expect(NodeFS.readlinkSync(`${foreign}/t3`)).toBe(`${root}/foreign`);
      expect(NodeFS.readdirSync(stale!)).toEqual(["t3"]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
