import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { MemberId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import { homeThreadsFile, loadHomeThreads, parseHomeThreads } from "./homeThreads.ts";

it("maps each home key to its member and thread", () => {
  const index = parseHomeThreads(
    JSON.stringify({ "home:member-a": "thread-1", "home:member-b": "thread-2" }),
  );
  expect(index.memberIdForThread("thread-1")).toBe(MemberId.make("member-a"));
  expect(index.threadIdForMember(MemberId.make("member-b"))).toBe("thread-2");
  expect(index.hasHomeThread(MemberId.make("member-a"))).toBe(true);
  expect(index.memberIdForThread("thread-9")).toBeUndefined();
  expect(index.hasHomeThread(MemberId.make("member-c"))).toBe(false);
});

it("ignores keys that are not homes and values that are not thread ids", () => {
  const index = parseHomeThreads(
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
    const index = parseHomeThreads(contents);
    expect(index.hasHomeThread(MemberId.make("member-a"))).toBe(false);
    expect(index.memberIdForThread("thread-1")).toBeUndefined();
  }
});

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
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-home-threads-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
