import {
  type AuthGrantScope,
  AuthStandardClientScopes,
  MemberRole,
  teamRoleScopes,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Flag } from "effect/cli";

import * as Members from "../persistence/Members.ts";

export class MemberLookupError extends Schema.TaggedError<MemberLookupError>()(
  "MemberLookupError",
  {
    identifier: Schema.String,
    reason: Schema.Literals(["not-found", "ambiguous", "removed"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return `No member matches '${this.identifier}'. Run \`t3 member list\` to see members.`;
      case "ambiguous":
        return `Several members are named '${this.identifier}'. Pass the member's id instead.`;
      case "removed":
        return `Member '${this.identifier}' was removed.`;
    }
  }
}

export class MemberScopeError extends Schema.TaggedError<MemberScopeError>()("MemberScopeError", {
  member: Schema.String,
  role: MemberRole,
  scopes: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `${this.member}'s role (${this.role}) does not grant ${this.scopes.join(", ")}.`;
  }
}

/** An exact id, or a case-insensitive name among members who were not removed. */
export const findMember = <
  M extends { readonly id: string; readonly name: string; readonly removedAt: string | null },
>(
  members: ReadonlyArray<M>,
  identifier: string,
): Effect.Effect<M, MemberLookupError> => {
  const trimmed = identifier.trim();
  const byId = members.find((member) => member.id === trimmed);
  if (byId !== undefined) return Effect.succeed(byId);
  const name = trimmed.toLowerCase();
  const named = members.filter(
    (member) => member.removedAt === null && member.name.toLowerCase() === name,
  );
  if (named.length === 1) return Effect.succeed(named[0]!);
  return Effect.fail(
    new MemberLookupError({
      identifier: trimmed,
      reason: named.length === 0 ? "not-found" : "ambiguous",
    }),
  );
};

export const memberFlag = Flag.String("member").pipe(
  Flag.withDescription(
    "Team member, by id or name, the credential signs in as. Defaults to the server's owner.",
  ),
  Flag.optional,
);

/** Without `--member` the credential is the owner's, as before teams existed. */
export const resolveMemberGrant = Effect.fn("cli.resolveMemberGrant")(function* (
  member: Option.Option<string>,
  requested: ReadonlyArray<AuthGrantScope>,
) {
  if (Option.isNone(member)) {
    return { scopes: requested.length > 0 ? requested : AuthStandardClientScopes };
  }
  const repository = yield* Members.MemberRepository;
  const record = yield* findMember(yield* repository.list(), member.value);
  if (record.removedAt !== null) {
    return yield* new MemberLookupError({ identifier: member.value, reason: "removed" });
  }
  const bundle = teamRoleScopes(record.role);
  const outside = requested.filter((scope) => !bundle.includes(scope));
  if (outside.length > 0) {
    return yield* new MemberScopeError({ member: record.name, role: record.role, scopes: outside });
  }
  return { memberId: record.id, scopes: requested.length > 0 ? requested : bundle };
});
