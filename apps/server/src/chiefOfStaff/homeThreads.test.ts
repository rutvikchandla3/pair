import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { parseHomeThreads, readHomeThreads } from "./homeThreads.ts";

it("keeps only home:<member> keys, mapped to their thread", () => {
  assert.deepStrictEqual(
    [
      ...parseHomeThreads(
        JSON.stringify({ "home:m1": "t1", other: "x", "m2:codex": "t2", "home:m2": "t3" }),
      ),
    ],
    [
      ["t1", "m1"],
      ["t3", "m2"],
    ],
  );
  assert.lengthOf(parseHomeThreads("{"), 0);
  assert.lengthOf(parseHomeThreads(JSON.stringify(["home:m1"])), 0);
});

const homeLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-cos-home-threads-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("rereads threads.json only after five seconds", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const file = path.join(config.stateDir, "chief-of-staff", "threads.json");
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(file, JSON.stringify({ "home:m1": "t1" }));
    assert.strictEqual((yield* readHomeThreads).get("t1"), "m1");
    yield* fileSystem.writeFileString(file, JSON.stringify({ "home:m1": "t2" }));
    assert.strictEqual((yield* readHomeThreads).get("t2"), undefined);
    assert.strictEqual((yield* readHomeThreads).get("t1"), "m1");
    yield* TestClock.adjust(Duration.seconds(6));
    assert.strictEqual((yield* readHomeThreads).get("t2"), "m1");
  }).pipe(Effect.provide(homeLayer)),
);
