import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ChiefOfStaffAudit from "./ChiefOfStaffAudit.ts";

const auditLayer = () =>
  ChiefOfStaffAudit.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-cos-audit-" })),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("redacts secret-looking keys at any depth", () =>
  Effect.gen(function* () {
    const audit = yield* ChiefOfStaffAudit.ChiefOfStaffAudit;
    yield* audit.record({
      via: "voice",
      tool: "probe",
      args: {
        authorization: "Bearer abc",
        nested: { api_key: "k", password: "p", cookie: "c", keep: "yes" },
        list: [{ secret: "s" }, "plain"],
      },
      outcome: "ok",
      durationMs: 3,
    });
    const [entry] = yield* audit.recent();
    assert.deepStrictEqual(JSON.parse(entry!.args), {
      authorization: "[redacted]",
      nested: { api_key: "[redacted]", password: "[redacted]", cookie: "[redacted]", keep: "yes" },
      list: [{ secret: "[redacted]" }, "plain"],
    });
  }).pipe(Effect.provide(auditLayer())),
);

it.effect("truncates serialized args to 1000 characters", () =>
  Effect.gen(function* () {
    const audit = yield* ChiefOfStaffAudit.ChiefOfStaffAudit;
    yield* audit.record({
      via: "voice",
      tool: "probe",
      args: { blob: "x".repeat(5_000) },
      outcome: "ok",
      durationMs: 1,
    });
    const [entry] = yield* audit.recent();
    assert.lengthOf(entry!.args, 1_000);
  }).pipe(Effect.provide(auditLayer())),
);

it.effect("records a risky call's confirmation decision", () =>
  Effect.gen(function* () {
    const audit = yield* ChiefOfStaffAudit.ChiefOfStaffAudit;
    yield* audit.record({
      via: "home-thread",
      memberId: "member-1",
      threadId: "thread:home",
      tool: "t3_project_delete",
      args: { projectId: "project:1" },
      outcome: "error",
      errorCode: "capability_denied",
      confirmation: "denied",
      durationMs: 4,
    });
    const [entry] = yield* audit.recent();
    assert.equal(entry!.confirmation, "denied");
  }).pipe(Effect.provide(auditLayer())),
);

it.effect("returns the newest entries first and filters by tool", () =>
  Effect.gen(function* () {
    const audit = yield* ChiefOfStaffAudit.ChiefOfStaffAudit;
    for (const tool of ["a", "b", "c"]) {
      yield* audit.record({ via: "voice", tool, args: {}, outcome: "ok", durationMs: 1 });
    }
    assert.deepStrictEqual(
      (yield* audit.recent()).map((entry) => entry.tool),
      ["c", "b", "a"],
    );
    assert.deepStrictEqual(
      (yield* audit.recent({ tool: "b" })).map((entry) => entry.tool),
      ["b"],
    );
    assert.deepStrictEqual(
      (yield* audit.recent({ limit: 2 })).map((entry) => entry.tool),
      ["c", "b"],
    );
  }).pipe(Effect.provide(auditLayer())),
);

it.effect("rotates at 5 MB and reads newest across both files", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const audit = yield* ChiefOfStaffAudit.ChiefOfStaffAudit;
    const directory = path.join(config.stateDir, "chief-of-staff");
    const file = path.join(directory, "audit.jsonl");
    const rotated = path.join(directory, "audit.1.jsonl");
    const old = {
      at: "2020-01-01T00:00:00.000Z",
      via: "voice",
      tool: "old",
      args: "y".repeat(5 * 1024 * 1024),
      outcome: "ok",
      durationMs: 1,
    };
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.writeFileString(file, `${JSON.stringify(old)}\n`);
    yield* audit.record({
      via: "home-thread",
      memberId: "member-1",
      threadId: "thread:home",
      tool: "new",
      args: {},
      outcome: "ok",
      durationMs: 2,
    });
    assert.isTrue(yield* fileSystem.exists(rotated));
    assert.include(yield* fileSystem.readFileString(file), '"tool":"new"');
    assert.notInclude(yield* fileSystem.readFileString(file), '"tool":"old"');
    assert.deepStrictEqual(
      (yield* audit.recent({ limit: 4 })).map((entry) => entry.tool),
      ["new", "old"],
    );
    assert.deepStrictEqual(
      (yield* audit.recent({ tool: "old" })).map((entry) => entry.tool),
      ["old"],
    );
  }).pipe(Effect.provide(auditLayer())),
);
