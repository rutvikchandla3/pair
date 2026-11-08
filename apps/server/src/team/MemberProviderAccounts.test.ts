import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ManagedPolicyDocument,
  MemberId,
  type MemberProviderAccountResult,
  ProviderDriverKind,
  ProviderInstanceId,
  type TeamError,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import type * as Members from "../persistence/Members.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MemberProviderAccounts from "./MemberProviderAccounts.ts";
import * as TeamMembers from "./TeamMembers.ts";
import * as TeamState from "./TeamState.ts";

const member = (id: string, name: string, role: "admin" | "member"): Members.MemberRecord => ({
  id: MemberId.make(id),
  name,
  role,
  gitName: null,
  gitEmail: null,
  isOwner: role === "admin",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
  removedAt: null,
});
const alice = member("member-alice", "Alice", "admin");
const bob = member("member-bob", "Bob", "member");

const secretName = (instanceId: string, variable: string) =>
  `provider-env-${Buffer.from(instanceId).toString("base64url")}-${Buffer.from(variable).toString("base64url")}`;

const harness = (policy?: ManagedPolicyDocument) => {
  const revoked: Array<{ readonly instanceId: string; readonly homeExisted: boolean }> = [];
  const watched: { home?: string } = {};
  const layer = MemberProviderAccounts.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        TeamState.layerTest([alice, bob]),
        Layer.mock(TeamMembers.TeamMembers)({ streamChanges: Stream.empty }),
        Layer.unwrap(
          Effect.map(FileSystem.FileSystem, (fs) =>
            Layer.mock(ProviderAuthService.ProviderAuthService)({
              revoke: ({ instanceId }) =>
                (watched.home === undefined ? Effect.succeed(false) : fs.exists(watched.home)).pipe(
                  Effect.orDie,
                  Effect.map((homeExisted) => {
                    revoked.push({ instanceId, homeExisted });
                  }),
                ),
            }),
          ),
        ),
      ),
    ),
    Layer.provideMerge(ServerSettings.layer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(ManagedPolicy.layerTest(policy)),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-member-accounts-test-" })),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return { revoked, watched, layer };
};

const reasonOf = (effect: Effect.Effect<MemberProviderAccountResult, TeamError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

it.effect(
  "gives a member's Claude its own 0700 home under the state dir and a redacted token",
  () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const accounts = yield* MemberProviderAccounts.MemberProviderAccounts;
      const settings = yield* ServerSettings.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const token = "sk-ant-oat01-member-test-token";

      const { instanceId } = yield* accounts.mutate(bob.id, {
        operation: "create",
        driver: "claudeAgent",
        token,
      });
      assert.match(instanceId, /^claudeAgent-bob-[0-9a-f]{4}$/);
      const saved = (yield* settings.getSettings).providerInstances[instanceId]!;
      const home = path.join(config.stateDir, "providers", "claudeAgent", instanceId, "home");
      assert.deepEqual(saved.config, { homePath: home });
      assert.equal(saved.ownerMemberId, bob.id);
      assert.equal(saved.displayName, "Bob's Claude");
      assert.equal(((yield* fs.stat(home)).mode & 0o777).toString(8), "700");
      assert.deepInclude(saved.environment?.[0], {
        name: "CLAUDE_CODE_OAUTH_TOKEN",
        sensitive: true,
      });

      for (const secretReferences of [true, false]) {
        const client = ServerSettings.redactServerSettingsForClient(yield* settings.getSettings, {
          secretReferences,
          settingsWriter: true,
        });
        assert.notInclude(JSON.stringify(client), token);
      }
      assert.notInclude(yield* fs.readFileString(config.settingsPath), token);
      assert.isTrue(
        Option.isSome(yield* secrets.get(secretName(instanceId, "CLAUDE_CODE_OAUTH_TOKEN"))),
      );

      yield* accounts.mutate(bob.id, { operation: "update", instanceId, token: "sk-ant-api-key" });
      const updated = (yield* settings.getSettings).providerInstances[instanceId]!;
      assert.deepEqual(
        updated.environment?.map(({ name, value }) => ({ name, value })),
        [{ name: "ANTHROPIC_API_KEY", value: "sk-ant-api-key" }],
      );
      yield* accounts.mutate(bob.id, { operation: "update", instanceId, token: null });
      assert.isUndefined((yield* settings.getSettings).providerInstances[instanceId]?.environment);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("keeps members to their own accounts and to the managed policy", () => {
  const { layer } = harness({
    schemaVersion: 1,
    organization: "Example Corp",
    limits: { providers: { allowedDrivers: [ProviderDriverKind.make("claudeAgent")] } },
  });
  return Effect.gen(function* () {
    const accounts = yield* MemberProviderAccounts.MemberProviderAccounts;
    const { instanceId } = yield* accounts.mutate(alice.id, {
      operation: "create",
      driver: "claudeAgent",
    });

    assert.equal(
      yield* reasonOf(
        accounts.mutate(bob.id, { operation: "update", instanceId, displayName: "Mine now" }),
      ),
      "forbidden",
    );
    assert.equal(
      yield* reasonOf(accounts.mutate(bob.id, { operation: "remove", instanceId })),
      "forbidden",
    );
    assert.equal(
      yield* reasonOf(accounts.mutate(bob.id, { operation: "create", driver: "codex" })),
      "policy-refused",
    );
    assert.equal(
      yield* reasonOf(
        accounts.mutate(bob.id, {
          operation: "update",
          instanceId: ProviderInstanceId.make("claudeAgent"),
          displayName: "Team login",
        }),
      ),
      "not-found",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("signs out and wipes an account before its owner's Remove deletes it", () => {
  const { layer, revoked, watched } = harness();
  return Effect.gen(function* () {
    const accounts = yield* MemberProviderAccounts.MemberProviderAccounts;
    const settings = yield* ServerSettings.ServerSettingsService;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const fs = yield* FileSystem.FileSystem;
    const { instanceId } = yield* accounts.mutate(bob.id, {
      operation: "create",
      driver: "claudeAgent",
      token: "sk-ant-oat01-remove-test",
    });
    const home = (yield* settings.getSettings).providerInstances[instanceId]!.config as {
      readonly homePath: string;
    };
    watched.home = home.homePath;

    yield* accounts.mutate(bob.id, { operation: "remove", instanceId });

    assert.deepEqual(revoked, [{ instanceId, homeExisted: true }]);
    assert.isFalse(yield* fs.exists(home.homePath));
    assert.isUndefined((yield* settings.getSettings).providerInstances[instanceId]);
    assert.isTrue(
      Option.isNone(yield* secrets.get(secretName(instanceId, "CLAUDE_CODE_OAUTH_TOKEN"))),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("retires a removed member's accounts and never wipes a home it did not allocate", () => {
  const { layer, revoked } = harness();
  return Effect.gen(function* () {
    const accounts = yield* MemberProviderAccounts.MemberProviderAccounts;
    const settings = yield* ServerSettings.ServerSettingsService;
    const teamState = yield* TeamState.TeamState;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const { instanceId } = yield* accounts.mutate(bob.id, {
      operation: "create",
      driver: "claudeAgent",
      token: "sk-ant-oat01-retire-test",
    });
    const allocated = path.join(config.stateDir, "providers", "claudeAgent", instanceId);
    // An admin pointed this one of Bob's at a home of its own; retirement must leave it alone.
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
    const assignedId = ProviderInstanceId.make("claude_assigned");
    yield* settings.updateProviderInstance({
      operation: "create",
      instanceId: assignedId,
      instance: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { homePath: outside },
        ownerMemberId: bob.id,
      },
    });

    yield* accounts.retireOrphans;
    assert.deepEqual(revoked, []);

    yield* Ref.update(teamState.members, (members) =>
      new Map(members).set(bob.id, { ...bob, removedAt: "2026-02-01T00:00:00.000Z" }),
    );
    yield* accounts.retireOrphans;

    assert.sameMembers(
      revoked.map((entry) => entry.instanceId),
      [instanceId, assignedId],
    );
    const retired = (yield* settings.getSettings).providerInstances;
    assert.include(retired[instanceId], {
      enabled: false,
      ownerMemberId: bob.id,
      displayName: "Bob's Claude",
    });
    assert.isUndefined(retired[instanceId]?.environment);
    assert.equal(retired[assignedId]?.enabled, false);
    assert.isFalse(yield* fs.exists(allocated));
    assert.isTrue(yield* fs.exists(outside));

    yield* accounts.retireOrphans;
    assert.lengthOf(revoked, 2);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("refuses accounts of one's own on a solo server", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const accounts = yield* MemberProviderAccounts.MemberProviderAccounts;
    const settings = yield* ServerSettings.ServerSettingsService;
    const teamState = yield* TeamState.TeamState;
    yield* Ref.update(teamState.members, (members) =>
      new Map(members).set(bob.id, { ...bob, removedAt: "2026-02-01T00:00:00.000Z" }),
    );
    assert.equal(
      yield* reasonOf(accounts.mutate(alice.id, { operation: "create", driver: "codex" })),
      "forbidden",
    );
    assert.deepEqual((yield* settings.getSettings).providerInstances, {});
  }).pipe(Effect.provide(layer));
});
