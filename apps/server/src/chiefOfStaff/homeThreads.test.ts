import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { MemberId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import {
  homeThreadsFile,
  indexHomeThreads,
  invalidateHomeThreads,
  loadHomeThreads,
  parseHomeThreads,
  readHomeThreads,
} from "./homeThreads.ts";

const homeThreadsView = (contents: string) => indexHomeThreads(parseHomeThreads(contents));

it("maps each home key to its member and thread", () => {
  const index = homeThreadsView(
    JSON.stringify({ "home:member-a": "thread-1", "home:member-b": "thread-2" }),
  );
  expect(index.memberIdForThread("thread-1")).toBe(MemberId.make("member-a"));
  expect(index.threadIdForMember(MemberId.make("member-b"))).toBe("thread-2");
  expect(index.hasHomeThread(MemberId.make("member-a"))).toBe(true);
  expect(index.memberIdForThread("thread-9")).toBeUndefined();
  expect(index.hasHomeThread(MemberId.make("member-c"))).toBe(false);
});

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
});

it("ignores keys that are not homes and values that are not thread ids", () => {
  const index = homeThreadsView(
    JSON.stringify({
      voice: "thread-1",
      "home:": "thread-2",
      "home:member-a": "",
      "home:member-b": 7,
      "home:member-c": "thread-3",
    }),
  );
  expect(index.memberIdForThread("thread-1")).toBeUndefined();
  expect(index.threadIdForMember(MemberId.make("member-a"))).toBeUndefined();
  expect(index.memberIdForThread("thread-3")).toBe(MemberId.make("member-c"));
});

it("treats unreadable contents as no home threads", () => {
  for (const contents of ["", "not json", "[]", "null", '"home:member-a"']) {
    const index = homeThreadsView(contents);
    expect(index.hasHomeThread(MemberId.make("member-a"))).toBe(false);
    expect(index.memberIdForThread("thread-1")).toBeUndefined();
    assert.lengthOf(parseHomeThreads(contents), 0);
  }
});

const homeLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-cos-home-threads-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("reads the home threads file from the state directory", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = homeThreadsFile(config.stateDir, path);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, JSON.stringify({ "home:member-a": "thread-1" }));
    const index = yield* loadHomeThreads;
    expect(index.memberIdForThread("thread-1")).toBe(MemberId.make("member-a"));
  }).pipe(Effect.provide(homeLayer)),
);

it.effect("rereads threads.json only after five seconds", () =>
  Effect.gen(function* () {
    invalidateHomeThreads();
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const file = homeThreadsFile(config.stateDir, path);
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

it.effect("sees a written home thread at once after invalidating", () =>
  Effect.gen(function* () {
    invalidateHomeThreads();
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const file = homeThreadsFile(config.stateDir, path);
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(file, JSON.stringify({ "home:m1": "t1" }));
    assert.strictEqual((yield* readHomeThreads).get("t1"), "m1");
    // A new home thread written inside the TTL window is invisible until invalidated.
    yield* fileSystem.writeFileString(file, JSON.stringify({ "home:m1": "t1", "home:m2": "t2" }));
    assert.strictEqual((yield* readHomeThreads).get("t2"), undefined);
    invalidateHomeThreads();
    assert.strictEqual((yield* readHomeThreads).get("t2"), "m2");
  }).pipe(Effect.provide(homeLayer)),
);
