import { NonNegativeInt, SandboxId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

const ENROLLMENT_TTL = Duration.minutes(15);
const SECRET_BYTES = 32;

export type RunnerGrantError = PersistenceSqlError | PersistenceDecodeError;

/** Why a runner credential was refused. The route answers 401 with no detail. */
export class RunnerAuthError extends Schema.TaggedError<RunnerAuthError>()("RunnerAuthError", {
  reason: Schema.Literals(["missing", "malformed", "unknown", "consumed", "expired", "revoked"]),
}) {}

/** The one sandbox boot a credential reaches. */
export interface RunnerGrant {
  readonly sandboxId: SandboxId;
  readonly generation: number;
}

const GrantRow = Schema.Struct({ sandboxId: SandboxId, generation: NonNegativeInt });

const RefusalRow = Schema.Struct({
  consumed: Schema.BooleanFromBit,
  revoked: Schema.BooleanFromBit,
});

/**
 * Enrollment secrets and sandbox tokens for runners (03 §6). Only SHA-256 hashes are stored, and
 * nothing here enters `SessionStore`, so no `/ws`, `/api` or `/mcp` path can accept one.
 */
export class RunnerGrants extends Context.Service<
  RunnerGrants,
  {
    /**
     * Revokes every older generation of the sandbox and stores a fresh one-use secret for this
     * one. A generation that already enrolled keeps its token, so a replayed mint is harmless.
     */
    readonly mint: (
      sandboxId: SandboxId,
      generation: number,
    ) => Effect.Effect<Redacted.Redacted<string>, RunnerGrantError>;
    /** Consumes the secret and returns the boot's new sandbox token, in one statement. */
    readonly enroll: (
      secret: Redacted.Redacted<string>,
    ) => Effect.Effect<
      { readonly grant: RunnerGrant; readonly token: Redacted.Redacted<string> },
      RunnerAuthError | RunnerGrantError
    >;
    readonly authenticate: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<RunnerGrant, RunnerAuthError | RunnerGrantError>;
    /**
     * For bundle downloads: a sandbox token, or an enrollment secret that is still unspent. It
     * never consumes the secret, so the runner can enroll with it after the download.
     */
    readonly authorizeDownload: (
      credential: Redacted.Redacted<string>,
    ) => Effect.Effect<RunnerGrant, RunnerAuthError | RunnerGrantError>;
    /** Revokes every generation of the sandbox. */
    readonly revoke: (sandboxId: SandboxId) => Effect.Effect<void, RunnerGrantError>;
  }
>()("t3/sandbox/runnerHub/RunnerGrants") {}

const toRepositoryError =
  (operation: string) =>
  (cause: unknown): RunnerGrantError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : new PersistenceSqlError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const digest = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;

  const hash = (secret: Redacted.Redacted<string>) =>
    digest.digestHex(Digest.sha256, new TextEncoder().encode(Redacted.value(secret)));
  const newSecret = random
    .randomBytes(SECRET_BYTES)
    .pipe(Effect.map((bytes) => Redacted.make(Buffer.from(bytes).toString("base64url"))));
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const revokeOlder = SqlSchema.void({
    Request: Schema.Struct({
      sandboxId: SandboxId,
      generation: NonNegativeInt,
      now: Schema.String,
    }),
    execute: ({ sandboxId, generation, now }) => sql`
      UPDATE sandbox_runner_grants
      SET revoked_at = ${now}
      WHERE sandbox_id = ${sandboxId}
        AND boot_generation < ${generation}
        AND revoked_at IS NULL
    `,
  });

  const upsertEnrollment = SqlSchema.void({
    Request: Schema.Struct({
      sandboxId: SandboxId,
      generation: NonNegativeInt,
      enrollmentHash: Schema.String,
      expiresAt: Schema.String,
      now: Schema.String,
    }),
    execute: ({ sandboxId, generation, enrollmentHash, expiresAt, now }) => sql`
      INSERT INTO sandbox_runner_grants (
        sandbox_id, boot_generation, enrollment_hash, enrollment_expires_at, created_at
      )
      VALUES (${sandboxId}, ${generation}, ${enrollmentHash}, ${expiresAt}, ${now})
      ON CONFLICT (sandbox_id, boot_generation) DO UPDATE SET
        enrollment_hash = excluded.enrollment_hash,
        enrollment_expires_at = excluded.enrollment_expires_at
      WHERE sandbox_runner_grants.enrollment_consumed_at IS NULL
    `,
  });

  const consumeEnrollment = SqlSchema.findOneOption({
    Request: Schema.Struct({
      enrollmentHash: Schema.String,
      tokenHash: Schema.String,
      now: Schema.String,
    }),
    Result: GrantRow,
    execute: ({ enrollmentHash, tokenHash, now }) => sql`
      UPDATE sandbox_runner_grants
      SET enrollment_consumed_at = ${now}, token_hash = ${tokenHash}
      WHERE enrollment_hash = ${enrollmentHash}
        AND enrollment_consumed_at IS NULL
        AND revoked_at IS NULL
        AND enrollment_expires_at > ${now}
      RETURNING sandbox_id AS "sandboxId", boot_generation AS "generation"
    `,
  });

  // Only explains a refusal; the consume above is the check.
  const enrollmentRefusal = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: RefusalRow,
    execute: (enrollmentHash) => sql`
      SELECT
        enrollment_consumed_at IS NOT NULL AS "consumed",
        revoked_at IS NOT NULL AS "revoked"
      FROM sandbox_runner_grants
      WHERE enrollment_hash = ${enrollmentHash}
    `,
  });

  const findByToken = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ ...GrantRow.fields, revoked: Schema.BooleanFromBit }),
    execute: (tokenHash) => sql`
      SELECT
        sandbox_id AS "sandboxId",
        boot_generation AS "generation",
        revoked_at IS NOT NULL AS "revoked"
      FROM sandbox_runner_grants
      WHERE token_hash = ${tokenHash}
    `,
  });

  const findDownloadGrant = SqlSchema.findOneOption({
    Request: Schema.Struct({ credentialHash: Schema.String, now: Schema.String }),
    Result: GrantRow,
    execute: ({ credentialHash, now }) => sql`
      SELECT sandbox_id AS "sandboxId", boot_generation AS "generation"
      FROM sandbox_runner_grants
      WHERE revoked_at IS NULL
        AND (
          token_hash = ${credentialHash}
          OR (
            enrollment_hash = ${credentialHash}
            AND enrollment_consumed_at IS NULL
            AND enrollment_expires_at > ${now}
          )
        )
      LIMIT 1
    `,
  });

  const revokeAll = SqlSchema.void({
    Request: Schema.Struct({ sandboxId: SandboxId, now: Schema.String }),
    execute: ({ sandboxId, now }) => sql`
      UPDATE sandbox_runner_grants
      SET revoked_at = ${now}
      WHERE sandbox_id = ${sandboxId} AND revoked_at IS NULL
    `,
  });

  const mint: RunnerGrants["Service"]["mint"] = Effect.fn("RunnerGrants.mint")(
    function* (sandboxId, generation) {
      const secret = yield* newSecret;
      const enrollmentHash = yield* hash(secret);
      const now = yield* DateTime.now;
      const request = {
        sandboxId,
        generation,
        enrollmentHash,
        expiresAt: DateTime.formatIso(DateTime.addDuration(now, ENROLLMENT_TTL)),
        now: DateTime.formatIso(now),
      };
      yield* sql
        .withTransaction(revokeOlder(request).pipe(Effect.andThen(upsertEnrollment(request))))
        .pipe(Effect.mapError(toRepositoryError("RunnerGrants.mint")));
      return secret;
    },
  );

  const enroll: RunnerGrants["Service"]["enroll"] = Effect.fn("RunnerGrants.enroll")(
    function* (secret) {
      const enrollmentHash = yield* hash(secret);
      const token = yield* newSecret;
      const tokenHash = yield* hash(token);
      const now = yield* nowIso;
      const consumed = yield* consumeEnrollment({ enrollmentHash, tokenHash, now }).pipe(
        Effect.mapError(toRepositoryError("RunnerGrants.enroll")),
      );
      if (Option.isSome(consumed)) return { grant: consumed.value, token };
      const refusal = yield* enrollmentRefusal(enrollmentHash).pipe(
        Effect.mapError(toRepositoryError("RunnerGrants.enroll:refusal")),
      );
      return yield* new RunnerAuthError({
        reason: Option.match(refusal, {
          onNone: () => "unknown" as const,
          onSome: (row) => (row.revoked ? "revoked" : row.consumed ? "consumed" : "expired"),
        }),
      });
    },
  );

  const authenticate: RunnerGrants["Service"]["authenticate"] = Effect.fn(
    "RunnerGrants.authenticate",
  )(function* (token) {
    const row = yield* findByToken(yield* hash(token)).pipe(
      Effect.mapError(toRepositoryError("RunnerGrants.authenticate")),
    );
    if (Option.isNone(row)) return yield* new RunnerAuthError({ reason: "unknown" });
    if (row.value.revoked) return yield* new RunnerAuthError({ reason: "revoked" });
    return { sandboxId: row.value.sandboxId, generation: row.value.generation };
  });

  const authorizeDownload: RunnerGrants["Service"]["authorizeDownload"] = Effect.fn(
    "RunnerGrants.authorizeDownload",
  )(function* (credential) {
    const row = yield* findDownloadGrant({
      credentialHash: yield* hash(credential),
      now: yield* nowIso,
    }).pipe(Effect.mapError(toRepositoryError("RunnerGrants.authorizeDownload")));
    if (Option.isNone(row)) return yield* new RunnerAuthError({ reason: "unknown" });
    return row.value;
  });

  const revoke: RunnerGrants["Service"]["revoke"] = Effect.fn("RunnerGrants.revoke")(
    function* (sandboxId) {
      yield* revokeAll({ sandboxId, now: yield* nowIso }).pipe(
        Effect.mapError(toRepositoryError("RunnerGrants.revoke")),
      );
    },
  );

  return RunnerGrants.of({ mint, enroll, authenticate, authorizeDownload, revoke });
});

export const layer = Layer.effect(RunnerGrants, make);
