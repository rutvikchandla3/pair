import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { SandboxId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as RunnerGrants from "./RunnerGrants.ts";

const layer = RunnerGrants.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(NodeCrypto.layer),
);

const sandboxA = SandboxId.make("sbx_0000000000000000000a");
const sandboxB = SandboxId.make("sbx_0000000000000000000b");

const isAuthError = Schema.is(RunnerGrants.RunnerAuthError);

const refusal = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (isAuthError(error) ? error.reason : "not an auth error")),
  );

it.layer(layer)("RunnerGrants", (it) => {
  it.effect.each([
    {
      name: "consumes an enrollment once and refuses its reuse",
      run: Effect.gen(function* () {
        const grants = yield* RunnerGrants.RunnerGrants;
        const secret = yield* grants.mint(sandboxA, 1);
        const { grant, token } = yield* grants.enroll(secret);
        assert.deepStrictEqual(grant, { sandboxId: sandboxA, generation: 1 });
        assert.deepStrictEqual(yield* grants.authenticate(token), grant);
        assert.equal(yield* refusal(grants.enroll(secret)), "consumed");
        assert.equal(yield* refusal(grants.enroll(Redacted.make("never-minted"))), "unknown");
        assert.equal(yield* refusal(grants.authenticate(secret)), "unknown");
      }),
    },
    {
      name: "authorizes downloads with an unspent secret or a token without spending the secret",
      run: Effect.gen(function* () {
        const grants = yield* RunnerGrants.RunnerGrants;
        const secret = yield* grants.mint(sandboxA, 1);
        const grant = { sandboxId: sandboxA, generation: 1 };
        assert.deepStrictEqual(yield* grants.authorizeDownload(secret), grant);
        assert.deepStrictEqual(yield* grants.authorizeDownload(secret), grant);
        const { token } = yield* grants.enroll(secret);
        assert.equal(yield* refusal(grants.authorizeDownload(secret)), "unknown");
        assert.deepStrictEqual(yield* grants.authorizeDownload(token), grant);
        const expiring = yield* grants.mint(sandboxB, 1);
        yield* TestClock.adjust("15 minutes");
        assert.equal(yield* refusal(grants.authorizeDownload(expiring)), "unknown");
        yield* grants.revoke(sandboxA);
        assert.equal(yield* refusal(grants.authorizeDownload(token)), "unknown");
      }),
    },
    {
      name: "refuses an enrollment after fifteen minutes",
      run: Effect.gen(function* () {
        const grants = yield* RunnerGrants.RunnerGrants;
        const secret = yield* grants.mint(sandboxA, 1);
        yield* TestClock.adjust("15 minutes");
        assert.equal(yield* refusal(grants.enroll(secret)), "expired");
      }),
    },
    {
      name: "revokes generation 1's token when generation 2 is minted",
      run: Effect.gen(function* () {
        const grants = yield* RunnerGrants.RunnerGrants;
        const first = yield* grants.enroll(yield* grants.mint(sandboxA, 1));
        const other = yield* grants.enroll(yield* grants.mint(sandboxB, 1));
        const second = yield* grants.mint(sandboxA, 2);
        assert.equal(yield* refusal(grants.authenticate(first.token)), "revoked");
        // Another sandbox's boot is untouched.
        assert.deepStrictEqual(yield* grants.authenticate(other.token), {
          sandboxId: sandboxB,
          generation: 1,
        });
        assert.deepStrictEqual((yield* grants.enroll(second)).grant, {
          sandboxId: sandboxA,
          generation: 2,
        });
      }),
    },
    {
      name: "re-minting an unconsumed generation invalidates the old secret",
      run: Effect.gen(function* () {
        const grants = yield* RunnerGrants.RunnerGrants;
        const old = yield* grants.mint(sandboxA, 1);
        const fresh = yield* grants.mint(sandboxA, 1);
        assert.equal(yield* refusal(grants.enroll(old)), "unknown");
        const enrolled = yield* grants.enroll(fresh);
        // A replayed mint after enrollment keeps the boot's token.
        const replayed = yield* grants.mint(sandboxA, 1);
        assert.equal(yield* refusal(grants.enroll(replayed)), "unknown");
        assert.deepStrictEqual(yield* grants.authenticate(enrolled.token), enrolled.grant);
      }),
    },
    {
      name: "revoke refuses every generation's token and secret, and stores only hashes",
      run: Effect.gen(function* () {
        const grants = yield* RunnerGrants.RunnerGrants;
        const sql = yield* SqlClient.SqlClient;
        const pending = yield* grants.mint(sandboxA, 1);
        const enrolled = yield* grants.enroll(yield* grants.mint(sandboxB, 1));
        yield* grants.revoke(sandboxA);
        yield* grants.revoke(sandboxB);
        assert.equal(yield* refusal(grants.enroll(pending)), "revoked");
        assert.equal(yield* refusal(grants.authenticate(enrolled.token)), "revoked");
        const stored = JSON.stringify(yield* sql`SELECT * FROM sandbox_runner_grants`);
        assert.notInclude(stored, Redacted.value(enrolled.token));
        assert.notInclude(stored, Redacted.value(pending));
      }),
    },
  ])("$name", ({ run }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM sandbox_runner_grants`;
      yield* run;
    }),
  );
});
