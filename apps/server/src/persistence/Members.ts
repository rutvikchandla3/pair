import { IsoDateTime, MemberId, MemberRole, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  type MemberRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

export const MemberRecord = Schema.Struct({
  id: MemberId,
  name: TrimmedNonEmptyString,
  role: MemberRole,
  gitName: Schema.NullOr(TrimmedNonEmptyString),
  gitEmail: Schema.NullOr(TrimmedNonEmptyString),
  isOwner: Schema.BooleanFromBit,
  createdAt: IsoDateTime,
  updatedAt: Schema.NullOr(IsoDateTime),
  removedAt: Schema.NullOr(IsoDateTime),
});
export type MemberRecord = typeof MemberRecord.Type;

export const InsertMemberInput = Schema.Struct({
  id: MemberId,
  name: TrimmedNonEmptyString,
  role: MemberRole,
  gitName: Schema.NullOr(TrimmedNonEmptyString),
  gitEmail: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type InsertMemberInput = typeof InsertMemberInput.Type;

/** Absent fields keep their stored value; a `null` git field clears it. */
export const UpdateMemberInput = Schema.Struct({
  id: MemberId,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  gitName: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  gitEmail: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: IsoDateTime,
});
export type UpdateMemberInput = typeof UpdateMemberInput.Type;

export const SetMemberRoleInput = Schema.Struct({
  id: MemberId,
  role: MemberRole,
  updatedAt: IsoDateTime,
});
export type SetMemberRoleInput = typeof SetMemberRoleInput.Type;

export const MarkMemberRemovedInput = Schema.Struct({
  id: MemberId,
  removedAt: IsoDateTime,
});
export type MarkMemberRemovedInput = typeof MarkMemberRemovedInput.Type;

const MemberIdInput = Schema.Struct({ id: MemberId });

export class MemberRepository extends Context.Service<
  MemberRepository,
  {
    /** Every member, removed ones included, oldest first. */
    readonly list: () => Effect.Effect<ReadonlyArray<MemberRecord>, MemberRepositoryError>;
    readonly getById: (
      id: MemberId,
    ) => Effect.Effect<Option.Option<MemberRecord>, MemberRepositoryError>;
    readonly getOwner: () => Effect.Effect<MemberRecord, MemberRepositoryError>;
    readonly insert: (input: InsertMemberInput) => Effect.Effect<void, MemberRepositoryError>;
    readonly update: (
      input: UpdateMemberInput,
    ) => Effect.Effect<Option.Option<MemberRecord>, MemberRepositoryError>;
    /** Never changes the owner. */
    readonly setRole: (
      input: SetMemberRoleInput,
    ) => Effect.Effect<Option.Option<MemberRecord>, MemberRepositoryError>;
    /** Never removes the owner or a member already removed. */
    readonly markRemoved: (
      input: MarkMemberRemovedInput,
    ) => Effect.Effect<Option.Option<MemberRecord>, MemberRepositoryError>;
  }
>()("t3/persistence/Members/MemberRepository") {}

function toSqlOrDecodeError(operation: string) {
  return (cause: unknown): MemberRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(`${operation}:decode`, cause)
      : new PersistenceSqlError({ operation: `${operation}:query`, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql`
    id AS "id",
    name AS "name",
    role AS "role",
    git_name AS "gitName",
    git_email AS "gitEmail",
    is_owner AS "isOwner",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    removed_at AS "removedAt"
  `;

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: MemberRecord,
    execute: () => sql`SELECT ${columns} FROM members ORDER BY created_at, id`,
  });
  const getRowById = SqlSchema.findOneOption({
    Request: MemberIdInput,
    Result: MemberRecord,
    execute: ({ id }) => sql`SELECT ${columns} FROM members WHERE id = ${id}`,
  });
  const getOwnerRow = SqlSchema.findOne({
    Request: Schema.Void,
    Result: MemberRecord,
    execute: () => sql`SELECT ${columns} FROM members WHERE is_owner = 1`,
  });
  const insertRow = SqlSchema.void({
    Request: InsertMemberInput,
    execute: (input) => sql`
      INSERT INTO members (id, name, role, git_name, git_email, is_owner, created_at)
      VALUES (
        ${input.id}, ${input.name}, ${input.role}, ${input.gitName}, ${input.gitEmail}, 0,
        ${input.createdAt}
      )
    `,
  });
  const updateRow = SqlSchema.findOneOption({
    Request: UpdateMemberInput,
    Result: MemberRecord,
    execute: (input) => sql`
      UPDATE members
      SET name = COALESCE(${input.name ?? null}, name),
        git_name = CASE WHEN ${input.gitName === undefined ? 0 : 1} = 1
          THEN ${input.gitName ?? null} ELSE git_name END,
        git_email = CASE WHEN ${input.gitEmail === undefined ? 0 : 1} = 1
          THEN ${input.gitEmail ?? null} ELSE git_email END,
        updated_at = ${input.updatedAt}
      WHERE id = ${input.id}
      RETURNING ${columns}
    `,
  });
  const setRoleRow = SqlSchema.findOneOption({
    Request: SetMemberRoleInput,
    Result: MemberRecord,
    execute: (input) => sql`
      UPDATE members SET role = ${input.role}, updated_at = ${input.updatedAt}
      WHERE id = ${input.id} AND is_owner = 0
      RETURNING ${columns}
    `,
  });
  const markRemovedRow = SqlSchema.findOneOption({
    Request: MarkMemberRemovedInput,
    Result: MemberRecord,
    execute: (input) => sql`
      UPDATE members SET removed_at = ${input.removedAt}, updated_at = ${input.removedAt}
      WHERE id = ${input.id} AND is_owner = 0 AND removed_at IS NULL
      RETURNING ${columns}
    `,
  });

  return MemberRepository.of({
    list: Effect.fn("MemberRepository.list")(function () {
      return listRows(undefined).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toSqlOrDecodeError("MemberRepository.list")),
      );
    }),
    getById: Effect.fn("MemberRepository.getById")(function (id) {
      return getRowById({ id }).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toSqlOrDecodeError("MemberRepository.getById")),
      );
    }),
    // Migration 080 creates the owner, so a missing row is a corrupt database.
    getOwner: Effect.fn("MemberRepository.getOwner")(function () {
      return getOwnerRow(undefined).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toSqlOrDecodeError("MemberRepository.getOwner")),
      );
    }),
    insert: Effect.fn("MemberRepository.insert")(function (input) {
      return insertRow(input).pipe(Effect.mapError(toSqlOrDecodeError("MemberRepository.insert")));
    }),
    update: Effect.fn("MemberRepository.update")(function (input) {
      return updateRow(input).pipe(Effect.mapError(toSqlOrDecodeError("MemberRepository.update")));
    }),
    setRole: Effect.fn("MemberRepository.setRole")(function (input) {
      return setRoleRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("MemberRepository.setRole")),
      );
    }),
    markRemoved: Effect.fn("MemberRepository.markRemoved")(function (input) {
      return markRemovedRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("MemberRepository.markRemoved")),
      );
    }),
  });
});

export const layer = Layer.effect(MemberRepository, make);
