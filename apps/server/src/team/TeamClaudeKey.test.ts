import { assert, it } from "@effect/vitest";
import { MemberId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type * as Members from "../persistence/Members.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TeamClaudeKeyModule from "./TeamClaudeKey.ts";
import { SpaceAgentKeyMissingError, TeamClaudeKey, make } from "./TeamClaudeKey.ts";
import * as TeamState from "./TeamState.ts";

const admin = MemberId.make("member-owner");
const viewer = MemberId.make("member-viewer");
const member = (
  id: MemberId,
  role: "admin" | "member",
  isOwner: boolean,
): Members.MemberRecord => ({
  id,
  name: id,
  role,
  gitName: null,
  gitEmail: null,
  isOwner,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
  removedAt: null,
});

/** Answers every `/v1/models` check with the next status and records what it was sent. */
const harness = (options: { statuses?: Array<number>; legacyKey?: string } = {}) => {
  const checks: Array<{ url: string; key: string | undefined }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      checks.push({ url: request.url, key: request.headers["x-api-key"] });
      return HttpClientResponse.fromWeb(
        request,
        new Response("{}", { status: options.statuses?.shift() ?? 200 }),
      );
    }),
  );
  const layer = Layer.mergeAll(
    ServerSecretStore.layerMemory(),
    TeamState.layerTest([member(admin, "admin", true), member(viewer, "member", false)]),
    Layer.succeed(HttpClient.HttpClient, http),
    ServerSettings.layerTest({
      providerInstances: {
        [ProviderInstanceId.make("team")]: {
          driver: "claudeAgent",
          environment:
            options.legacyKey === undefined
              ? []
              : [
                  { name: "ANTHROPIC_API_KEY", value: options.legacyKey, sensitive: true },
                  {
                    name: "ANTHROPIC_BASE_URL",
                    value: "https://gateway.example",
                    sensitive: false,
                  },
                ],
        },
      },
    }),
    SqlitePersistence.layerMemory,
  );
  return { checks, layer };
};

it.effect("refuses a non-admin and stores nothing", () => {
  const { checks, layer } = harness();
  return Effect.gen(function* () {
    const key = yield* make;
    const refused = yield* Effect.flip(key.set(viewer, Redacted.make("sk-ant-team-abcd")));
    assert.strictEqual(refused.reason, "not-admin");
    const removed = yield* Effect.flip(key.remove(viewer));
    assert.strictEqual(removed.reason, "not-admin");
    assert.lengthOf(checks, 0);
    assert.strictEqual((yield* key.status).state, "unset");
  }).pipe(Effect.provide(layer));
});

it.effect("checks the key with Anthropic and stores only what Anthropic accepts", () => {
  const { checks, layer } = harness({ statuses: [401, 503, 200] });
  return Effect.gen(function* () {
    const key = yield* make;
    const rejected = yield* Effect.flip(key.set(admin, Redacted.make(" sk-ant-team-abcd ")));
    assert.deepStrictEqual(
      [rejected.reason, rejected.message],
      ["rejected", "Anthropic rejected this key"],
    );
    assert.strictEqual(
      (yield* Effect.flip(key.set(admin, Redacted.make("sk-ant-team-abcd")))).reason,
      "unreachable",
    );
    assert.strictEqual((yield* key.status).state, "unset");
    assert.strictEqual(
      (yield* Effect.flip(key.set(admin, Redacted.make("   ")))).reason,
      "invalid",
    );
    assert.strictEqual(
      (yield* Effect.flip(key.set(admin, Redacted.make("x".repeat(513))))).reason,
      "invalid",
    );

    const status = yield* key.set(admin, Redacted.make("sk-ant-team-abcd"));
    assert.deepStrictEqual(checks, [
      { url: "https://api.anthropic.com/v1/models", key: "sk-ant-team-abcd" },
      { url: "https://api.anthropic.com/v1/models", key: "sk-ant-team-abcd" },
      { url: "https://api.anthropic.com/v1/models", key: "sk-ant-team-abcd" },
    ]);
    assert.strictEqual(status.state === "set" ? status.last4 : null, "abcd");
    assert.notInclude(JSON.stringify(status), "sk-ant-team");
    assert.notInclude(JSON.stringify(yield* key.status), "sk-ant-team");
    const endpoint = yield* key.endpoint;
    assert.strictEqual(Redacted.value(endpoint.apiKey), "sk-ant-team-abcd");
    assert.strictEqual(endpoint.baseUrl, "https://api.anthropic.com");
  }).pipe(Effect.provide(layer));
});

it.effect("counts active spaces on every status", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const key = yield* make;
    assert.strictEqual((yield* key.status).activeSpaceCount, 0);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_spaces
        (space_id, room_thread_id, owner_id, archived_at, updated_at, payload_json)
      VALUES
        ('space-a', 'room-a', 'member-owner', NULL, '2026-11-13T00:00:00.000Z', '{}'),
        ('space-b', 'room-b', 'member-owner', '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z', '{}')
    `;
    assert.strictEqual((yield* key.status).activeSpaceCount, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("imports the legacy instance key once, and never after Remove", () => {
  const { checks, layer } = harness({ legacyKey: "sk-ant-team-wxyz" });
  return Effect.gen(function* () {
    const first = yield* make;
    const imported = yield* first.status;
    assert.strictEqual(imported.state, "set");
    if (imported.state === "set") {
      assert.strictEqual(imported.last4, "wxyz");
      assert.strictEqual(imported.addedBy, admin);
    }
    const endpoint = yield* first.endpoint;
    assert.strictEqual(endpoint.baseUrl, "https://gateway.example");
    assert.lengthOf(checks, 0);

    assert.strictEqual((yield* first.remove(admin)).state, "unset");
    const restarted = yield* make;
    assert.strictEqual((yield* restarted.status).state, "unset");
    assert.instanceOf(yield* Effect.flip(restarted.endpoint), SpaceAgentKeyMissingError);
  }).pipe(Effect.provide(layer));
});

it.effect("fails endpoint while no key is set", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const key = yield* TeamClaudeKey;
    assert.instanceOf(yield* Effect.flip(key.endpoint), SpaceAgentKeyMissingError);
  }).pipe(Effect.provide(Layer.provideMerge(TeamClaudeKeyModule.layer, layer)));
});
