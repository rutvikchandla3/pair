import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { TeamImageBuildLogChunk } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as TeamImageBuildLog from "./TeamImageBuildLog.ts";

const withLog = <A, E>(
  use: (
    log: TeamImageBuildLog.TeamImageBuildLog["Service"],
    stateDir: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-build-log-" });
    const log = yield* TeamImageBuildLog.make.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        stateDir,
      } as ServerConfig.ServerConfig["Service"]),
    );
    return yield* use(log, stateDir);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("TeamImageBuildLog", () => {
  it.effect("streams to a reader while open, keeps phases out, and is a file after", () =>
    withLog((log, stateDir) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const writer = yield* log
          .open(4, ["hunter2-token", "a\nb-multi-line-key"])
          .pipe(Scope.provide(scope));
        assert.strictEqual(yield* writer.write("::t3-phase::clone"), "clone");
        assert.isNull(yield* writer.write("Cloning into web"));

        const chunks = yield* Queue.unbounded<TeamImageBuildLogChunk>();
        const reader = yield* log.read(4).pipe(
          Stream.runForEach((chunk) => Queue.offer(chunks, chunk)),
          Effect.forkChild,
        );
        assert.deepStrictEqual(yield* Queue.take(chunks), {
          text: "Cloning into web\n",
          done: false,
        });
        // The file, the live reader and the tail all see stars; a one-character line is no secret.
        yield* writer.write("token hunter2-token and b-multi-line-key, a");
        assert.deepStrictEqual(yield* Queue.take(chunks), {
          text: "token *** and ***, a\n",
          done: false,
        });
        assert.deepStrictEqual(yield* writer.tail, ["Cloning into web", "token *** and ***, a"]);
        yield* writer.write("done");
        yield* Scope.close(scope, Exit.void);
        yield* Fiber.join(reader);
        const rest = yield* Queue.takeAll(chunks);
        assert.strictEqual(rest.map((chunk) => chunk.text).join(""), "done\n");
        assert.isTrue(rest.at(-1)?.done);

        const after = yield* Stream.runCollect(log.read(4));
        assert.deepStrictEqual(after, [
          { text: "Cloning into web\ntoken *** and ***, a\ndone\n", done: true },
        ]);
        const fs = yield* FileSystem.FileSystem;
        assert.isTrue(yield* fs.exists(`${stateDir}/team-image/builds/4.log`));
      }),
    ),
  );

  it.effect("keeps the first MiB and the last 4 MiB, naming what it left out", () =>
    withLog((log) =>
      Effect.gen(function* () {
        const line = (index: number) => `${String(index).padStart(4, "0")}${"x".repeat(65_531)}`;
        const scope = yield* Scope.make();
        const writer = yield* log.open(1, []).pipe(Scope.provide(scope));
        // 65,536 bytes a line with its newline: 16 lines fill the file, 64 the ring.
        for (let index = 0; index < 100; index++) yield* writer.write(line(index));
        assert.deepStrictEqual((yield* writer.tail).length, 30);
        yield* Scope.close(scope, Exit.void);

        const [chunk] = yield* Stream.runCollect(log.read(1));
        const lines = chunk!.text.split("\n").filter((text) => text !== "");
        assert.deepStrictEqual(
          lines.map((text) => text.slice(0, 4)),
          [
            ...Array.from({ length: 16 }, (_, index) => line(index).slice(0, 4)),
            "… 13",
            ...Array.from({ length: 64 }, (_, index) => line(index + 36).slice(0, 4)),
          ],
        );
        assert.strictEqual(lines[16], `… ${20 * 65_536} bytes left out …`);
      }),
    ),
  );
});
